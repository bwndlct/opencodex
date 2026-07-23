import {
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import type { PersistedUsageEntry } from "./log";

export type UsageLogNow = Date | number;

export const USAGE_RETENTION_DAYS = 30;

const USAGE_SHARD_NAME = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const lastPrunedUsageDay = new Map<string, string>();

export function usageDirPath(): string {
  return join(getConfigDir(), "usage");
}

export function legacyUsageLogPath(): string {
  return join(getConfigDir(), "usage.jsonl");
}

function normalizedUsageDate(now: UsageLogNow): Date {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export function localDateKey(now: UsageLogNow): string {
  const date = normalizedUsageDate(now);
  return [
    date.getFullYear().toString().padStart(4, "0"),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getDate().toString().padStart(2, "0"),
  ].join("-");
}

export function localDateBefore(now: UsageLogNow, days: number): string {
  const date = normalizedUsageDate(now);
  date.setDate(date.getDate() - days);
  return localDateKey(date);
}

export function recognizedShardDate(fileName: string): string | undefined {
  const match = USAGE_SHARD_NAME.exec(fileName);
  if (!match) return undefined;
  const date = new Date(
    Number(match[1].slice(0, 4)),
    Number(match[1].slice(5, 7)) - 1,
    Number(match[1].slice(8, 10)),
  );
  if (date.getFullYear() !== Number(match[1].slice(0, 4))
    || date.getMonth() !== Number(match[1].slice(5, 7)) - 1
    || date.getDate() !== Number(match[1].slice(8, 10))) {
    return undefined;
  }
  return match[1];
}

export function usageLogPath(now: UsageLogNow = Date.now()): string {
  return join(usageDirPath(), `${localDateKey(now)}.jsonl`);
}

export function pruneUsageShards(now: UsageLogNow): void {
  const dir = usageDirPath();
  if (!existsSync(dir)) return;
  const localDate = localDateKey(now);
  if (lastPrunedUsageDay.get(dir) === localDate) return;
  lastPrunedUsageDay.set(dir, localDate);

  const cutoff = localDateBefore(now, USAGE_RETENTION_DAYS);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const shardDate = recognizedShardDate(entry.name);
    if (!shardDate || shardDate >= cutoff) continue;
    try { unlinkSync(join(dir, entry.name)); } catch { /* best-effort retention */ }
  }
}

/**
 * Read and parse JSONL lines from a usage log file, pushing normalized entries
 * into the supplied array. The normalizer is injected by the caller (usage/log.ts)
 * to avoid a circular runtime dependency.
 */
export function readUsageFile(
  path: string,
  entries: PersistedUsageEntry[],
  normalize: (entry: PersistedUsageEntry) => PersistedUsageEntry,
): void {
  const lines = readFileSync(path, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as PersistedUsageEntry;
      if (parsed && typeof parsed === "object" && typeof parsed.requestId === "string") {
        entries.push(normalize(parsed));
      }
    } catch {
      /* keep reading after a partially written or hand-edited line */
    }
  }
}
