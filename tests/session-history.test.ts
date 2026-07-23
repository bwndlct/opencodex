import { describe, expect, test } from "bun:test";
import type { PersistedUsageEntry } from "../src/usage/log";
import {
  aggregateSessionHistory,
  buildSessionLogs,
  deriveRequestedProvider,
  parseSessionHistoryLimit,
  parseSessionLogLimit,
  projectSessionLog,
  validateSessionId,
  SESSION_HISTORY_DEFAULT_LIMIT,
  SESSION_HISTORY_MAX_LIMIT,
  SESSION_LOG_DEFAULT_LIMIT,
  SESSION_LOG_MAX_LIMIT,
} from "../src/server/session-history";

function makeEntry(overrides: Partial<PersistedUsageEntry>): PersistedUsageEntry {
  return {
    requestId: "req-1",
    timestamp: 1000,
    provider: "openai",
    model: "gpt-5",
    status: 200,
    durationMs: 50,
    usageStatus: "reported",
    usage: { inputTokens: 100, outputTokens: 50 },
    totalTokens: 150,
    ...overrides,
  };
}

describe("deriveRequestedProvider", () => {
  test("extracts provider prefix before first slash", () => {
    expect(deriveRequestedProvider("anthropic/claude-3.5-sonnet")).toBe("anthropic");
    expect(deriveRequestedProvider("openai/gpt-5")).toBe("openai");
  });

  test("returns undefined when no provider prefix", () => {
    expect(deriveRequestedProvider("gpt-5")).toBeUndefined();
    expect(deriveRequestedProvider(undefined)).toBeUndefined();
  });

  test("returns undefined when slash is at position 0", () => {
    expect(deriveRequestedProvider("/foo")).toBeUndefined();
  });
});

describe("parseSessionHistoryLimit", () => {
  test("returns default for null", () => {
    expect(parseSessionHistoryLimit(null)).toBe(SESSION_HISTORY_DEFAULT_LIMIT);
  });

  test("returns default for non-integer", () => {
    expect(parseSessionHistoryLimit("abc")).toBe(SESSION_HISTORY_DEFAULT_LIMIT);
    expect(parseSessionHistoryLimit("1.5")).toBe(SESSION_HISTORY_DEFAULT_LIMIT);
  });

  test("returns default for values below 1", () => {
    expect(parseSessionHistoryLimit("0")).toBe(SESSION_HISTORY_DEFAULT_LIMIT);
    expect(parseSessionHistoryLimit("-5")).toBe(SESSION_HISTORY_DEFAULT_LIMIT);
  });

  test("clamps to max", () => {
    expect(parseSessionHistoryLimit("9999")).toBe(SESSION_HISTORY_MAX_LIMIT);
  });

  test("passes through valid values within range", () => {
    expect(parseSessionHistoryLimit("1")).toBe(1);
    expect(parseSessionHistoryLimit("50")).toBe(50);
  });
});

describe("parseSessionLogLimit", () => {
  test("returns default for null", () => {
    expect(parseSessionLogLimit(null)).toBe(SESSION_LOG_DEFAULT_LIMIT);
  });

  test("returns default for non-integer", () => {
    expect(parseSessionLogLimit("xyz")).toBe(SESSION_LOG_DEFAULT_LIMIT);
  });

  test("clamps to max", () => {
    expect(parseSessionLogLimit("999")).toBe(SESSION_LOG_MAX_LIMIT);
  });

  test("passes through valid values within range", () => {
    expect(parseSessionLogLimit("10")).toBe(10);
  });
});

