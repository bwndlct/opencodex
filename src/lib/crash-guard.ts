import { appendFileSync, chmodSync, closeSync, ftruncateSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config";
import { redactSecretString, redactUrlForLog } from "./redact";
import { sidecarBreadcrumb, activityBreadcrumb } from "./sidecar-tracker";

/**
 * Process-level safety net for the long-running proxy daemon.
 *
 * A single request can trigger an async error inside a Bun.serve streaming
 * handler (e.g. a ReadableStream `start(controller)` callback hitting an
 * unexpected upstream response shape). Without a handler, Bun's default
 * behaviour prints the raw error — shown as `(function (controller, error)
 * {"use strict"; ... TypeError: null is not an object` — and can tear down
 * the whole proxy, killing every other in-flight Codex session.
 *
 * We must NOT let one bad stream crash the daemon. These handlers:
 *   1. Append the full error + stack to `<configDir>/crash.log` so the exact
 *      fault (with the JSC `(evaluating 'x.y')` clause and file:line) is
 *      captured for a precise root-cause fix.
 *   2. Keep the process alive — the failed request is already isolated by
 *      Bun.serve; surviving is strictly better than terminating.
 */

let installed = false;

export const CRASH_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const CRASH_LOG_BACKUP_COUNT = 2;

export interface CrashLogRetentionOptions {
  maxBytes?: number;
  backupCount?: number;
}

function crashLogPath(): string {
  return join(getConfigDir(), "crash.log");
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

export function formatCrashEntry(kind: string, err: unknown, promise?: unknown): string {
  const ts = new Date().toISOString();
  const detail =
    err instanceof Error
      ? `${err.name}: ${redactDiagnosticText(err.message)}\n${redactDiagnosticText(err.stack ?? "(no stack)")}`
      : typeof err === "object"
        ? redactDiagnosticText(safeStringify(err))
        : redactDiagnosticText(String(err));
  return `\n[${ts}] ${kind}\n${detail}${diagnose(err)}${diagnosePromise(promise)}${breadcrumb()}\n`;
}

/**
 * Bun surfaces some request-time stream/abort errors with only native frames
 * (`at <anonymous> (native:1:11)`), so `err.stack` alone cannot locate the
 * fault. JSC still records the true throw site on hidden own properties
 * (`sourceURL` / `originalLine` / `originalColumn`) and `Bun.inspect` renders a
 * code snippet from them — capture both so the next occurrence is pinpointable.
 */
function diagnose(err: unknown): string {
  const lines: string[] = [];
  try {
    const ctor = (err as { constructor?: { name?: string } } | null)?.constructor?.name;
    if (ctor && ctor !== "Error" && ctor !== "Object") lines.push(`  ctor: ${ctor}`);
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      const cause = e.cause;
      if (cause !== undefined) {
        lines.push(`  cause: ${redactDiagnosticText(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause))}`);
      }
      if (e.code !== undefined) lines.push(`  code: ${redactDiagnosticText(String(e.code))}`);
      // JSC hidden throw-site fields survive even when the stack is native-only.
      const sourceURL = e.sourceURL;
      const line = e.line ?? e.originalLine;
      const column = e.column ?? e.originalColumn;
      if (typeof sourceURL === "string" && sourceURL) {
        lines.push(`  origin: ${redactUrlForLog(sourceURL)}${line !== undefined ? `:${String(line)}` : ""}${column !== undefined ? `:${String(column)}` : ""}`);
      }
    }
    const stack = err instanceof Error ? err.stack ?? "" : "";
    const hasUsableStack = /\((?!native:)[^)]*:\d+:\d+\)/.test(stack);
    if (!hasUsableStack) {
      const snippet = inspectErr(err);
      if (snippet) lines.push(`  inspect:\n${snippet.split("\n").map(l => `    ${l}`).join("\n")}`);
    }
  } catch {
    /* diagnosis must never throw */
  }
  return lines.length ? `\n${lines.join("\n")}` : "";
}

