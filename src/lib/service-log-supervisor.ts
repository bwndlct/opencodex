import { spawn } from "node:child_process";
import { open, chmod, mkdir, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config";
import { serviceApiTokenFilePath } from "./service-secrets";

export const SERVICE_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const SERVICE_LOG_BACKUP_COUNT = 4;

export interface RotatingServiceLogOptions {
  maxBytes?: number;
  backupCount?: number;
}

export interface RotatingServiceLogWriter {
  write(chunk: Uint8Array | string): Promise<void>;
  close(): Promise<void>;
}

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];

export interface ServiceSignalSource {
  on(signal: ForwardedSignal, listener: () => void): void;
  off(signal: ForwardedSignal, listener: () => void): void;
}

export interface ServiceLogSupervisorOptions {
  runtime?: string;
  cli?: string;
  logPath?: string;
  env?: NodeJS.ProcessEnv;
  signalSource?: ServiceSignalSource;
  createWriter?: (path: string) => Promise<RotatingServiceLogWriter>;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function bestEffortChmod(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    // Windows and some network filesystems do not implement POSIX modes.
  }
}

function backupPath(path: string, index: number): string {
  return `${path}.${index}`;
}

async function readFully(handle: FileHandle, target: Uint8Array, position: number): Promise<void> {
  let offset = 0;
  while (offset < target.byteLength) {
    const { bytesRead } = await handle.read(target, offset, target.byteLength - offset, position + offset);
    if (bytesRead === 0) throw new Error("service log changed while it was being bounded");
    offset += bytesRead;
  }
}

async function writeFully(handle: FileHandle, bytes: Uint8Array, position: number | null): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, position === null ? null : position + offset);
    if (bytesWritten === 0) throw new Error("service log write made no progress");
    offset += bytesWritten;
  }
}

/** Keep only the newest bytes from a legacy oversized managed file. */
async function boundManagedFile(path: string, maxBytes: number): Promise<number | null> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  if (!info.isFile()) throw new Error(`managed service log path is not a file: ${path}`);
  await bestEffortChmod(path, 0o600);
  if (info.size <= maxBytes) return info.size;

  const handle = await open(path, "r+");
  try {
    const tail = new Uint8Array(maxBytes);
    await readFully(handle, tail, info.size - maxBytes);
    await writeFully(handle, tail, 0);
    await handle.truncate(maxBytes);
  } finally {
    await handle.close();
  }
  await bestEffortChmod(path, 0o600);
  return maxBytes;
}

async function normalizeManagedFiles(path: string, maxBytes: number, backupCount: number): Promise<number> {
  const currentSize = await boundManagedFile(path, maxBytes);
  for (let index = 1; index <= backupCount; index++) {
    await boundManagedFile(backupPath(path, index), maxBytes);
  }
  return currentSize ?? 0;
}

