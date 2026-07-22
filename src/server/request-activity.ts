import { sanitizeIdentityValue } from "./request-identity";
import type { SessionRoutePolicy } from "./session-route-policy";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface RequestActivityIdentity {
  rootSessionId?: string;
  executionSessionId?: string;
}

export type RequestRoutePolicy = SessionRoutePolicy;
export type RequestEffectiveUpstream = "codex_pool" | "codex_direct" | "provider" | "none";
export type RequestFallbackReason = "all_personal_accounts_unavailable";

export interface RequestActivitySourceCounts {
  gpt: number;
  glm: number;
  other: number;
}

export interface RequestRouteObservation {
  routePolicy: RequestRoutePolicy;
  requestedProvider?: string;
  requestedModel?: string;
  requestedEffort?: string;
  effectiveProvider?: string;
  effectiveModel?: string;
  effectiveUpstream: RequestEffectiveUpstream;
  fallbackReason?: RequestFallbackReason;
  overrideSourceModel?: string;
  overrideTargetModel?: string;
  overrideEffort?: string;
}

export interface RequestActivitySession {
  rootSessionId: string;
  threadName?: string;
  activeRequests: number;
  activeSourceCounts?: RequestActivitySourceCounts;
  executionSessionIds: string[];
  oldestStartedAt: number;
  routePolicy?: RequestRoutePolicy;
  requestedProvider?: string;
  requestedModel?: string;
  effectiveProvider?: string;
  effectiveModel?: string;
  effectiveUpstream?: RequestEffectiveUpstream;
  fallbackReason?: RequestFallbackReason;
  overrideSourceModel?: string;
  overrideTargetModel?: string;
  overrideEffort?: string;
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
  const requestedEffort = sanitizeIdentityValue(value.requestedEffort);
  const effectiveProvider = sanitizeIdentityValue(value.effectiveProvider);
  const effectiveModel = sanitizeIdentityValue(value.effectiveModel);
  const fallbackReason = isRequestFallbackReason(value.fallbackReason)
    ? value.fallbackReason
    : undefined;
  const overrideSourceModel = sanitizeIdentityValue(value.overrideSourceModel);
  const overrideTargetModel = sanitizeIdentityValue(value.overrideTargetModel);
  const overrideEffort = sanitizeIdentityValue(value.overrideEffort);

  return {
    routePolicy: value.routePolicy,
    ...(requestedProvider ? { requestedProvider } : {}),
    ...(requestedModel ? { requestedModel } : {}),
    ...(requestedEffort ? { requestedEffort } : {}),
    ...(effectiveProvider ? { effectiveProvider } : {}),
    ...(effectiveModel ? { effectiveModel } : {}),
    effectiveUpstream: value.effectiveUpstream,
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(overrideSourceModel ? { overrideSourceModel } : {}),
    ...(overrideTargetModel ? { overrideTargetModel } : {}),
    ...(overrideEffort ? { overrideEffort } : {}),
  };
}

function requestSource(observation: RequestRouteObservation): keyof RequestActivitySourceCounts {
  const provider = observation.effectiveProvider?.toLowerCase();
  const model = (observation.effectiveModel ?? observation.requestedModel)?.toLowerCase();
  if (provider === "zai-anthropic" || model?.startsWith("glm-") === true) return "glm";
  if (provider === "openai" || model?.startsWith("gpt-") === true) return "gpt";
  return "other";
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


let threadNameCache: Map<string, string> | null = null;
let threadNameCacheMtime = 0;

function getThreadNameMap(): Map<string, string> {
  const indexPath = join(homedir(), ".codex", "session_index.jsonl");
  let mtime = 0;
  try {
    mtime = statSync(indexPath).mtimeMs;
  } catch {
    return threadNameCache ?? new Map();
  }
  if (threadNameCache && mtime === threadNameCacheMtime) return threadNameCache;
  const map = new Map<string, string>();
  try {
    const content = readFileSync(indexPath, "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.id && entry.thread_name) {
          map.set(String(entry.id), String(entry.thread_name));
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file unreadable */ }
  threadNameCache = map;
  threadNameCacheMtime = mtime;
  return map;
}

export function snapshotRequestActivity(generatedAt = Date.now()): RequestActivitySnapshot {
  const sessions = new Map<string, {
    activeRequests: number;
    activeSourceCounts: RequestActivitySourceCounts;
    routedRequests: number;
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
      activeSourceCounts: { gpt: 0, glm: 0, other: 0 },
      routedRequests: 0,
      executionSessionIds: new Set<string>(),
      oldestStartedAt: activeRequest.startedAt,
    };
    session.activeRequests += 1;
    if (activeRequest.routeObservation) {
      session.activeSourceCounts[requestSource(activeRequest.routeObservation.observation)] += 1;
      session.routedRequests += 1;
    }
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
        ...(getThreadNameMap().get(rootSessionId) ? { threadName: getThreadNameMap().get(rootSessionId) } : {}),
        activeRequests: session.activeRequests,
        ...(session.routedRequests > 0 ? { activeSourceCounts: session.activeSourceCounts } : {}),
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
