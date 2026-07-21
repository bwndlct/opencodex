import { sanitizeIdentityValue } from "./request-identity";
import type { SessionRoutePolicy } from "./session-route-policy";

export interface RequestActivityIdentity {
  rootSessionId?: string;
  executionSessionId?: string;
}

export type RequestRoutePolicy = SessionRoutePolicy;
export type RequestEffectiveUpstream = "codex_pool" | "codex_direct" | "provider" | "none";
export type RequestFallbackReason = "all_personal_accounts_unavailable";

export interface RequestRouteObservation {
  routePolicy: RequestRoutePolicy;
  requestedProvider?: string;
  requestedModel?: string;
  effectiveProvider?: string;
  effectiveModel?: string;
  effectiveUpstream: RequestEffectiveUpstream;
  fallbackReason?: RequestFallbackReason;
}

export interface RequestActivitySession {
  rootSessionId: string;
  activeRequests: number;
  executionSessionIds: string[];
  oldestStartedAt: number;
  routePolicy?: RequestRoutePolicy;
  requestedProvider?: string;
  requestedModel?: string;
  effectiveProvider?: string;
  effectiveModel?: string;
  effectiveUpstream?: RequestEffectiveUpstream;
  fallbackReason?: RequestFallbackReason;
}

export interface RequestActivitySnapshot {
  generatedAt: number;
  activeRequests: number;
  unattributedActiveRequests: number;
  sessions: RequestActivitySession[];
}

interface ActiveRequest {
  startedAt: number;
  rootSessionId?: string;
  executionSessionId?: string;
  routeObservation?: StoredRouteObservation;
}

interface StoredRouteObservation {
  sequence: number;
  observation: RequestRouteObservation;
}

const activeRequestById = new Map<string, ActiveRequest>();
let nextRouteObservationSequence = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRequestRoutePolicy(value: unknown): value is RequestRoutePolicy {
  return value === "inherit" || value === "personal_first";
}

function isRequestEffectiveUpstream(value: unknown): value is RequestEffectiveUpstream {
  return value === "codex_pool"
    || value === "codex_direct"
    || value === "provider"
    || value === "none";
}

function isRequestFallbackReason(value: unknown): value is RequestFallbackReason {
  return value === "all_personal_accounts_unavailable";
}

function sanitizeRouteObservation(value: unknown): RequestRouteObservation | undefined {
  if (!isRecord(value)) return undefined;
  if (!isRequestRoutePolicy(value.routePolicy) || !isRequestEffectiveUpstream(value.effectiveUpstream)) {
    return undefined;
  }

  const requestedProvider = sanitizeIdentityValue(value.requestedProvider);
  const requestedModel = sanitizeIdentityValue(value.requestedModel);
  const effectiveProvider = sanitizeIdentityValue(value.effectiveProvider);
  const effectiveModel = sanitizeIdentityValue(value.effectiveModel);
  const fallbackReason = isRequestFallbackReason(value.fallbackReason)
    ? value.fallbackReason
    : undefined;

  return {
    routePolicy: value.routePolicy,
    ...(requestedProvider ? { requestedProvider } : {}),
    ...(requestedModel ? { requestedModel } : {}),
    ...(effectiveProvider ? { effectiveProvider } : {}),
    ...(effectiveModel ? { effectiveModel } : {}),
    effectiveUpstream: value.effectiveUpstream,
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

export function beginRequestActivity(
  requestId: string,
  startedAt: number,
  identity: RequestActivityIdentity = {},
): void {
  const normalizedRequestId = requestId.trim();
  if (!normalizedRequestId || activeRequestById.has(normalizedRequestId)) return;

  const rootSessionId = sanitizeIdentityValue(identity.rootSessionId);
  const executionSessionId = sanitizeIdentityValue(identity.executionSessionId);

  activeRequestById.set(normalizedRequestId, {
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    ...(rootSessionId ? { rootSessionId } : {}),
    ...(executionSessionId ? { executionSessionId } : {}),
  });
}

export function endRequestActivity(requestId: string): void {
  activeRequestById.delete(requestId.trim());
}

export function updateRequestActivityRoute(requestId: string, observation: unknown): void {
  const activeRequest = activeRequestById.get(requestId.trim());
  if (!activeRequest) return;

  const sanitizedObservation = sanitizeRouteObservation(observation);
  if (!sanitizedObservation) return;

  activeRequest.routeObservation = {
    sequence: ++nextRouteObservationSequence,
    observation: sanitizedObservation,
  };
}

export function snapshotRequestActivity(generatedAt = Date.now()): RequestActivitySnapshot {
  const sessions = new Map<string, {
    activeRequests: number;
    executionSessionIds: Set<string>;
    oldestStartedAt: number;
    latestRouteObservation?: StoredRouteObservation;
  }>();
  let unattributedActiveRequests = 0;

  for (const activeRequest of activeRequestById.values()) {
    if (!activeRequest.rootSessionId) {
      unattributedActiveRequests += 1;
      continue;
    }
    const session = sessions.get(activeRequest.rootSessionId) ?? {
      activeRequests: 0,
      executionSessionIds: new Set<string>(),
      oldestStartedAt: activeRequest.startedAt,
    };
    session.activeRequests += 1;
    if (activeRequest.executionSessionId) session.executionSessionIds.add(activeRequest.executionSessionId);
    session.oldestStartedAt = Math.min(session.oldestStartedAt, activeRequest.startedAt);
    if (
      activeRequest.routeObservation
      && (!session.latestRouteObservation || activeRequest.routeObservation.sequence > session.latestRouteObservation.sequence)
    ) {
      session.latestRouteObservation = activeRequest.routeObservation;
    }
    sessions.set(activeRequest.rootSessionId, session);
  }

  return {
    generatedAt,
    activeRequests: activeRequestById.size,
    unattributedActiveRequests,
    sessions: [...sessions.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([rootSessionId, session]) => ({
        rootSessionId,
        activeRequests: session.activeRequests,
        executionSessionIds: [...session.executionSessionIds].sort((left, right) => (
          left < right ? -1 : left > right ? 1 : 0
        )),
        oldestStartedAt: session.oldestStartedAt,
        ...(session.latestRouteObservation?.observation ?? {}),
      })),
  };
}

/** Test-only process-state reset. */
export function resetRequestActivityForTests(): void {
  activeRequestById.clear();
  nextRouteObservationSequence = 0;
}
