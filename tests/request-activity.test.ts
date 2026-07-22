/**
 * Test goal: verify request activity registration, idempotent cleanup, identity grouping,
 * deterministic ordering, and bounded snapshot fields without external services.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  beginRequestActivity,
  endRequestActivity,
  resetRequestActivityForTests,
  snapshotRequestActivity,
  updateRequestActivityRoute,
} from "../src/server/request-activity";

afterEach(() => resetRequestActivityForTests());

describe("request activity store", () => {
  test("does not double count duplicate begin and end is idempotent", () => {
    beginRequestActivity("request-1", 100, {
      rootSessionId: "root",
      executionSessionId: "execution",
    });
    beginRequestActivity("request-1", 200, {
      rootSessionId: "other-root",
      executionSessionId: "other-execution",
    });

    expect(snapshotRequestActivity(300)).toEqual({
      generatedAt: 300,
      activeRequests: 1,
      unattributedActiveRequests: 0,
      sessions: [{
        rootSessionId: "root",
        activeRequests: 1,
        executionSessionIds: ["execution"],
        oldestStartedAt: 100,
      }],
    });

    endRequestActivity("request-1");
    endRequestActivity("request-1");
    expect(snapshotRequestActivity(301)).toEqual({
      generatedAt: 301,
      activeRequests: 0,
      unattributedActiveRequests: 0,
      sessions: [],
    });
  });

  test("counts missing root identity as unattributed without creating a sentinel session", () => {
    beginRequestActivity("request-without-identity", 10);
    beginRequestActivity("request-with-execution-only", 20, { executionSessionId: "execution-only" });

    expect(snapshotRequestActivity(30)).toEqual({
      generatedAt: 30,
      activeRequests: 2,
      unattributedActiveRequests: 2,
      sessions: [],
    });
  });

  test("sorts sessions and execution IDs and deduplicates execution IDs", () => {
    beginRequestActivity("request-z-1", 40, { rootSessionId: "z-root", executionSessionId: "shared" });
    beginRequestActivity("request-a-1", 20, { rootSessionId: "a-root", executionSessionId: "z-execution" });
    beginRequestActivity("request-a-2", 10, { rootSessionId: "a-root", executionSessionId: "shared" });
    beginRequestActivity("request-z-2", 30, { rootSessionId: "z-root", executionSessionId: "shared" });
    beginRequestActivity("request-a-3", 15, { rootSessionId: "a-root", executionSessionId: "a-execution" });

    expect(snapshotRequestActivity(50)).toEqual({
      generatedAt: 50,
      activeRequests: 5,
      unattributedActiveRequests: 0,
      sessions: [
        {
          rootSessionId: "a-root",
          activeRequests: 3,
          executionSessionIds: ["a-execution", "shared", "z-execution"],
          oldestStartedAt: 10,
        },
        {
          rootSessionId: "z-root",
          activeRequests: 2,
          executionSessionIds: ["shared"],
          oldestStartedAt: 30,
        },
      ],
    });
  });

  test("trims empty identity values and keeps only the bounded activity shape", () => {
    beginRequestActivity("request-trimmed", 1, {
      rootSessionId: " root ",
      executionSessionId: " execution ",
    });

    const snapshot = snapshotRequestActivity(2);
    expect(snapshot.sessions[0]).toEqual({
      rootSessionId: "root",
      activeRequests: 1,
      executionSessionIds: ["execution"],
      oldestStartedAt: 1,
    });
    expect(JSON.stringify(snapshot)).not.toContain("prompt");
    expect(JSON.stringify(snapshot)).not.toContain("credential");
    expect(JSON.stringify(snapshot)).not.toContain("account");
  });

  test("excludes oversized and control-character identity values from the snapshot", () => {
    beginRequestActivity("request-long-root", 1, {
      rootSessionId: "r".repeat(257),
      executionSessionId: "execution-long-root",
    });
    beginRequestActivity("request-control-root", 2, {
      rootSessionId: "root\u0000control",
      executionSessionId: "execution-control-root",
    });
    beginRequestActivity("request-long-execution", 3, {
      rootSessionId: "valid-root",
      executionSessionId: "e".repeat(257),
    });
    beginRequestActivity("request-control-execution", 4, {
      rootSessionId: "valid-root",
      executionSessionId: "execution\u0000control",
    });

    expect(snapshotRequestActivity(5)).toEqual({
      generatedAt: 5,
      activeRequests: 4,
      unattributedActiveRequests: 2,
      sessions: [{
        rootSessionId: "valid-root",
        activeRequests: 2,
        executionSessionIds: [],
        oldestStartedAt: 3,
      }],
    });
  });

  test("keeps requested and effective route fields separate", () => {
    beginRequestActivity("request-route", 1, { rootSessionId: "root-route" });
    updateRequestActivityRoute("request-route", {
      routePolicy: "personal_first",
      requestedProvider: "requested-provider",
      requestedModel: "requested-model",
      effectiveProvider: "effective-provider",
      effectiveModel: "effective-model",
      effectiveUpstream: "codex_pool",
      overrideSourceModel: "gpt-5.4",
      overrideTargetModel: "combo/glm-failover",
      overrideEffort: "max",
    });

    expect(snapshotRequestActivity(2).sessions).toEqual([{
      rootSessionId: "root-route",
      activeRequests: 1,
      activeSourceCounts: { gpt: 0, glm: 0, other: 1 },
      executionSessionIds: [],
      oldestStartedAt: 1,
      routePolicy: "personal_first",
      requestedProvider: "requested-provider",
      requestedModel: "requested-model",
      effectiveProvider: "effective-provider",
      effectiveModel: "effective-model",
      effectiveUpstream: "codex_pool",
      overrideSourceModel: "gpt-5.4",
      overrideTargetModel: "combo/glm-failover",
      overrideEffort: "max",
    }]);
  });

  test("replaces a request observation so recovery clears its previous fallback", () => {
    beginRequestActivity("request-recovery", 1, { rootSessionId: "root-recovery" });
    updateRequestActivityRoute("request-recovery", {
      routePolicy: "personal_first",
      requestedModel: "model",
      effectiveProvider: "company",
      effectiveModel: "model",
      effectiveUpstream: "codex_direct",
      fallbackReason: "all_personal_accounts_unavailable",
    });
    updateRequestActivityRoute("request-recovery", {
      routePolicy: "personal_first",
      requestedModel: "model",
      effectiveProvider: "personal",
      effectiveModel: "model",
      effectiveUpstream: "codex_pool",
    });

    expect(snapshotRequestActivity(2).sessions[0]).toEqual({
      rootSessionId: "root-recovery",
      activeRequests: 1,
      activeSourceCounts: { gpt: 0, glm: 0, other: 1 },
      executionSessionIds: [],
      oldestStartedAt: 1,
      routePolicy: "personal_first",
      requestedModel: "model",
      effectiveProvider: "personal",
      effectiveModel: "model",
      effectiveUpstream: "codex_pool",
    });
  });

  test("uses the latest concurrent request observation and falls back after it ends", () => {
    beginRequestActivity("request-old", 1, { rootSessionId: "root-concurrent" });
    beginRequestActivity("request-new", 2, { rootSessionId: "root-concurrent" });
    updateRequestActivityRoute("request-old", {
      routePolicy: "inherit",
      requestedModel: "old-model",
      effectiveModel: "old-effective-model",
      effectiveUpstream: "provider",
    });
    updateRequestActivityRoute("request-new", {
      routePolicy: "personal_first",
      requestedModel: "new-model",
      effectiveModel: "new-effective-model",
      effectiveUpstream: "codex_pool",
    });

    expect(snapshotRequestActivity(3).sessions[0]?.requestedModel).toBe("new-model");
    expect(snapshotRequestActivity(3).sessions[0]?.effectiveUpstream).toBe("codex_pool");

    endRequestActivity("request-new");
    expect(snapshotRequestActivity(4).sessions[0]).toMatchObject({
      rootSessionId: "root-concurrent",
      activeRequests: 1,
      requestedModel: "old-model",
      effectiveModel: "old-effective-model",
      effectiveUpstream: "provider",
    });
  });

  test("filters invalid and oversized route fields without leaking sensitive fields", () => {
    beginRequestActivity("request-invalid-route", 1, { rootSessionId: "root-invalid-route" });
    updateRequestActivityRoute("request-invalid-route", {
      routePolicy: "inherit",
      requestedProvider: ` ${"p".repeat(257)} `,
      requestedModel: " requested-model ",
      effectiveProvider: "effective-provider\u0000control",
      effectiveModel: " ",
      effectiveUpstream: "provider",
      fallbackReason: "unexpected-reason",
      accountId: "account-secret",
      token: "token-secret",
      authorization: "Bearer secret",
    });

    expect(snapshotRequestActivity(2).sessions[0]).toEqual({
      rootSessionId: "root-invalid-route",
      activeRequests: 1,
      activeSourceCounts: { gpt: 0, glm: 0, other: 1 },
      executionSessionIds: [],
      oldestStartedAt: 1,
      routePolicy: "inherit",
      requestedModel: "requested-model",
      effectiveUpstream: "provider",
    });
    const serialized = JSON.stringify(snapshotRequestActivity(2));
    expect(serialized).not.toContain("account-secret");
    expect(serialized).not.toContain("token-secret");
    expect(serialized).not.toContain("Bearer secret");
  });

  test("keeps the legacy session shape when no route observation exists", () => {
    beginRequestActivity("request-legacy-shape", 1, { rootSessionId: "root-legacy-shape" });

    expect(snapshotRequestActivity(2)).toEqual({
      generatedAt: 2,
      activeRequests: 1,
      unattributedActiveRequests: 0,
      sessions: [{
        rootSessionId: "root-legacy-shape",
        activeRequests: 1,
        executionSessionIds: [],
        oldestStartedAt: 1,
      }],
    });
  });

  test("counts GPT and GLM per active request within the same root session", () => {
    beginRequestActivity("request-gpt", 1, { rootSessionId: "mixed-root" });
    beginRequestActivity("request-glm-provider", 2, { rootSessionId: "mixed-root" });
    beginRequestActivity("request-glm-model", 3, { rootSessionId: "mixed-root" });

    updateRequestActivityRoute("request-gpt", {
      routePolicy: "inherit",
      effectiveProvider: "openai",
      effectiveModel: "gpt-5.6-sol",
      effectiveUpstream: "provider",
    });
    updateRequestActivityRoute("request-glm-provider", {
      routePolicy: "inherit",
      effectiveProvider: "zai-anthropic",
      effectiveModel: "glm-5.2",
      effectiveUpstream: "provider",
    });
    updateRequestActivityRoute("request-glm-model", {
      routePolicy: "inherit",
      effectiveProvider: "custom-provider",
      effectiveModel: "glm-5.2",
      effectiveUpstream: "provider",
    });

    expect(snapshotRequestActivity(4).sessions[0]).toMatchObject({
      rootSessionId: "mixed-root",
      activeRequests: 3,
      activeSourceCounts: { gpt: 1, glm: 2, other: 0 },
    });
  });
});
