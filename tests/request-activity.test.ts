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
});