/**
 * Bun.inspect renders the JSC source snippet (with the offending line + caret)
 * for errors whose throw site is otherwise lost to native frames.
 */
function inspectErr(err: unknown): string {
  try {
    const bun = (globalThis as { Bun?: { inspect?: (v: unknown, o?: unknown) => string } }).Bun;
    if (!bun?.inspect) return "";
    return redactDiagnosticText(bun.inspect(err, { depth: 2 }).trim());
  } catch {
    return "";
  }
}

/**
 * Inspect the rejected promise itself. Bun sometimes attaches richer context to the promise object
 * than to the reason, and the rendered form helps distinguish a fetch/stream teardown from app code.
 */
function diagnosePromise(promise: unknown): string {
  if (promise === undefined) return "";
  try {
    const bun = (globalThis as { Bun?: { inspect?: (v: unknown, o?: unknown) => string } }).Bun;
    const rendered = bun?.inspect ? bun.inspect(promise, { depth: 1 }).trim() : String(promise);
    if (!rendered || rendered === "Promise { <rejected> }") return "";
    return `\n  promise: ${redactDiagnosticText(rendered.split("\n").join(" "))}`;
  } catch {
    return "";
  }
}

/**
 * Record whether a sidecar (web-search / vision) was in flight when the fault fired. A native-only
 * rejection coinciding with sidecar work is the prime suspect; this turns the correlation into a
 * logged fact instead of an inference.
 */
