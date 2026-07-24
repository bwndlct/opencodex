/**
 * Per-session turn guard (fork module).
 *
 * Prevents concurrent main-turn requests for the same session on the HTTP path.
 * When a new main turn arrives for a session that already has an in-flight main
 * turn, the previous turn's upstream is aborted — mirroring the WebSocket path's
 * `ws.data.cancel?.()` behaviour (src/server/index.ts).
 *
 * Scope:
 * - Only `requestKind === "turn"` and `!isSpawnedChild` requests trigger supersession.
 * - `memory`, `compaction`, and spawned-child requests run concurrently (by design).
 * - Keyed by `rootSessionId` so sub-agent threads (different executionSessionId)
 *   do not interfere with the parent's main turn.
 * - Internal delegations (comboAttempt, dualUpstreamAttempt, identityOverride) are
 *   exempt: they originate from within handleResponses itself, not from a new
 *   client request.
 */

import type { RequestIdentity } from "./request-identity";

const activeTurnBySession = new Map<string, AbortController>();

/**
 * Determines whether a request is a "main turn" that should participate in
 * per-session supersession.
 */
export function isMainTurn(identity: RequestIdentity): boolean {
  if (identity.isSpawnedChild) return false;
  // Memory consolidation and compaction are background tasks — they must run
  // concurrently with turns, never be superseded by one.
  const kind = identity.requestKind;
  if (kind === "memory" || kind === "compaction") return false;
  // requestKind may be absent on older clients; treat its absence as a main turn
  // (matches the default assumption: a bare POST /v1/responses is a user turn).
  if (kind === undefined || kind === "turn") return true;
  // Unknown kinds: be conservative and do NOT supersede.
  return false;
}

export interface SessionTurnGuard {
  /** AbortSignal that fires when this turn is superseded by a newer one. */
  signal: AbortSignal;
  /** MUST be called when the turn ends (completion, error, or abort). */
  cleanup: () => void;
}

/**
 * Registers a new main turn for a session, aborting any previously in-flight
 * main turn for that session. Returns the guard handle whose `.signal` can be
 * merged with the caller's abortSignal via `AbortSignal.any()`.
 *
 * Returns `null` if the session identity is unsuitable for guarding (no
 * rootSessionId, or not a main turn) — caller should treat null as "no guard".
 */
export function beginSessionTurn(identity: RequestIdentity): SessionTurnGuard | null {
  const rootSessionId = identity.rootSessionId;
  if (!rootSessionId) return null;
  if (!isMainTurn(identity)) return null;

  // Abort the previous in-flight turn for this session (if any).
  const prev = activeTurnBySession.get(rootSessionId);
  if (prev) {
    prev.abort("session turn superseded by newer request");
    activeTurnBySession.delete(rootSessionId);
  }

  const controller = new AbortController();
  activeTurnBySession.set(rootSessionId, controller);

  let cleaned = false;
  return {
    signal: controller.signal,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      // Only delete if we still own the slot (a newer turn may have already
      // replaced us and registered its own controller).
      const current = activeTurnBySession.get(rootSessionId);
      if (current === controller) {
        activeTurnBySession.delete(rootSessionId);
      }
    },
  };
}

/** Test-only: reset all tracked turns. */
export function resetSessionTurnGuardForTests(): void {
  for (const ac of activeTurnBySession.values()) {
    ac.abort("test reset");
  }
  activeTurnBySession.clear();
}

/** Test-only: check whether a session currently has an in-flight main turn. */
export function hasActiveSessionTurn(rootSessionId: string): boolean {
  return activeTurnBySession.has(rootSessionId);
}
