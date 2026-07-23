import { sanitizeIdentityValue } from "./request-identity";

/**
 * Structural supertype covering every entry shape that carries identity fields:
 * PersistedUsageEntry, RequestLogEntry, and RequestLogContext. Using a structural
 * interface (rather than importing the concrete types) avoids a circular import
 * between usage/log.ts and server/request-log.ts.
 */
interface ProjectableIdentityEntry {
  executionSessionId?: string;
  parentThreadId?: string;
  rootSessionId?: string;
  requestKind?: string;
  subagentKind?: string;
  isSpawnedChild?: boolean;
  resolvedModel?: string;
  requestedModel?: string;
  requestedEffort?: string;
}

/** Structural supertype for entries that carry model-route override fields. */
interface ProjectableOverrideEntry {
  overrideSourceModel?: string;
  overrideTargetModel?: string;
  overrideEffort?: string;
}

/**
 * Truthy-project identity fields from a request-log entry or context.
 * Used by addRequestLog / addFinalRequestLog where the source values are already
 * trusted (RequestLogEntry / RequestLogContext) and need no sanitization.
 */
export function projectIdentityFields(
  entry: ProjectableIdentityEntry,
): Partial<ProjectableIdentityEntry> {
  return {
    ...(entry.executionSessionId ? { executionSessionId: entry.executionSessionId } : {}),
    ...(entry.parentThreadId ? { parentThreadId: entry.parentThreadId } : {}),
    ...(entry.rootSessionId ? { rootSessionId: entry.rootSessionId } : {}),
    ...(entry.requestKind ? { requestKind: entry.requestKind } : {}),
    ...(entry.subagentKind ? { subagentKind: entry.subagentKind } : {}),
    ...(entry.isSpawnedChild !== undefined ? { isSpawnedChild: entry.isSpawnedChild } : {}),
    ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
    ...(entry.requestedModel ? { requestedModel: entry.requestedModel } : {}),
    ...(entry.requestedEffort ? { requestedEffort: entry.requestedEffort } : {}),
  };
}

/** Truthy-project model-route override fields from a request-log entry or context. */
export function projectOverrideFields(
  entry: ProjectableOverrideEntry,
): Partial<ProjectableOverrideEntry> {
  return {
    ...(entry.overrideSourceModel ? { overrideSourceModel: entry.overrideSourceModel } : {}),
    ...(entry.overrideTargetModel ? { overrideTargetModel: entry.overrideTargetModel } : {}),
    ...(entry.overrideEffort ? { overrideEffort: entry.overrideEffort } : {}),
  };
}

/**
 * Sanitize AND project identity + override fields from a raw persisted usage entry.
 * Used by normalizeUsageEntry (usage/log.ts) where the source JSONL line is
 * untrusted and every string identity field must pass through sanitizeIdentityValue
 * before being re-serialized.
 *
 * Differs from projectIdentityFields + projectOverrideFields in two ways:
 *  - string identity/override-model fields are sanitized (trim, length, control chars);
 *  - isSpawnedChild uses a strict typeof "boolean" gate instead of !== undefined.
 */
export function sanitizeAndProjectIdentity(
  entry: ProjectableIdentityEntry & ProjectableOverrideEntry,
): Partial<ProjectableIdentityEntry & ProjectableOverrideEntry> {
  const executionSessionId = sanitizeIdentityValue(entry.executionSessionId);
  const parentThreadId = sanitizeIdentityValue(entry.parentThreadId);
  const rootSessionId = sanitizeIdentityValue(entry.rootSessionId);
  const requestKind = sanitizeIdentityValue(entry.requestKind);
  const subagentKind = sanitizeIdentityValue(entry.subagentKind);
  const requestedModel = sanitizeIdentityValue(entry.requestedModel);
  const requestedEffort = sanitizeIdentityValue(entry.requestedEffort);
  const overrideSourceModel = sanitizeIdentityValue(entry.overrideSourceModel);
  const overrideTargetModel = sanitizeIdentityValue(entry.overrideTargetModel);
  return {
    ...(executionSessionId ? { executionSessionId } : {}),
    ...(parentThreadId ? { parentThreadId } : {}),
    ...(rootSessionId ? { rootSessionId } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(subagentKind ? { subagentKind } : {}),
    ...(typeof entry.isSpawnedChild === "boolean" ? { isSpawnedChild: entry.isSpawnedChild } : {}),
    ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
    ...(requestedModel ? { requestedModel } : {}),
    ...(requestedEffort ? { requestedEffort } : {}),
    ...(overrideSourceModel ? { overrideSourceModel } : {}),
    ...(overrideTargetModel ? { overrideTargetModel } : {}),
    ...(entry.overrideEffort ? { overrideEffort: entry.overrideEffort } : {}),
  };
}
