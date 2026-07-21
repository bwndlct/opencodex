import { redactSecretString } from "../lib/redact";
import {
  readUsageEntries,
  type AttemptRecoveryKind,
  type PersistedUsageAttempt,
  type PersistedUsageEntry,
} from "../usage/log";
import { sanitizeIdentityValue } from "./request-identity";

export type IncidentSeverity = "error" | "warning";

export interface IncidentAttempt {
  ordinal: number;
  provider: string;
  model: string;
  status: number;
  durationMs: number;
  recoveryKinds: AttemptRecoveryKind[];
  errorCode?: string;
}

export interface Incident {
  requestId: string;
  timestamp: number;
  severity: IncidentSeverity;
  status: number;
  durationMs: number;
  provider: string;
  model: string;
  requestedModel?: string;
  resolvedModel?: string;
  rootSessionId?: string;
  executionSessionId?: string;
  parentThreadId?: string;
  requestKind?: string;
  subagentKind?: string;
  errorCode?: string;
  terminalStatus?: "completed" | "failed" | "incomplete";
  closeReason?: "terminal" | "client_cancel" | "non_stream" | "body_stall" | "body_overflow";
  upstreamError?: string;
  attempts?: IncidentAttempt[];
}

export interface IncidentProjectionOptions {
  limit?: number;
  rootSessionId?: string;
}

export type IncidentEntryReader = () => PersistedUsageEntry[];

export const DEFAULT_INCIDENT_LIMIT = 30;
export const MAX_INCIDENT_LIMIT = 200;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const RECOVERY_KINDS: ReadonlySet<string> = new Set([
  "transient-5xx",
  "connection-reset",
  "oauth-401",
  "key-429",
  "image-413",
]);

function isAttemptRecoveryKind(value: unknown): value is AttemptRecoveryKind {
  return typeof value === "string" && RECOVERY_KINDS.has(value);
}

function safeIdentity(value: unknown): string | undefined {
  const normalized = sanitizeIdentityValue(value);
  return normalized ? redactSecretString(normalized) : undefined;
}

function safeDiagnostic(value: unknown, maxLength = 500): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || CONTROL_CHARACTER_PATTERN.test(normalized)) return undefined;
  return redactSecretString(normalized).slice(0, maxLength);
}

function validStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

function validDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function terminalStatus(value: unknown): Incident["terminalStatus"] {
  switch (value) {
    case "completed":
    case "failed":
    case "incomplete":
      return value;
    default:
      return undefined;
  }
}

function closeReason(value: unknown): Incident["closeReason"] {
  switch (value) {
    case "terminal":
    case "client_cancel":
    case "non_stream":
    case "body_stall":
    case "body_overflow":
      return value;
    default:
      return undefined;
  }
}

function compactAttempt(attempt: PersistedUsageAttempt): IncidentAttempt | undefined {
  if (!Number.isInteger(attempt.ordinal) || attempt.ordinal < 1) return undefined;
  if (!validStatus(attempt.status) || !validDuration(attempt.durationMs)) return undefined;
  const provider = safeIdentity(attempt.provider);
  const model = safeIdentity(attempt.model);
  if (!provider || !model) return undefined;
  const recoveryKinds = Array.isArray(attempt.recoveryKinds)
    ? attempt.recoveryKinds.filter(isAttemptRecoveryKind)
    : [];
  const errorCode = safeIdentity(attempt.errorCode);
  return {
    ordinal: attempt.ordinal,
    provider,
    model,
    status: attempt.status,
    durationMs: attempt.durationMs,
    recoveryKinds: [...new Set(recoveryKinds)],
    ...(errorCode ? { errorCode } : {}),
  };
}

function compactAttempts(entry: PersistedUsageEntry): IncidentAttempt[] {
  if (!Array.isArray(entry.attempts)) return [];
  return entry.attempts
    .map(compactAttempt)
    .filter((attempt): attempt is IncidentAttempt => attempt !== undefined);
}

function normalizedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_INCIDENT_LIMIT;
  return Math.min(MAX_INCIDENT_LIMIT, Math.max(1, Math.trunc(limit)));
}

/** Project one persisted usage row into the intentionally narrow incident DTO. */
export function projectIncident(entry: PersistedUsageEntry): Incident | undefined {
  const requestId = safeIdentity(entry.requestId);
  const provider = safeIdentity(entry.provider);
  const model = safeIdentity(entry.model);
  if (!requestId || !provider || !model) return undefined;
  if (!Number.isFinite(entry.timestamp) || !validStatus(entry.status) || !validDuration(entry.durationMs)) {
    return undefined;
  }

  const attempts = compactAttempts(entry);
  const parentFailed = entry.status >= 400
    || (entry.terminalStatus !== undefined && entry.terminalStatus !== "completed");
  const physicalAttemptFailed = attempts.some(attempt => (
    attempt.status >= 400 || attempt.recoveryKinds.length > 0
  ));
  if (!parentFailed && !physicalAttemptFailed) return undefined;

  const requestedModel = safeIdentity(entry.requestedModel);
  const resolvedModel = safeIdentity(entry.resolvedModel);
  const rootSessionId = safeIdentity(entry.rootSessionId);
  const executionSessionId = safeIdentity(entry.executionSessionId);
  const parentThreadId = safeIdentity(entry.parentThreadId);
  const requestKind = safeIdentity(entry.requestKind);
  const subagentKind = safeIdentity(entry.subagentKind);
  const errorCode = safeIdentity(entry.errorCode);
  const resolvedTerminalStatus = terminalStatus(entry.terminalStatus);
  const resolvedCloseReason = closeReason(entry.closeReason);
  const upstreamError = safeDiagnostic(entry.upstreamError);

  const incident: Incident = {
    requestId,
    timestamp: entry.timestamp,
    severity: parentFailed ? "error" : "warning",
    status: entry.status,
    durationMs: entry.durationMs,
    provider,
    model,
    ...(requestedModel ? { requestedModel } : {}),
    ...(resolvedModel ? { resolvedModel } : {}),
    ...(rootSessionId ? { rootSessionId } : {}),
    ...(executionSessionId ? { executionSessionId } : {}),
    ...(parentThreadId ? { parentThreadId } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(subagentKind ? { subagentKind } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(resolvedTerminalStatus ? { terminalStatus: resolvedTerminalStatus } : {}),
    ...(resolvedCloseReason ? { closeReason: resolvedCloseReason } : {}),
    ...(upstreamError ? { upstreamError } : {}),
    ...(attempts.length > 0 ? { attempts } : {}),
  };
  return incident;
}

/** Purely project, filter, order, and bound already-read usage rows. */
export function projectIncidents(
  entries: readonly PersistedUsageEntry[],
  options: IncidentProjectionOptions = {},
): Incident[] {
  const rootSessionId = options.rootSessionId === undefined
    ? undefined
    : safeIdentity(options.rootSessionId);
  if (options.rootSessionId !== undefined && !rootSessionId) return [];

  const projected: Array<{ incident: Incident; index: number }> = [];
  entries.forEach((entry, index) => {
    const incident = projectIncident(entry);
    if (!incident) return;
    if (rootSessionId !== undefined && incident.rootSessionId !== rootSessionId) return;
    projected.push({ incident, index });
  });
  projected.sort((left, right) => (
    right.incident.timestamp - left.incident.timestamp || right.index - left.index
  ));
  return projected.slice(0, normalizedLimit(options.limit)).map(item => item.incident);
}

export class IncidentHistory {
  constructor(private readonly readEntries: IncidentEntryReader = readUsageEntries) {}

  list(options: IncidentProjectionOptions = {}): Incident[] {
    return projectIncidents(this.readEntries(), options);
  }
}
