import type { PersistedUsageEntry } from "../usage/log";
import { USAGE_RETENTION_DAYS } from "../usage/retention";
import { usageDisplayTotalTokens } from "../usage/totals";
import { sanitizeIdentityValue } from "./request-identity";
import { threadNameFor } from "./thread-name-index";

export const SESSION_HISTORY_DEFAULT_LIMIT = 100;
export const SESSION_HISTORY_MAX_LIMIT = 500;
export const SESSION_LOG_DEFAULT_LIMIT = 200;
export const SESSION_LOG_MAX_LIMIT = 200;
export const SESSION_RETENTION_DAYS = USAGE_RETENTION_DAYS;

export interface SessionHistorySummary {
  rootSessionId: string;
  threadName?: string;
  lastSeenAt: number;
  requestCount: number;
  measuredRequests: number;
  estimatedRequests: number;
  unmeteredRequests: number;
  totalTokens?: number;
  executionSessionId?: string;
  requestedProvider?: string;
  requestedModel?: string;
  requestedEffort?: string;
  effectiveProvider: string;
  effectiveModel: string;
}

export interface SessionHistoryResponse {
  generatedAt: number;
  retentionDays: number;
  sessions: SessionHistorySummary[];
}

export interface SessionLogEntry {
  requestId: string;
  timestamp: number;
  status: number;
  durationMs: number;
  usageStatus: PersistedUsageEntry["usageStatus"];
  provider: string;
  model: string;
  resolvedModel?: string;
  requestedModel?: string;
  requestedEffort?: string;
  executionSessionId?: string;
  requestKind?: string;
  subagentKind?: string;
  isSpawnedChild?: boolean;
  usage?: PersistedUsageEntry["usage"];
  totalTokens?: number;
  errorCode?: string;
  terminalStatus?: string;
  closeReason?: PersistedUsageEntry["closeReason"];
}

export interface SessionLogResponse {
  rootSessionId: string;
  retentionDays: number;
  logs: SessionLogEntry[];
}

function isMeasuredStatus(status: PersistedUsageEntry["usageStatus"]): boolean {
  return status === "reported" || status === "estimated";
}

export function deriveRequestedProvider(requestedModel: string | undefined): string | undefined {
  if (!requestedModel) return undefined;
  const separator = requestedModel.indexOf("/");
  return separator > 0 ? requestedModel.slice(0, separator) : undefined;
}

export function parseSessionHistoryLimit(raw: string | null): number {
  if (raw === null) return SESSION_HISTORY_DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return SESSION_HISTORY_DEFAULT_LIMIT;
  return Math.min(parsed, SESSION_HISTORY_MAX_LIMIT);
}

export function parseSessionLogLimit(raw: string | null): number {
  if (raw === null) return SESSION_LOG_DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return SESSION_LOG_DEFAULT_LIMIT;
  return Math.min(parsed, SESSION_LOG_MAX_LIMIT);
}

interface Accumulator {
  rootSessionId: string;
  lastSeenAt: number;
  requestCount: number;
  measuredRequests: number;
  estimatedRequests: number;
  unmeteredRequests: number;
  totalTokens: number;
  hasMeasured: boolean;
  latest: PersistedUsageEntry;
}

