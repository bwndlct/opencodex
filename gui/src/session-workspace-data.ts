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
  requestCount?: number;
  measuredRequests?: number;
  estimatedRequests?: number;
  unmeteredRequests?: number;
  totalTokens?: number;
}

export type SessionHistoryEntry = RecentSession;

export interface SessionHistoryResponse {
  generatedAt: number;
  retentionDays: number;
  sessions: SessionHistoryEntry[];
}

export type SessionLogUsageStatus = "reported" | "unreported" | "unsupported" | "estimated";

export interface SessionLogUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  estimated?: boolean;
}

export interface SessionLog {
  requestId: string;
  timestamp: number;
  status: number;
  durationMs: number;
  usageStatus: SessionLogUsageStatus;
  provider: string;
  model: string;
  resolvedModel?: string;
  requestedModel?: string;
  requestedEffort?: string;
  executionSessionId?: string;
  requestKind?: string;
  subagentKind?: string;
  isSpawnedChild?: boolean;
  usage?: SessionLogUsage;
  totalTokens?: number;
  errorCode?: string;
  terminalStatus?: string;
  closeReason?: string;
}

export interface SessionLogResponse {
  rootSessionId: string;
  retentionDays: number;
  logs: SessionLog[];
}

const IDENTITY_VALUE_MAX_LENGTH = 256;
const DEFAULT_RECENT_SESSION_LIMIT = 20;

function optionalNonNegativeNumber(value: unknown): number | undefined {
  if (!isFiniteNonNegativeNumber(value)) return undefined;
  return value;
}

function isSessionLogUsageStatus(value: unknown): value is SessionLogUsageStatus {
  return value === "reported" || value === "unreported" || value === "unsupported" || value === "estimated";
}

/** Token total for a single log row, mirroring server usageDisplayTotalTokens semantics. */
export function sessionLogTokenTotal(log: SessionLog): number | undefined {
  if (log.usage) {
    const baseTotal = log.usage.inputTokens + log.usage.outputTokens;
    const explicitTotal = log.usage.totalTokens ?? log.totalTokens;
    return typeof explicitTotal === "number" ? Math.max(explicitTotal, baseTotal) : baseTotal;
  }
  return typeof log.totalTokens === "number" ? log.totalTokens : undefined;
}

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

  const threadName = sanitizeIdentityValue(value.threadName);
  const requestedModel = requestedModelFields(value.requestedModel);
  const effectiveModel = sanitizeIdentityValue(value.resolvedModel) ?? sanitizeIdentityValue(value.model);
  const session: RecentSession = {
    rootSessionId,
    ...(threadName ? { threadName } : {}),
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
/**
 * Parse the GET /api/sessions/history response envelope. Required envelope fields are
 * generatedAt/retentionDays/sessions; each session row reuses the safe-field logic from
 * parseRecentSessionCandidate but reads history field names (lastSeenAt, requestCount,
 * measured/estimated/unmetered counts, totalTokens, requestedProvider as a top-level field).
 */
function parseHistorySessionCandidate(value: unknown): SessionHistoryEntry | undefined {
  if (!isRecord(value)) return undefined;

  const rootSessionId = sanitizeIdentityValue(value.rootSessionId);
  if (!rootSessionId || !isFiniteNonNegativeNumber(value.lastSeenAt)) return undefined;

  const requestedProvider = sanitizeIdentityValue(value.requestedProvider);
  const requestedModel = sanitizeIdentityValue(value.requestedModel);
  const threadName = sanitizeIdentityValue(value.threadName);
  const effectiveProvider = sanitizeIdentityValue(value.effectiveProvider) ?? sanitizeIdentityValue(value.provider);
  const effectiveModel = sanitizeIdentityValue(value.effectiveModel) ?? sanitizeIdentityValue(value.resolvedModel);

  const entry: SessionHistoryEntry = {
    rootSessionId,
    ...(threadName ? { threadName } : {}),
    lastSeenAt: value.lastSeenAt,
    ...(sanitizeIdentityValue(value.executionSessionId)
      ? { executionSessionId: sanitizeIdentityValue(value.executionSessionId) }
      : {}),
    ...(requestedProvider ? { requestedProvider } : {}),
    ...(requestedModel ? { requestedModel } : {}),
    ...(sanitizeIdentityValue(value.requestedEffort) ? { requestedEffort: sanitizeIdentityValue(value.requestedEffort) } : {}),
    ...(effectiveProvider ? { effectiveProvider } : {}),
    ...(effectiveModel ? { effectiveModel } : {}),
  };

  const requestCount = optionalNonNegativeNumber(value.requestCount);
  if (requestCount !== undefined) entry.requestCount = requestCount;
  const measuredRequests = optionalNonNegativeNumber(value.measuredRequests);
  if (measuredRequests !== undefined) entry.measuredRequests = measuredRequests;
  const estimatedRequests = optionalNonNegativeNumber(value.estimatedRequests);
  if (estimatedRequests !== undefined) entry.estimatedRequests = estimatedRequests;
  const unmeteredRequests = optionalNonNegativeNumber(value.unmeteredRequests);
  if (unmeteredRequests !== undefined) entry.unmeteredRequests = unmeteredRequests;
  const totalTokens = optionalNonNegativeNumber(value.totalTokens);
  if (totalTokens !== undefined) entry.totalTokens = totalTokens;

  return entry;
}

export function parseSessionHistory(value: unknown): SessionHistoryResponse {
  if (!isRecord(value)) throw new Error("session history must be an object");
  if (!Array.isArray(value.sessions)) throw new Error("session history.sessions must be an array");

  const sessions: SessionHistoryEntry[] = [];
  for (const row of value.sessions) {
    const entry = parseHistorySessionCandidate(row);
    if (entry) sessions.push(entry);
  }

  return {
    generatedAt: requiredNonNegativeNumber(value, "generatedAt", "session history"),
    retentionDays: optionalNonNegativeNumber(value.retentionDays) ?? 30,
    sessions,
  };
}

function parseSessionLogUsage(value: unknown): SessionLogUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  if (!isFiniteNonNegativeNumber(inputTokens) || !isFiniteNonNegativeNumber(outputTokens)) return undefined;

  const usage: SessionLogUsage = { inputTokens, outputTokens };
  const totalTokens = optionalNonNegativeNumber(value.totalTokens);
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  const cachedInputTokens = optionalNonNegativeNumber(value.cachedInputTokens);
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  const cacheReadInputTokens = optionalNonNegativeNumber(value.cacheReadInputTokens);
  if (cacheReadInputTokens !== undefined) usage.cacheReadInputTokens = cacheReadInputTokens;
  const cacheCreationInputTokens = optionalNonNegativeNumber(value.cacheCreationInputTokens);
  if (cacheCreationInputTokens !== undefined) usage.cacheCreationInputTokens = cacheCreationInputTokens;
  const reasoningOutputTokens = optionalNonNegativeNumber(value.reasoningOutputTokens);
  if (reasoningOutputTokens !== undefined) usage.reasoningOutputTokens = reasoningOutputTokens;
  if (value.estimated === true) usage.estimated = true;
  return usage;
}

