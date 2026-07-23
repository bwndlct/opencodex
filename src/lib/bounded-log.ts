import { appendFileSync, chmodSync, closeSync, ftruncateSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const CRASH_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const CRASH_LOG_BACKUP_COUNT = 2;

export interface CrashLogRetentionOptions {
  maxBytes?: number;
  backupCount?: number;
}

function crashBackupPath(path: string, index: number): string {
  return `${path}.${index}`;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function bestEffortChmod(path: string, mode: number): void {
  try { chmodSync(path, mode); } catch { /* unsupported on some filesystems */ }
}

function normalizeCrashFile(path: string, maxBytes: number): number {
  let size: number;
  try {
    const info = statSync(path);
    if (!info.isFile()) throw new Error(`managed crash log path is not a file: ${path}`);
    size = info.size;
  } catch (error) {
    if (isMissingFile(error)) return 0;
    throw error;
  }
  bestEffortChmod(path, 0o600);
  if (size <= maxBytes) return size;

  const fd = openSync(path, "r+");
  try {
    const tail = Buffer.allocUnsafe(maxBytes);
    let offset = 0;
    while (offset < maxBytes) {
      const bytesRead = readSync(fd, tail, offset, maxBytes - offset, size - maxBytes + offset);
      if (bytesRead === 0) throw new Error("crash log changed while it was being bounded");
      offset += bytesRead;
    }
    offset = 0;
    while (offset < tail.byteLength) {
      const bytesWritten = writeSync(fd, tail, offset, tail.byteLength - offset, offset);
      if (bytesWritten === 0) throw new Error("crash log write made no progress");
      offset += bytesWritten;
    }
    ftruncateSync(fd, maxBytes);
  } finally {
    closeSync(fd);
  }
  bestEffortChmod(path, 0o600);
  return maxBytes;
}

function boundedCrashEntry(entry: string, maxBytes: number): Buffer {
  const bytes = Buffer.from(entry);
  if (bytes.byteLength <= maxBytes) return bytes;
  const marker = Buffer.from("\n[crash entry truncated]\n");
  if (marker.byteLength >= maxBytes) return bytes.subarray(0, maxBytes);
  return Buffer.concat([bytes.subarray(0, maxBytes - marker.byteLength), marker]);
}

/** Synchronous by design: crash handlers must persist before returning to the runtime. */
export function appendCrashLogEntry(path: string, entry: string, options: CrashLogRetentionOptions = {}): void {
  const maxBytes = options.maxBytes ?? CRASH_LOG_MAX_BYTES;
  const backupCount = options.backupCount ?? CRASH_LOG_BACKUP_COUNT;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive integer");
  if (!Number.isSafeInteger(backupCount) || backupCount < 0) throw new Error("backupCount must be a non-negative integer");

  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  bestEffortChmod(directory, 0o700);
  let currentSize = normalizeCrashFile(path, maxBytes);
  for (let index = 1; index <= backupCount; index++) normalizeCrashFile(crashBackupPath(path, index), maxBytes);

  const bytes = boundedCrashEntry(entry, maxBytes);
  if (currentSize + bytes.byteLength > maxBytes) {
    if (backupCount === 0) {
      rmSync(path, { force: true });
    } else {
      rmSync(crashBackupPath(path, backupCount), { force: true });
      for (let index = backupCount - 1; index >= 1; index--) {
        try { renameSync(crashBackupPath(path, index), crashBackupPath(path, index + 1)); }
        catch (error) { if (!isMissingFile(error)) throw error; }
      }
      try { renameSync(path, crashBackupPath(path, 1)); }
      catch (error) { if (!isMissingFile(error)) throw error; }
      for (let index = 1; index <= backupCount; index++) bestEffortChmod(crashBackupPath(path, index), 0o600);
    }
    currentSize = 0;
  }

  appendFileSync(path, bytes, { mode: 0o600 });
  bestEffortChmod(path, 0o600);
  if (currentSize + bytes.byteLength > maxBytes) throw new Error("crash log exceeded its configured bound");
}
