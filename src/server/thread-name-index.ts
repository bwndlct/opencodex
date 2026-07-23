import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveCodexHomeDir } from "../codex/home";
import { sanitizeIdentityValue } from "./request-identity";

let threadNameCache: Map<string, string> | null = null;
let threadNameCachePath = "";
let threadNameCacheMtime = 0;

function threadNameIndexPath(): string {
  return join(resolveCodexHomeDir(), "session_index.jsonl");
}

export function threadNameFor(rootSessionId: string): string | undefined {
  const indexPath = threadNameIndexPath();
  let mtime = 0;
  try {
    mtime = statSync(indexPath).mtimeMs;
  } catch {
    return threadNameCachePath === indexPath ? threadNameCache?.get(rootSessionId) : undefined;
  }

  if (threadNameCache && threadNameCachePath === indexPath && threadNameCacheMtime === mtime) {
    return threadNameCache.get(rootSessionId);
  }

  const names = new Map<string, string>();
  try {
    const content = readFileSync(indexPath, "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry: unknown = JSON.parse(line);
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const record = entry as Record<string, unknown>;
        const id = sanitizeIdentityValue(record.id);
        const threadName = sanitizeIdentityValue(record.thread_name);
        if (id && threadName) names.set(id, threadName);
      } catch {
        // Ignore malformed index rows; one bad row should not hide other task names.
      }
    }
  } catch {
    // The index is optional and may be unreadable while Codex is updating it.
  }

  threadNameCache = names;
  threadNameCachePath = indexPath;
  threadNameCacheMtime = mtime;
  return names.get(rootSessionId);
}