describe("validateSessionId", () => {
  test("accepts a valid alphanumeric id", () => {
    expect(validateSessionId("abc-123-def")).toBe("abc-123-def");
  });

  test("trims whitespace", () => {
    expect(validateSessionId("  abc123  ")).toBe("abc123");
  });

  test("rejects empty string", () => {
    expect(validateSessionId("")).toBeUndefined();
    expect(validateSessionId("   ")).toBeUndefined();
  });

  test("rejects path traversal", () => {
    expect(validateSessionId("../etc/passwd")).toBeUndefined();
    expect(validateSessionId("..")).toBeUndefined();
  });

  test("rejects forward slashes", () => {
    expect(validateSessionId("foo/bar")).toBeUndefined();
  });

  test("rejects null bytes", () => {
    expect(validateSessionId("abc\0def")).toBeUndefined();
  });
});

describe("aggregateSessionHistory", () => {
  const now = 50000;

  test("groups entries by rootSessionId, newest session first", () => {
    const entries = [
      makeEntry({ requestId: "r1", rootSessionId: "sess-old", timestamp: 1000 }),
      makeEntry({ requestId: "r2", rootSessionId: "sess-new", timestamp: 3000 }),
      makeEntry({ requestId: "r3", rootSessionId: "sess-old", timestamp: 2000 }),
    ];
    const result = aggregateSessionHistory(entries, now);
    expect(result.sessions.map(s => s.rootSessionId)).toEqual(["sess-new", "sess-old"]);
    expect(result.sessions[0].lastSeenAt).toBe(3000);
    expect(result.sessions[1].lastSeenAt).toBe(2000);
  });

  test("skips entries without rootSessionId", () => {
    const entries = [
      makeEntry({ requestId: "r1", rootSessionId: "sess-a", timestamp: 1000 }),
      makeEntry({ requestId: "r2", timestamp: 2000 }),
      makeEntry({ requestId: "r3", rootSessionId: undefined, timestamp: 3000 }),
    ];
    const result = aggregateSessionHistory(entries, now);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].rootSessionId).toBe("sess-a");
  });

  test("skips invalid rootSessionId values", () => {
    const entries = [
      makeEntry({ requestId: "r1", rootSessionId: "valid", timestamp: 1000 }),
      makeEntry({ requestId: "r2", rootSessionId: "bad\u0000id", timestamp: 2000 }),
      makeEntry({ requestId: "r3", rootSessionId: "x".repeat(257), timestamp: 3000 }),
    ];
    expect(aggregateSessionHistory(entries, now).sessions.map(session => session.rootSessionId)).toEqual(["valid"]);
  });

  test("counts requests per session", () => {
    const entries = [
      makeEntry({ requestId: "r1", rootSessionId: "sess-a", timestamp: 1000 }),
      makeEntry({ requestId: "r2", rootSessionId: "sess-a", timestamp: 2000 }),
      makeEntry({ requestId: "r3", rootSessionId: "sess-a", timestamp: 3000 }),
    ];
    const result = aggregateSessionHistory(entries, now);
    expect(result.sessions[0].requestCount).toBe(3);
  });

  test("sums totalTokens with usageDisplayTotalTokens semantics", () => {
    const entries = [
      makeEntry({
        requestId: "r1", rootSessionId: "sess-a", timestamp: 1000,
        usage: { inputTokens: 100, outputTokens: 50 },
        totalTokens: 200, // higher than input+output, so Math.max keeps 200
      }),
      makeEntry({
        requestId: "r2", rootSessionId: "sess-a", timestamp: 2000,
        usage: { inputTokens: 10, outputTokens: 5 },
        totalTokens: undefined, // no stored total, so input+output = 15
      }),
    ];
    const result = aggregateSessionHistory(entries, now);
    expect(result.sessions[0].totalTokens).toBe(215);
  });

  test("omits totalTokens when no measured request exists", () => {
    const entries = [
      makeEntry({ requestId: "r1", rootSessionId: "sess-a", timestamp: 1000, usageStatus: "unreported", usage: undefined, totalTokens: undefined }),
    ];
    const result = aggregateSessionHistory(entries, now);
    expect(result.sessions[0].totalTokens).toBeUndefined();
    expect(result.sessions[0].measuredRequests).toBe(0);
    expect(result.sessions[0].unmeteredRequests).toBe(1);
  });

  test("counts measured vs unmetered requests", () => {
    const entries = [
      makeEntry({ requestId: "r1", rootSessionId: "sess-a", timestamp: 1000, usageStatus: "reported" }),
      makeEntry({ requestId: "r2", rootSessionId: "sess-a", timestamp: 2000, usageStatus: "estimated" }),
      makeEntry({ requestId: "r3", rootSessionId: "sess-a", timestamp: 3000, usageStatus: "unreported", usage: undefined, totalTokens: undefined }),
      makeEntry({ requestId: "r4", rootSessionId: "sess-a", timestamp: 4000, usageStatus: "unsupported", usage: undefined, totalTokens: undefined }),
    ];
    const result = aggregateSessionHistory(entries, now);
    const s = result.sessions[0];
    expect(s.measuredRequests).toBe(2);
    expect(s.estimatedRequests).toBe(1);
    expect(s.unmeteredRequests).toBe(2);
  });

  test("projects latest identity/model fields from the newest entry", () => {
    const entries = [
      makeEntry({
        requestId: "r1", rootSessionId: "sess-a", timestamp: 1000,
        provider: "openai", model: "gpt-4", resolvedModel: "gpt-4-turbo",
        requestedModel: "openai/gpt-5", requestedEffort: "high",
        executionSessionId: "exec-1",
      }),
      makeEntry({
        requestId: "r2", rootSessionId: "sess-a", timestamp: 5000,
        provider: "anthropic", model: "claude-3", resolvedModel: "claude-3.5-sonnet",
        requestedModel: "anthropic/claude-3.5-sonnet", requestedEffort: "max",
        executionSessionId: "exec-2",
      }),
    ];
    const result = aggregateSessionHistory(entries, now);
    const s = result.sessions[0];
    expect(s.effectiveProvider).toBe("anthropic");
    expect(s.effectiveModel).toBe("claude-3.5-sonnet");
    expect(s.requestedModel).toBe("anthropic/claude-3.5-sonnet");
    expect(s.requestedEffort).toBe("max");
    expect(s.requestedProvider).toBe("anthropic");
    expect(s.executionSessionId).toBe("exec-2");
  });

  test("effectiveModel falls back to model when resolvedModel absent", () => {
    const entries = [
      makeEntry({ requestId: "r1", rootSessionId: "sess-a", timestamp: 1000, resolvedModel: undefined }),
    ];
    const result = aggregateSessionHistory(entries, now);
    expect(result.sessions[0].effectiveModel).toBe("gpt-5");
  });

  test("requestedProvider omitted when requestedModel has no prefix", () => {
    const entries = [
      makeEntry({ requestId: "r1", rootSessionId: "sess-a", timestamp: 1000, requestedModel: "gpt-5" }),
    ];
    const result = aggregateSessionHistory(entries, now);
    expect(result.sessions[0].requestedProvider).toBeUndefined();
  });

  test("respects limit parameter", () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ requestId: `r${i}`, rootSessionId: `sess-${i}`, timestamp: 1000 + i }),
    );
    const result = aggregateSessionHistory(entries, now, 3);
    expect(result.sessions).toHaveLength(3);
    // newest first
    expect(result.sessions[0].rootSessionId).toBe("sess-4");
  });

  test("returns empty sessions for empty input", () => {
    const result = aggregateSessionHistory([], now);
    expect(result.sessions).toEqual([]);
    expect(result.generatedAt).toBe(now);
    expect(result.retentionDays).toBe(30);
  });
});

