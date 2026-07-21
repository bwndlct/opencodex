/**
 * Test goal: verify the session workspace parsers validate API contracts, normalize identity,
 * retain only safe fields, and keep active/recent session datasets independent.
 */
import { describe, expect, test } from "bun:test";
import {
  parseActiveSessionSnapshot,
  parseRecentSessions,
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
