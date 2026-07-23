/**
 * Test goal: verify the session workspace parsers validate API contracts, normalize identity,
 * retain only safe fields, and keep active/recent session datasets independent.
 */
import { describe, expect, test } from "bun:test";
import {
  parseActiveSessionSnapshot,
  parseSessionHistory,
  parseSessionLogs,
  parseRecentSessions,
  sessionLogTokenTotal,
} from "../gui/src/session-workspace-data";

describe("session workspace data", () => {
  test("parses the active-session snapshot contract", () => {
    expect(parseActiveSessionSnapshot({
      generatedAt: 100,
      activeRequests: 2,
      unattributedActiveRequests: 1,
      sessions: [{
        rootSessionId: " root-session ",
        activeRequests: 2,
        activeSourceCounts: { gpt: 1, glm: 1, other: 0 },
        executionSessionIds: ["child", "root", "child"],
        oldestStartedAt: 80,
        routePolicy: "personal_first",
        requestedProvider: "requested-provider",
        requestedModel: "requested-provider/model",
        effectiveProvider: "effective-provider",
        effectiveModel: "effective-model",
        effectiveUpstream: "codex_pool",
        fallbackReason: "all_personal_accounts_unavailable",
        prompt: "private prompt",
        usage: { inputTokens: 10 },
        accountId: "private-account",
      }],
    })).toEqual({
      generatedAt: 100,
      activeRequests: 2,
      unattributedActiveRequests: 1,
      sessions: [{
        rootSessionId: "root-session",
        activeRequests: 2,
        activeSourceCounts: { gpt: 1, glm: 1, other: 0 },
        executionSessionIds: ["child", "root"],
        oldestStartedAt: 80,
        routePolicy: "personal_first",
        requestedProvider: "requested-provider",
        requestedModel: "requested-provider/model",
        effectiveProvider: "effective-provider",
        effectiveModel: "effective-model",
        effectiveUpstream: "codex_pool",
        fallbackReason: "all_personal_accounts_unavailable",
      }],
    });
  });

  test("parses company-first route telemetry values", () => {
    expect(parseActiveSessionSnapshot({
      generatedAt: 200,
      activeRequests: 1,
      unattributedActiveRequests: 0,
      sessions: [{
        rootSessionId: "company-root",
        activeRequests: 1,
        executionSessionIds: ["company-execution"],
        oldestStartedAt: 180,
        routePolicy: "company_first",
        effectiveUpstream: "company",
        fallbackReason: "company_upstream_unavailable",
      }],
    })).toEqual({
      generatedAt: 200,
      activeRequests: 1,
      unattributedActiveRequests: 0,
      sessions: [{
        rootSessionId: "company-root",
        activeRequests: 1,
        executionSessionIds: ["company-execution"],
        oldestStartedAt: 180,
        routePolicy: "company_first",
        effectiveUpstream: "company",
        fallbackReason: "company_upstream_unavailable",
      }],
    });
  });

  test("rejects malformed active snapshot top-level and required rows", () => {
    expect(() => parseActiveSessionSnapshot(null)).toThrow(Error);
    expect(() => parseActiveSessionSnapshot({
      generatedAt: 1,
      activeRequests: 0,
      unattributedActiveRequests: 0,
      sessions: "not-an-array",
    })).toThrow(Error);
    expect(() => parseActiveSessionSnapshot({
      generatedAt: 1,
      activeRequests: 0,
      unattributedActiveRequests: 0,
      sessions: [{
        rootSessionId: "root",
        activeRequests: -1,
        executionSessionIds: [],
        oldestStartedAt: 1,
      }],
    })).toThrow(Error);
  });

  test("drops invalid optional values while preserving valid required data", () => {
    expect(parseActiveSessionSnapshot({
      generatedAt: 1,
      activeRequests: 1,
      unattributedActiveRequests: 0,
      sessions: [{
        rootSessionId: "root",
        activeRequests: 1,
        executionSessionIds: ["z", "bad\u0000id", "a", "z", "x".repeat(257), 42],
        oldestStartedAt: 1,
        routePolicy: "unknown",
        requestedProvider: "\u0000private",
        requestedModel: 42,
        effectiveProvider: "",
        effectiveModel: "x".repeat(257),
        effectiveUpstream: "unknown",
        fallbackReason: "unknown",
      }],
    })).toEqual({
      generatedAt: 1,
      activeRequests: 1,
      unattributedActiveRequests: 0,
      sessions: [{
        rootSessionId: "root",
        activeRequests: 1,
        executionSessionIds: ["a", "z"],
        oldestStartedAt: 1,
      }],
    });
  });

  test("keeps recent sessions separate, chooses latest rows, sorts, limits, and redacts unknown fields", () => {
    const logs = [
      {
        rootSessionId: "root-old",
        timestamp: 10,
        executionSessionId: "old-execution",
        requestedModel: "old-provider/old-model",
        provider: "old-provider",
        model: "old-wire-model",
      },
      {
        rootSessionId: " root-new ",
        timestamp: 30,
        executionSessionId: "new-execution-old",
        requestedModel: "new-provider/old-model",
        provider: "new-provider",
        model: "wire-old",
      },
      {
        rootSessionId: "root-old",
        timestamp: 40,
        executionSessionId: "latest-execution",
        requestedModel: "latest-provider/latest-model",
        provider: "latest-provider",
        model: "wire-model",
        resolvedModel: "resolved-model",
        prompt: "private prompt",
        usage: { inputTokens: 100 },
        accountId: "private-account",
        unknownSecret: "private unknown",
      },
      {
        rootSessionId: "root-new",
        timestamp: 20,
        executionSessionId: "stale-new-execution",
        requestedModel: "stale-provider/stale-model",
        provider: "stale-provider",
        model: "stale-wire-model",
      },
      {
        rootSessionId: "root-third",
        timestamp: 35,
        requestedModel: "third-provider/third-model",
        provider: "third-provider",
        model: "third-model",
      },
      {
        rootSessionId: "\u0000invalid-root",
        timestamp: 999,
        provider: "should-not-appear",
        model: "should-not-appear",
      },
    ];

    expect(parseRecentSessions(logs, 2)).toEqual([
      {
        rootSessionId: "root-old",
        lastSeenAt: 40,
        executionSessionId: "latest-execution",
        requestedProvider: "latest-provider",
        requestedModel: "latest-provider/latest-model",
        effectiveProvider: "latest-provider",
        effectiveModel: "resolved-model",
      },
      {
        rootSessionId: "root-third",
        lastSeenAt: 35,
        requestedProvider: "third-provider",
        requestedModel: "third-provider/third-model",
        effectiveProvider: "third-provider",
        effectiveModel: "third-model",
      },
    ]);

    const serialized = JSON.stringify(parseRecentSessions(logs));
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("private-account");
    expect(serialized).not.toContain("private unknown");
    expect(serialized).not.toContain("activeRequests");
  });

  test("ignores malformed recent rows and derives optional fields safely", () => {
    expect(parseRecentSessions([
      null,
      { rootSessionId: "missing-time", provider: "p", model: "m" },
      { rootSessionId: "bad-time", timestamp: Number.POSITIVE_INFINITY, provider: "p", model: "m" },
      {
        rootSessionId: "root",
        timestamp: 1,
        requestedModel: "model-without-provider",
        provider: " provider ",
        model: "fallback-model",
        resolvedModel: null,
        executionSessionId: " execution ",
      },
    ])).toEqual([{
      rootSessionId: "root",
      lastSeenAt: 1,
      executionSessionId: "execution",
      requestedModel: "model-without-provider",
      effectiveProvider: "provider",
      effectiveModel: "fallback-model",
    }]);
  });
});