function breadcrumb(): string {
  try {
    const lines: string[] = [];
    const b = sidecarBreadcrumb();
    if (b.inFlight > 0 || b.lastLabel) {
      lines.push(`  sidecar: inFlight=${b.inFlight} last=${b.lastLabel || "-"} sinceMs=${b.sinceMs}`);
    }
    const a = activityBreadcrumb();
    if (a.note) lines.push(`  activity: ${a.note} sinceMs=${a.sinceMs}`);
    const fetches = recentFetches();
    if (fetches) lines.push(fetches);
    return lines.length ? `\n${lines.join("\n")}` : "";
  } catch {
    return "";
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

let benignSuppressed = 0;
let benignLastLoggedAt = 0;
const BENIGN_LOG_INTERVAL_MS = 5 * 60_000;

/**
 * Bun raises an off-path `unhandledRejection: TypeError: null is not an object` (native-only stack)
 * whenever a streaming `fetch(..., { signal })` response body is torn down by an abort before/while
 * we read it — turn supersede, client disconnect, upstream RST. The daemon is never at risk (the
 * failed request is already isolated), the throw has no JS source location, and call-site body
 * cancellation cannot fully close the runtime-internal window. Treat this exact shape as benign:
 * keep the process alive, drop the alarmist banner, and fold repeats into a rate-limited summary so
 * crash.log stays readable for genuinely novel faults.
 *
 * Second known shape (260712): `TypeError: Invalid state: ReadableStream is locked`
 * (code ERR_INVALID_STATE, native-only stack ending in onSinkClose*). When a client
 * disconnects mid-SSE on the tee()'d passthrough path (responses.ts Bun#32111
 * workaround), Bun's sink-close teardown tries to cancel the tee-locked source body
 * and rejects off-path. Request lifecycle is already settled at that point; same
 * benign handling applies.
 */
export function isBenignAbortTeardown(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const bareNullTeardown = err.message === "null is not an object"; // bare form only (no `(evaluating …)`)
  const lockedStreamTeardown = err.message === "Invalid state: ReadableStream is locked"
    && (err as { code?: unknown }).code === "ERR_INVALID_STATE";
  if (!bareNullTeardown && !lockedStreamTeardown) return false;
  const stack = err.stack ?? "";
  // Native-only: no JS source frame. A real app TypeError would carry a `(file:line:col)` frame.
  return !/\((?!native:)[^)]*:\d+:\d+\)/.test(stack);
}

function record(kind: string, err: unknown, promise?: unknown): void {
  if (kind === "unhandledRejection" && isBenignAbortTeardown(err)) {
    benignSuppressed++;
    const now = Date.now();
    if (now - benignLastLoggedAt < BENIGN_LOG_INTERVAL_MS) return; // fold repeats silently
    benignLastLoggedAt = now;
    const summary = `\n[${new Date(now).toISOString()}] benign-abort-teardown x${benignSuppressed}`
      + ` (Bun fetch-body abort; proxy unaffected)${diagnose(err)}${diagnosePromise(promise)}${breadcrumb()}\n`;
    benignSuppressed = 0;
    try { appendCrashLogEntry(crashLogPath(), summary); } catch { /* logging must never throw */ }
    return; // no stderr banner — this is expected noise, not a crash
  }
  const line = formatCrashEntry(kind, err, promise);
  // Always surface to stderr so foreground `ocx start` users still see it,
  // then persist for later diagnosis.
  console.error(`⚠️  ${kind} (proxy stayed up; logged to crash.log)`);
  console.error(line.trimStart());
  try {
    appendCrashLogEntry(crashLogPath(), line);
  } catch {
    /* logging must never throw */
  }
}

interface FetchTrace { url: string; at: number; origin: string; settled: boolean; rejected?: string }
const FETCH_RING_MAX = 12;
const fetchRing: FetchTrace[] = [];
let fetchInstrumented = false;

/**
 * The recurring native-only rejection carries no source location, and every JS `await fetch(...)`
 * is already try/caught — so the offending promise is created INSIDE Bun's fetch and rejects off the
 * awaited path. Wrap global fetch to record each call's origin (a JS stack captured at call time) and
 * whether it later rejected. crash-guard then dumps the still-pending / recently-rejected fetches so
 * the next fault names the exact call site Bun lost.
 */
function instrumentFetch(): void {
  if (fetchInstrumented) return;
  const g = globalThis as { fetch?: typeof fetch };
  const original = g.fetch;
  if (typeof original !== "function") return;
  fetchInstrumented = true;
  g.fetch = function instrumentedFetch(this: unknown, ...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
    let url = "";
    try {
      const input = args[0];
      url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request)?.url ?? "";
    } catch { /* best-effort */ }
    const origin = (new Error().stack ?? "").split("\n").slice(2, 5).map(l => l.trim()).join(" <- ");
    const trace: FetchTrace = { url: redactUrlForLog(url), at: Date.now(), origin, settled: false };
    fetchRing.push(trace);
    if (fetchRing.length > FETCH_RING_MAX) fetchRing.shift();
    let p: ReturnType<typeof fetch>;
    try {
      p = original.apply(this, args);
    } catch (e) {
      trace.settled = true;
      trace.rejected = redactDiagnosticText(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      throw e;
    }
    return p.then(
      r => { trace.settled = true; return r; },
      e => { trace.settled = true; trace.rejected = redactDiagnosticText(e instanceof Error ? `${e.name}: ${e.message}` : String(e)); throw e; },
    );
  } as typeof fetch;
}

/** Render the recent fetch ring (pending first) for the crash breadcrumb. */
function recentFetches(): string {
  try {
    if (fetchRing.length === 0) return "";
    const now = Date.now();
    const rows = fetchRing.slice(-6).map(f => {
      const state = !f.settled ? "PENDING" : f.rejected ? `REJECTED(${f.rejected})` : "ok";
      return `    [${state}] ${f.url} ageMs=${now - f.at}${!f.settled ? ` origin=${f.origin}` : ""}`;
    });
    return `  fetches:\n${rows.join("\n")}`;
  } catch {
    return "";
  }
}

function redactDiagnosticText(value: string): string {
  return redactSecretString(value);
}

/**
 * Register global handlers that keep the proxy alive and capture full stacks.
 * Idempotent: safe to call more than once.
 */
export function installCrashGuards(): void {
  if (installed) return;
  installed = true;
  instrumentFetch();

  process.on("unhandledRejection", (reason, promise) => {
    record("unhandledRejection", reason, promise);
  });

  process.on("uncaughtException", err => {
    record("uncaughtException", err);
  });
}
