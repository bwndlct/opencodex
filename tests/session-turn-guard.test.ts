import { describe, expect, test } from "bun:test";
import {
  beginSessionTurn,
  isMainTurn,
  hasActiveSessionTurn,
  resetSessionTurnGuardForTests,
} from "../src/server/session-turn-guard";
import type { RequestIdentity } from "../src/server/request-identity";

function makeIdentity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    rootSessionId: "sess-test-001",
    executionSessionId: "exec-test-001",
    requestKind: "turn",
    isSpawnedChild: false,
    ...overrides,
  };
}

describe("isMainTurn classification", () => {
  test("bare turn with no requestKind is treated as a main turn", () => {
    expect(isMainTurn(makeIdentity({ requestKind: undefined }))).toBe(true);
  });

  test("requestKind=turn is a main turn", () => {
    expect(isMainTurn(makeIdentity({ requestKind: "turn" }))).toBe(true);
  });

  test("spawned child is NOT a main turn", () => {
    expect(isMainTurn(makeIdentity({ isSpawnedChild: true }))).toBe(false);
  });

  test("memory consolidation is NOT a main turn", () => {
    expect(isMainTurn(makeIdentity({ requestKind: "memory" }))).toBe(false);
  });

  test("compaction is NOT a main turn", () => {
    expect(isMainTurn(makeIdentity({ requestKind: "compaction" }))).toBe(false);
  });

  test("unknown request kinds are NOT main turns (conservative)", () => {
    expect(isMainTurn(makeIdentity({ requestKind: "future_kind" }))).toBe(false);
  });
});

describe("beginSessionTurn supersession", () => {
  test("returns null for identity without rootSessionId", () => {
    resetSessionTurnGuardForTests();
    const guard = beginSessionTurn(makeIdentity({ rootSessionId: undefined }));
    expect(guard).toBeNull();
  });

  test("returns null for spawned child", () => {
    resetSessionTurnGuardForTests();
    const guard = beginSessionTurn(makeIdentity({ isSpawnedChild: true }));
    expect(guard).toBeNull();
  });

  test("returns null for memory request", () => {
    resetSessionTurnGuardForTests();
    const guard = beginSessionTurn(makeIdentity({ requestKind: "memory" }));
    expect(guard).toBeNull();
  });

  test("registers a main turn and tracks it as active", () => {
    resetSessionTurnGuardForTests();
    const guard = beginSessionTurn(makeIdentity());
    expect(guard).not.toBeNull();
    expect(hasActiveSessionTurn("sess-test-001")).toBe(true);
    guard!.cleanup();
    expect(hasActiveSessionTurn("sess-test-001")).toBe(false);
  });

  test("new main turn aborts the previous in-flight turn for the same session", () => {
    resetSessionTurnGuardForTests();

    const guard1 = beginSessionTurn(makeIdentity());
    expect(guard1).not.toBeNull();

    let aborted = false;
    guard1!.signal.addEventListener("abort", () => { aborted = true; });

    // Second turn for the same session — should abort the first.
    const guard2 = beginSessionTurn(makeIdentity({ executionSessionId: "exec-test-002" }));
    expect(guard2).not.toBeNull();

    expect(aborted).toBe(true);
    expect(guard1!.signal.aborted).toBe(true);
    expect(hasActiveSessionTurn("sess-test-001")).toBe(true);

    guard2!.cleanup();
    expect(hasActiveSessionTurn("sess-test-001")).toBe(false);
  });

  test("different sessions do not interfere with each other", () => {
    resetSessionTurnGuardForTests();

    const guardA = beginSessionTurn(makeIdentity({ rootSessionId: "sess-A" }));
    const guardB = beginSessionTurn(makeIdentity({ rootSessionId: "sess-B" }));

    expect(guardA).not.toBeNull();
    expect(guardB).not.toBeNull();

    let aAborted = false;
    guardA!.signal.addEventListener("abort", () => { aAborted = true; });

    // New turn for B should not affect A.
    const guardB2 = beginSessionTurn(makeIdentity({ rootSessionId: "sess-B", executionSessionId: "exec-B2" }));
    expect(aAborted).toBe(false);
    expect(hasActiveSessionTurn("sess-A")).toBe(true);
    expect(hasActiveSessionTurn("sess-B")).toBe(true);

    guardA!.cleanup();
    guardB!.cleanup();
    guardB2!.cleanup();
  });

  test("memory request does NOT abort an in-flight main turn", () => {
    resetSessionTurnGuardForTests();

    const turnGuard = beginSessionTurn(makeIdentity());
    expect(turnGuard).not.toBeNull();

    let turnAborted = false;
    turnGuard!.signal.addEventListener("abort", () => { turnAborted = true; });

    // Memory request for the same session — should NOT abort the turn.
    const memGuard = beginSessionTurn(makeIdentity({ requestKind: "memory" }));
    expect(memGuard).toBeNull();
    expect(turnAborted).toBe(false);
    expect(hasActiveSessionTurn("sess-test-001")).toBe(true);

    turnGuard!.cleanup();
  });

  test("spawned child does NOT abort an in-flight main turn", () => {
    resetSessionTurnGuardForTests();

    const turnGuard = beginSessionTurn(makeIdentity());
    expect(turnGuard).not.toBeNull();

    let turnAborted = false;
    turnGuard!.signal.addEventListener("abort", () => { turnAborted = true; });

    // Spawned child for the same session — should NOT abort the turn.
    const childGuard = beginSessionTurn(makeIdentity({ isSpawnedChild: true, executionSessionId: "child-001" }));
    expect(childGuard).toBeNull();
    expect(turnAborted).toBe(false);

    turnGuard!.cleanup();
  });

  test("cleanup is idempotent", () => {
    resetSessionTurnGuardForTests();
    const guard = beginSessionTurn(makeIdentity());
    guard!.cleanup();
    guard!.cleanup(); // should not throw
    expect(hasActiveSessionTurn("sess-test-001")).toBe(false);
  });

  test("stale controller is not deleted by cleanup after supersession", () => {
    resetSessionTurnGuardForTests();

    const guard1 = beginSessionTurn(makeIdentity());
    const guard2 = beginSessionTurn(makeIdentity());

    // guard1 was superseded; its cleanup should NOT delete guard2's entry.
    guard1!.cleanup();
    expect(hasActiveSessionTurn("sess-test-001")).toBe(true);

    guard2!.cleanup();
    expect(hasActiveSessionTurn("sess-test-001")).toBe(false);
  });
});