export function aggregateSessionHistory(
  entries: readonly PersistedUsageEntry[],
  now: number = Date.now(),
  limit: number = SESSION_HISTORY_DEFAULT_LIMIT,
): SessionHistoryResponse {
  const groups = new Map<string, Accumulator>();

  for (const entry of entries) {
    const rootSessionId = sanitizeIdentityValue(entry.rootSessionId);
    if (!rootSessionId) continue;

    let acc = groups.get(rootSessionId);
    if (!acc) {
      acc = {
        rootSessionId,
        lastSeenAt: entry.timestamp,
        requestCount: 0,
        measuredRequests: 0,
        estimatedRequests: 0,
        unmeteredRequests: 0,
        totalTokens: 0,
        hasMeasured: false,
        latest: entry,
      };
      groups.set(rootSessionId, acc);
    }

    acc.requestCount += 1;
    if (entry.timestamp > acc.lastSeenAt) {
      acc.lastSeenAt = entry.timestamp;
      acc.latest = entry;
    }

    if (isMeasuredStatus(entry.usageStatus)) {
      acc.measuredRequests += 1;
      acc.hasMeasured = true;
      if (entry.usageStatus === "estimated") acc.estimatedRequests += 1;
      const tokens = usageDisplayTotalTokens(entry.usage, entry.totalTokens);
      if (typeof tokens === "number") acc.totalTokens += tokens;
    } else {
      acc.unmeteredRequests += 1;
    }
  }

  const sessions: SessionHistorySummary[] = [...groups.values()]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, limit)
    .map(acc => {
      const latest = acc.latest;
      const threadName = threadNameFor(acc.rootSessionId);
      const summary: SessionHistorySummary = {
        rootSessionId: acc.rootSessionId,
        ...(threadName ? { threadName } : {}),
        lastSeenAt: acc.lastSeenAt,
        requestCount: acc.requestCount,
        measuredRequests: acc.measuredRequests,
        estimatedRequests: acc.estimatedRequests,
        unmeteredRequests: acc.unmeteredRequests,
        ...(acc.hasMeasured ? { totalTokens: acc.totalTokens } : {}),
        effectiveProvider: latest.provider,
        effectiveModel: latest.resolvedModel ?? latest.model,
      };
      if (latest.executionSessionId) summary.executionSessionId = latest.executionSessionId;
      if (latest.requestedModel) summary.requestedModel = latest.requestedModel;
      if (latest.requestedEffort) summary.requestedEffort = latest.requestedEffort;
      const requestedProvider = deriveRequestedProvider(latest.requestedModel);
      if (requestedProvider) summary.requestedProvider = requestedProvider;
      return summary;
    });

  return {
    generatedAt: now,
    retentionDays: SESSION_RETENTION_DAYS,
    sessions,
  };
}

export function validateSessionId(decoded: string): string | undefined {
  const sanitized = sanitizeIdentityValue(decoded);
  if (!sanitized || sanitized.includes("/") || sanitized.includes("..")) return undefined;
  return sanitized;
}

export function projectSessionLog(entry: PersistedUsageEntry): SessionLogEntry {
  const projected: SessionLogEntry = {
    requestId: entry.requestId,
    timestamp: entry.timestamp,
    status: entry.status,
    durationMs: entry.durationMs,
    usageStatus: entry.usageStatus,
    provider: entry.provider,
    model: entry.model,
  };

  if (entry.resolvedModel) projected.resolvedModel = entry.resolvedModel;
  if (entry.requestedModel) projected.requestedModel = entry.requestedModel;
  if (entry.requestedEffort) projected.requestedEffort = entry.requestedEffort;
  if (entry.executionSessionId) projected.executionSessionId = entry.executionSessionId;
  if (entry.requestKind) projected.requestKind = entry.requestKind;
  if (entry.subagentKind) projected.subagentKind = entry.subagentKind;
  if (typeof entry.isSpawnedChild === "boolean") projected.isSpawnedChild = entry.isSpawnedChild;
  if (entry.usage) projected.usage = entry.usage;
  if (typeof entry.totalTokens === "number") projected.totalTokens = entry.totalTokens;
  if (entry.errorCode) projected.errorCode = entry.errorCode;
  if (entry.terminalStatus) projected.terminalStatus = entry.terminalStatus;
  if (entry.closeReason) projected.closeReason = entry.closeReason;
  return projected;
}

export function buildSessionLogs(
  entries: readonly PersistedUsageEntry[],
  rootSessionId: string,
  limit: number = SESSION_LOG_DEFAULT_LIMIT,
): SessionLogEntry[] {
  return entries
    .filter(entry => sanitizeIdentityValue(entry.rootSessionId) === rootSessionId)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
    .map(projectSessionLog);
}