export async function createRotatingServiceLogWriter(
  path: string,
  options: RotatingServiceLogOptions = {},
): Promise<RotatingServiceLogWriter> {
  const maxBytes = options.maxBytes ?? SERVICE_LOG_MAX_BYTES;
  const backupCount = options.backupCount ?? SERVICE_LOG_BACKUP_COUNT;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive integer");
  if (!Number.isSafeInteger(backupCount) || backupCount < 0) throw new Error("backupCount must be a non-negative integer");

  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await bestEffortChmod(directory, 0o700);
  let currentSize = await normalizeManagedFiles(path, maxBytes, backupCount);
  let handle = await open(path, "a", 0o600);
  await bestEffortChmod(path, 0o600);

  let acceptingWrites = true;
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const result = queue.then(operation);
    // Keep the serialization chain usable after a failed operation. The caller
    // still receives the original rejection through result.
    queue = result.catch(() => {});
    return result;
  };

  const reopen = async (): Promise<void> => {
    handle = await open(path, "a", 0o600);
    currentSize = 0;
    await bestEffortChmod(path, 0o600);
  };

  const rotate = async (): Promise<void> => {
    await handle.close();
    if (backupCount === 0) {
      await rm(path, { force: true });
      await reopen();
      return;
    }

    await rm(backupPath(path, backupCount), { force: true });
    for (let index = backupCount - 1; index >= 1; index--) {
      try {
        await rename(backupPath(path, index), backupPath(path, index + 1));
        await bestEffortChmod(backupPath(path, index + 1), 0o600);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    try {
      await rename(path, backupPath(path, 1));
      await bestEffortChmod(backupPath(path, 1), 0o600);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    await reopen();
  };

  const writeBytes = async (bytes: Uint8Array): Promise<void> => {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (currentSize >= maxBytes) await rotate();
      const length = Math.min(maxBytes - currentSize, bytes.byteLength - offset);
      const slice = bytes.subarray(offset, offset + length);
      await writeFully(handle, slice, null);
      currentSize += length;
      offset += length;
    }
  };

  return {
    write(chunk): Promise<void> {
      if (!acceptingWrites) return Promise.reject(new Error("service log writer is closed"));
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
      return enqueue(() => writeBytes(bytes));
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      acceptingWrites = false;
      closePromise = enqueue(async () => {
        if (closed) return;
        closed = true;
        await handle.close();
      });
      return closePromise;
    },
  };
}

function defaultSignalSource(): ServiceSignalSource {
  return {
    on(signal, listener): void { process.on(signal, listener); },
    off(signal, listener): void { process.off(signal, listener); },
  };
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const number = constants.signals[signal];
  return typeof number === "number" ? 128 + number : 1;
}

async function pumpStream(stream: NodeJS.ReadableStream | null, write: (chunk: Uint8Array | string) => Promise<void>): Promise<void> {
  if (!stream) return;
  for await (const chunk of stream) {
    if (typeof chunk === "string" || chunk instanceof Uint8Array) await write(chunk);
    else await write(String(chunk));
  }
}

interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnFailed: boolean;
}

/** The service manager owns this process; this process owns the real proxy child and its log. */
export async function runServiceLogSupervisor(options: ServiceLogSupervisorOptions = {}): Promise<number> {
  const runtime = options.runtime ?? process.execPath;
  const cli = options.cli ?? process.argv[1];
  if (!cli) throw new Error("service supervisor CLI entry is unavailable");

  const logPath = options.logPath ?? join(getConfigDir(), "service.log");
  const createWriter = options.createWriter ?? createRotatingServiceLogWriter;
  const writer = await createWriter(logPath).catch((): RotatingServiceLogWriter => ({
    async write(): Promise<void> {},
    async close(): Promise<void> {},
  }));
  const safeWrite = async (chunk: Uint8Array | string): Promise<void> => {
    try { await writer.write(chunk); } catch { /* logging must not stop the service child */ }
  };
  const environment = { ...(options.env ?? process.env) };
  environment.OCX_SERVICE = "1";
  if (!environment.OCX_API_TOKEN_FILE?.trim()) environment.OCX_API_TOKEN_FILE = serviceApiTokenFilePath();

  let child;
  try {
    child = spawn(runtime, [cli, "start"], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    await safeWrite(`[${new Date().toISOString()}] service child failed to spawn\n`);
    try { await writer.close(); } catch { /* best-effort */ }
    return 1;
  }

  const signalSource = options.signalSource ?? defaultSignalSource();
  const listeners = new Map<ForwardedSignal, () => void>();
  for (const signal of FORWARDED_SIGNALS) {
    const listener = (): void => {
      try { child.kill(signal); } catch { /* the child may already be gone */ }
    };
    listeners.set(signal, listener);
    signalSource.on(signal, listener);
  }

  const stdoutPump = pumpStream(child.stdout, safeWrite);
  const stderrPump = pumpStream(child.stderr, safeWrite);
  const outcome = new Promise<ChildOutcome>(resolve => {
    let settled = false;
    child.once("error", () => {
      if (settled) return;
      settled = true;
      resolve({ code: null, signal: null, spawnFailed: true });
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal, spawnFailed: false });
    });
  });

  try {
    await safeWrite(`[${new Date().toISOString()}] service child started\n`);
    const result = await outcome;
    await Promise.allSettled([stdoutPump, stderrPump]);
    if (result.spawnFailed) {
      await safeWrite(`[${new Date().toISOString()}] service child failed to spawn\n`);
      return 1;
    }
    const exitCode = result.code ?? signalExitCode(result.signal);
    await safeWrite(`[${new Date().toISOString()}] service child exited code=${exitCode}\n`);
    return exitCode;
  } finally {
    for (const [signal, listener] of listeners) signalSource.off(signal, listener);
    try { await writer.close(); } catch { /* best-effort */ }
  }
}