describe("projectSessionLog", () => {
  test("projects core fields", () => {
    const entry = makeEntry({
      requestId: "r1", rootSessionId: "sess-a", timestamp: 1000,
      provider: "openai", model: "gpt-5", resolvedModel: "gpt-5-mini",
      status: 200, durationMs: 42,
      usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 5 },
      totalTokens: 15,
    });
    const log = projectSessionLog(entry);
    expect(log.requestId).toBe("r1");
    expect(log.timestamp).toBe(1000);
    expect(log.provider).toBe("openai");
    expect(log.model).toBe("gpt-5");
    expect(log.resolvedModel).toBe("gpt-5-mini");
    expect(log.status).toBe(200);
    expect(log.durationMs).toBe(42);
    expect(log.usageStatus).toBe("reported");
    expect(log.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(log.totalTokens).toBe(15);
  });

  test("includes optional identity and failure fields when present", () => {
    const entry = makeEntry({
      requestId: "r1", rootSessionId: "sess-a", timestamp: 1000,
      executionSessionId: "exec-1", requestKind: "codex", subagentKind: "thread_spawn",
      isSpawnedChild: true, requestedModel: "openai/gpt-5", requestedEffort: "high",
      status: 500, errorCode: "upstream_error", terminalStatus: "failed",
      closeReason: "body_stall",
    });
    const log = projectSessionLog(entry);
    expect(log.executionSessionId).toBe("exec-1");
    expect(log.requestKind).toBe("codex");
    expect(log.subagentKind).toBe("thread_spawn");
    expect(log.isSpawnedChild).toBe(true);
    expect(log.requestedModel).toBe("openai/gpt-5");
    expect(log.requestedEffort).toBe("high");
    expect(log.errorCode).toBe("upstream_error");
    expect(log.terminalStatus).toBe("failed");
    expect(log.closeReason).toBe("body_stall");
  });

  test("omits optional fields when absent", () => {
    const entry = makeEntry({ requestId: "r1", timestamp: 1000 });
    const log = projectSessionLog(entry);
    expect(log.resolvedModel).toBeUndefined();
    expect(log.errorCode).toBeUndefined();
    expect(log.executionSessionId).toBeUndefined();
  });
});

