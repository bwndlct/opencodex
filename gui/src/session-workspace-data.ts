export type SessionRoutePolicy = "inherit" | "personal_first" | "company_first";
export type EffectiveUpstream = "codex_pool" | "codex_direct" | "company" | "provider" | "none";
export type FallbackReason = "all_personal_accounts_unavailable" | "company_upstream_unavailable";

export interface ActiveSourceCounts {
  gpt: number;
  glm: number;
  other: number;
}

export interface ActiveSession {
  rootSessionId: string;
  threadName?: string;
  activeRequests: number;
  activeSourceCounts?: ActiveSourceCounts;
  executionSessionIds: string[];
  oldestStartedAt: number;
  routePolicy?: SessionRoutePolicy;
  requestedProvider?: string;
  requestedModel?: string;
  requestedEffort?: string;
  effectiveProvider?: string;
  effectiveModel?: string;
  effectiveUpstream?: EffectiveUpstream;
  fallbackReason?: FallbackReason;
}

export interface ActiveSessionSnapshot {
  generatedAt: number;
  activeRequests: number;
  unattributedActiveRequests: number;
  sessions: ActiveSession[];
}

export interface RecentSession {
  rootSessionId: string;
  threadName?: string;
  lastSeenAt: number;
  executionSessionId?: string;
  requestedProvider?: string;
  requestedModel?: string;
  requestedEffort?: string;
  effectiveProvider?: string;
  effectiveModel?: string;
}

const IDENTITY_VALUE_MAX_LENGTH = 256;
const DEFAULT_RECENT_SESSION_LIMIT = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeIdentityValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > IDENTITY_VALUE_MAX_LENGTH) return undefined;
  for (const character of trimmed) {
    const codePoint = character.charCodeAt(0);
    if (codePoint <= 31 || codePoint === 127) return undefined;
  }
  return trimmed;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function requiredNonNegativeNumber(
  record: Record<string, unknown>,
  field: string,
  scope: string,
): number {
  const value = record[field];
  if (!isFiniteNonNegativeNumber(value)) {
    throw new Error(`${scope}.${field} must be a finite, non-negative number`);
  }
  return value;
}

function isSessionRoutePolicy(value: unknown): value is SessionRoutePolicy {
  return value === "inherit" || value === "personal_first" || value === "company_first";
}

function isEffectiveUpstream(value: unknown): value is EffectiveUpstream {
  return value === "codex_pool"
    || value === "codex_direct"
    || value === "company"
    || value === "provider"
    || value === "none";
}

function isFallbackReason(value: unknown): value is FallbackReason {
  return value === "all_personal_accounts_unavailable" || value === "company_upstream_unavailable";
}