/**
 * Parse a single projected log row from GET /api/sessions/{id}/logs. Mirrors the server
 * SessionLogEntry contract; strips unknown/private fields and validates required fields.
 */
function parseSessionLog(value: unknown): SessionLog | undefined {
  if (!isRecord(value)) return undefined;

  const requestId = sanitizeIdentityValue(value.requestId);
  if (!requestId) return undefined;
  if (!isFiniteNonNegativeNumber(value.timestamp)) return undefined;
  if (!isFiniteNonNegativeNumber(value.status)) return undefined;
  if (!isFiniteNonNegativeNumber(value.durationMs)) return undefined;

  const usageStatus = value.usageStatus;
  if (!isSessionLogUsageStatus(usageStatus)) return undefined;

  const provider = sanitizeIdentityValue(value.provider);
  const model = sanitizeIdentityValue(value.model);
  if (!provider || !model) return undefined;

  const log: SessionLog = {
    requestId,
    timestamp: value.timestamp,
    status: value.status,
    durationMs: value.durationMs,
    usageStatus,
    provider,
    model,
  };

  const resolvedModel = sanitizeIdentityValue(value.resolvedModel);
  if (resolvedModel) log.resolvedModel = resolvedModel;
  const requestedModel = sanitizeIdentityValue(value.requestedModel);
  if (requestedModel) log.requestedModel = requestedModel;
  const requestedEffort = sanitizeIdentityValue(value.requestedEffort);
  if (requestedEffort) log.requestedEffort = requestedEffort;
  const executionSessionId = sanitizeIdentityValue(value.executionSessionId);
  if (executionSessionId) log.executionSessionId = executionSessionId;
  const requestKind = sanitizeIdentityValue(value.requestKind);
  if (requestKind) log.requestKind = requestKind;
  const subagentKind = sanitizeIdentityValue(value.subagentKind);
  if (subagentKind) log.subagentKind = subagentKind;
  if (value.isSpawnedChild === true) log.isSpawnedChild = true;

  const usage = parseSessionLogUsage(value.usage);
  if (usage) log.usage = usage;
  const totalTokens = optionalNonNegativeNumber(value.totalTokens);
  if (totalTokens !== undefined) log.totalTokens = totalTokens;
  const errorCode = sanitizeIdentityValue(value.errorCode);
  if (errorCode) log.errorCode = errorCode;
  const terminalStatus = sanitizeIdentityValue(value.terminalStatus);
  if (terminalStatus) log.terminalStatus = terminalStatus;
  const closeReason = sanitizeIdentityValue(value.closeReason);
  if (closeReason) log.closeReason = closeReason;

  return log;
}

export function parseSessionLogs(value: unknown): SessionLogResponse {
  if (!isRecord(value)) throw new Error("session logs must be an object");
  if (!Array.isArray(value.logs)) throw new Error("session logs.logs must be an array");

  const rootSessionId = sanitizeIdentityValue(value.rootSessionId);
  const logs: SessionLog[] = [];
  for (const row of value.logs) {
    const log = parseSessionLog(row);
    if (log) logs.push(log);
  }

  return {
    rootSessionId: rootSessionId ?? "",
    retentionDays: optionalNonNegativeNumber(value.retentionDays) ?? 30,
    logs,
  };
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