describe("buildSessionLogs", () => {
  test("filters by exact rootSessionId, newest first", () => {
    const entries = [
      makeEntry({ requestId: "r1", rootSessionId: "sess-a", timestamp: 1000 }),
      makeEntry({ requestId: "r2", rootSessionId: "sess-b", timestamp: 2000 }),
      makeEntry({ requestId: "r3", rootSessionId: "sess-a", timestamp: 3000 }),
    ];
    const logs = buildSessionLogs(entries, "sess-a");
    expect(logs.map(l => l.requestId)).toEqual(["r3", "r1"]);
  });

  test("does not match prefix of rootSessionId", () => {
    const entries = [
      makeEntry({ requestId: "r1", rootSessionId: "sess-abc", timestamp: 1000 }),
      makeEntry({ requestId: "r2", rootSessionId: "sess-ab", timestamp: 2000 }),
    ];
    const logs = buildSessionLogs(entries, "sess-ab");
    expect(logs).toHaveLength(1);
    expect(logs[0].requestId).toBe("r2");
  });

  test("matches the normalized identity exposed by session history", () => {
    const entries = [makeEntry({ requestId: "r1", rootSessionId: "  sess-a  ", timestamp: 1000 })];
    expect(buildSessionLogs(entries, "sess-a").map(log => log.requestId)).toEqual(["r1"]);
  });

  test("respects limit", () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ requestId: `r${i}`, rootSessionId: "sess-a", timestamp: 1000 + i }),
    );
    const logs = buildSessionLogs(entries, "sess-a", 2);
    expect(logs).toHaveLength(2);
    expect(logs[0].requestId).toBe("r4");
  });

  test("returns empty for no matching entries", () => {
    const entries = [makeEntry({ requestId: "r1", rootSessionId: "sess-a", timestamp: 1000 })];
    const logs = buildSessionLogs(entries, "sess-other");
    expect(logs).toEqual([]);
  });
});