describe("session history parser", () => {
  test("parses history response with token fields and identity", () => {
    const result = parseSessionHistory({
      generatedAt: 5000,
      retentionDays: 30,
      sessions: [
        {
          rootSessionId: "root-a",
          lastSeenAt: 4000,
          requestCount: 10,
          measuredRequests: 8,
          estimatedRequests: 2,
          unmeteredRequests: 2,
          totalTokens: 12345,
          executionSessionId: "exec-a",
          requestedProvider: "openai",
          requestedModel: "openai/gpt-5",
          requestedEffort: "high",
          effectiveProvider: "openai",
          effectiveModel: "gpt-5",
        },
        {
          rootSessionId: "root-b",
          lastSeenAt: 3000,
          requestCount: 3,
          measuredRequests: 0,
          unmeteredRequests: 3,
          effectiveProvider: "anthropic",
          effectiveModel: "claude-3",
        },
      ],
    });
    expect(result.generatedAt).toBe(5000);
    expect(result.retentionDays).toBe(30);
    expect(result.sessions).toHaveLength(2);

    const a = result.sessions[0];
    expect(a).toEqual({
      rootSessionId: "root-a",
      lastSeenAt: 4000,
      requestCount: 10,
      measuredRequests: 8,
      estimatedRequests: 2,
      unmeteredRequests: 2,
      totalTokens: 12345,
      executionSessionId: "exec-a",
      requestedProvider: "openai",
      requestedModel: "openai/gpt-5",
      requestedEffort: "high",
      effectiveProvider: "openai",
      effectiveModel: "gpt-5",
    });

    const b = result.sessions[1];
    expect(b.totalTokens).toBeUndefined();
    expect(b.measuredRequests).toBe(0);
    expect(b.unmeteredRequests).toBe(3);
    expect(b.effectiveProvider).toBe("anthropic");
    expect(b.effectiveModel).toBe("claude-3");
  });

  test("drops malformed history rows and omits private/unknown fields", () => {
    const result = parseSessionHistory({
      generatedAt: 1,
      retentionDays: 30,
      sessions: [
        null,
        { lastSeenAt: 100, provider: "p", model: "m" }, // missing rootSessionId
        { rootSessionId: "good", lastSeenAt: 100, provider: "p", model: "m", prompt: "secret", accountId: "acct" },
        { rootSessionId: "bad-time", provider: "p", model: "m" }, // missing lastSeenAt
        { rootSessionId: "x".repeat(300), lastSeenAt: 50 }, // rootSessionId too long
      ],
    });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].rootSessionId).toBe("good");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("acct");
  });

  test("requires envelope fields and throws on malformed top-level", () => {
    expect(() => parseSessionHistory(null)).toThrow(Error);
    expect(() => parseSessionHistory({ generatedAt: 1, sessions: [] })).not.toThrow();
    expect(() => parseSessionHistory({ generatedAt: 1, retentionDays: 30, sessions: "nope" })).toThrow(Error);
    expect(() => parseSessionHistory({ generatedAt: -1, retentionDays: 30, sessions: [] })).toThrow(Error);
  });

  test("defaults retentionDays to 30 when absent", () => {
    const result = parseSessionHistory({ generatedAt: 1, sessions: [] });
    expect(result.retentionDays).toBe(30);
  });
});