function parseExecutionSessionIds(value: unknown, scope: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${scope}.executionSessionIds must be an array`);

  return [...new Set(value.flatMap((id) => {
    const sanitized = sanitizeIdentityValue(id);
    return sanitized ? [sanitized] : [];
  }))].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function parseActiveSourceCounts(value: unknown, scope: string): ActiveSourceCounts | undefined {
  if (!isRecord(value)) return undefined;
  return {
    gpt: requiredNonNegativeNumber(value, "gpt", scope),
    glm: requiredNonNegativeNumber(value, "glm", scope),
    other: requiredNonNegativeNumber(value, "other", scope),
  };
}

function parseActiveSession(value: unknown, index: number): ActiveSession {
  const scope = `sessions[${index}]`;
  if (!isRecord(value)) throw new Error(`${scope} must be an object`);

  const rootSessionId = sanitizeIdentityValue(value.rootSessionId);
  if (!rootSessionId) throw new Error(`${scope}.rootSessionId is invalid`);
  const activeSourceCounts = parseActiveSourceCounts(
    value.activeSourceCounts,
    `${scope}.activeSourceCounts`,
  );

  return {
    rootSessionId,
    ...(sanitizeIdentityValue(value.threadName) ? { threadName: sanitizeIdentityValue(value.threadName) } : {}),
    activeRequests: requiredNonNegativeNumber(value, "activeRequests", scope),
    ...(activeSourceCounts ? { activeSourceCounts } : {}),
    executionSessionIds: parseExecutionSessionIds(value.executionSessionIds, scope),
    oldestStartedAt: requiredNonNegativeNumber(value, "oldestStartedAt", scope),
    ...(isSessionRoutePolicy(value.routePolicy) ? { routePolicy: value.routePolicy } : {}),
    ...(sanitizeIdentityValue(value.requestedProvider)
      ? { requestedProvider: sanitizeIdentityValue(value.requestedProvider) }
      : {}),
    ...(sanitizeIdentityValue(value.requestedModel)
      ? { requestedModel: sanitizeIdentityValue(value.requestedModel) }
      : {}),
    ...(sanitizeIdentityValue(value.requestedEffort)
      ? { requestedEffort: sanitizeIdentityValue(value.requestedEffort) }
      : {}),
    ...(sanitizeIdentityValue(value.effectiveProvider)
      ? { effectiveProvider: sanitizeIdentityValue(value.effectiveProvider) }
      : {}),
    ...(sanitizeIdentityValue(value.effectiveModel)
      ? { effectiveModel: sanitizeIdentityValue(value.effectiveModel) }
      : {}),
    ...(isEffectiveUpstream(value.effectiveUpstream) ? { effectiveUpstream: value.effectiveUpstream } : {}),
    ...(isFallbackReason(value.fallbackReason) ? { fallbackReason: value.fallbackReason } : {}),
  };
}

export function parseActiveSessionSnapshot(value: unknown): ActiveSessionSnapshot {
  if (!isRecord(value)) throw new Error("active session snapshot must be an object");
  if (!Array.isArray(value.sessions)) throw new Error("active session snapshot.sessions must be an array");

  return {
    generatedAt: requiredNonNegativeNumber(value, "generatedAt", "active session snapshot"),
    activeRequests: requiredNonNegativeNumber(value, "activeRequests", "active session snapshot"),
    unattributedActiveRequests: requiredNonNegativeNumber(
      value,
      "unattributedActiveRequests",
      "active session snapshot",
    ),
    sessions: value.sessions.map((session, index) => parseActiveSession(session, index)),
  };
}

interface RecentSessionCandidate {
  session: RecentSession;
  timestamp: number;
  sequence: number;
}

function recentSessionLimit(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_RECENT_SESSION_LIMIT;
  return Math.max(0, Math.floor(value));
}

function requestedModelFields(value: unknown): Pick<RecentSession, "requestedProvider" | "requestedModel"> {
  const requestedModel = sanitizeIdentityValue(value);
  if (!requestedModel) return {};

  const separator = requestedModel.indexOf("/");
  const requestedProvider = separator > 0
    ? sanitizeIdentityValue(requestedModel.slice(0, separator))
    : undefined;
  return {
    requestedModel,
    ...(requestedProvider ? { requestedProvider } : {}),
  };
}

function parseRecentSessionCandidate(value: unknown, sequence: number): RecentSessionCandidate | undefined {
  if (!isRecord(value)) return undefined;

  const rootSessionId = sanitizeIdentityValue(value.rootSessionId);
  if (!rootSessionId || !isFiniteNonNegativeNumber(value.timestamp)) return undefined;

  const requestedModel = requestedModelFields(value.requestedModel);
  const effectiveModel = sanitizeIdentityValue(value.resolvedModel) ?? sanitizeIdentityValue(value.model);
  const session: RecentSession = {
    rootSessionId,
    lastSeenAt: value.timestamp,
    ...(sanitizeIdentityValue(value.executionSessionId)
      ? { executionSessionId: sanitizeIdentityValue(value.executionSessionId) }
      : {}),
    ...requestedModel,
    ...(sanitizeIdentityValue(value.requestedEffort) ? { requestedEffort: sanitizeIdentityValue(value.requestedEffort) } : {}),
    ...(sanitizeIdentityValue(value.provider)
      ? { effectiveProvider: sanitizeIdentityValue(value.provider) }
      : {}),
    ...(effectiveModel ? { effectiveModel } : {}),
  };

  return { session, timestamp: value.timestamp, sequence };
}

export function parseRecentSessions(value: unknown, limit = DEFAULT_RECENT_SESSION_LIMIT): RecentSession[] {
  if (!Array.isArray(value)) return [];
  const max = recentSessionLimit(limit);
  if (max === 0) return [];

  const latestByRoot = new Map<string, RecentSessionCandidate>();
  value.forEach((row, sequence) => {
    const candidate = parseRecentSessionCandidate(row, sequence);
    if (!candidate) return;

    const existing = latestByRoot.get(candidate.session.rootSessionId);
    if (!existing
      || candidate.timestamp > existing.timestamp
      || (candidate.timestamp === existing.timestamp && candidate.sequence > existing.sequence)) {
      latestByRoot.set(candidate.session.rootSessionId, candidate);
    }
  });

  return [...latestByRoot.values()]
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) return left.timestamp > right.timestamp ? -1 : 1;
      if (left.session.rootSessionId !== right.session.rootSessionId) {
        return left.session.rootSessionId < right.session.rootSessionId ? -1 : 1;
      }
      return left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0;
    })
    .slice(0, max)
    .map(candidate => candidate.session);
}