describe("session logs parser", () => {
  test("parses log response and computes token totals", () => {
    const result = parseSessionLogs({
      rootSessionId: "root-a",
      retentionDays: 30,
      logs: [
        {
          requestId: "req-1",
          timestamp: 1000,
          status: 200,
          durationMs: 50,
          usageStatus: "reported",
          provider: "openai",
          model: "gpt-5",
          resolvedModel: "gpt-5-turbo",
          requestedModel: "openai/gpt-5",
          requestedEffort: "max",
          executionSessionId: "exec-1",
          requestKind: "chat",
          subagentKind: "spawn",
          isSpawnedChild: true,
          usage: { inputTokens: 100, outputTokens: 50 },
          totalTokens: 150,
        },
        {
          requestId: "req-2",
          timestamp: 2000,
          status: 500,
          durationMs: 30,
          usageStatus: "unreported",
          provider: "anthropic",
          model: "claude-3",
          errorCode: "INTERNAL",
          terminalStatus: "error",
          closeReason: "upstream_error",
        },
      ],
    });
    expect(result.rootSessionId).toBe("root-a");
    expect(result.logs).toHaveLength(2);

    const l1 = result.logs[0];
    expect(l1.requestId).toBe("req-1");
    expect(l1.resolvedModel).toBe("gpt-5-turbo");
    expect(l1.isSpawnedChild).toBe(true);
    expect(l1.usage?.inputTokens).toBe(100);
    expect(sessionLogTokenTotal(l1)).toBe(150);

    const l2 = result.logs[1];
    expect(l2.usage).toBeUndefined();
    expect(l2.errorCode).toBe("INTERNAL");
    expect(l2.terminalStatus).toBe("error");
    expect(l2.closeReason).toBe("upstream_error");
    expect(sessionLogTokenTotal(l2)).toBeUndefined();
  });

  test("sessionLogTokenTotal uses base when usage present without explicit total", () => {
    const log = parseSessionLogs({
      rootSessionId: "r",
      logs: [{
        requestId: "r1", timestamp: 1, status: 200, durationMs: 5,
        usageStatus: "estimated", provider: "p", model: "m",
        usage: { inputTokens: 20, outputTokens: 10, estimated: true },
      }],
    }).logs[0];
    expect(sessionLogTokenTotal(log)).toBe(30);
  });

  test("drops malformed log rows and omits private fields", () => {
    const result = parseSessionLogs({
      rootSessionId: "r",
      logs: [
        null,
        { timestamp: 1, status: 200, durationMs: 5, usageStatus: "reported", provider: "p", model: "m" }, // missing requestId
        { requestId: "r2", timestamp: 1, status: 200, durationMs: 5, usageStatus: "bogus", provider: "p", model: "m" },
        {
          requestId: "r3", timestamp: 1, status: 200, durationMs: 5,
          usageStatus: "reported", provider: "p", model: "m",
          usage: { inputTokens: 10, outputTokens: 5 },
          upstreamError: "should-not-leak",
          attempts: [{ ordinal: 1 }],
          accountId: "secret",
        },
      ],
    });
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].requestId).toBe("r3");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("should-not-leak");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("attempts");
  });

  test("requires logs envelope and throws on malformed top-level", () => {
    expect(() => parseSessionLogs(null)).toThrow(Error);
    expect(() => parseSessionLogs({ rootSessionId: "r", logs: "nope" })).toThrow(Error);
  });
});
