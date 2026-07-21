const IDENTITY_VALUE_MAX_LENGTH = 256;
const TURN_METADATA_MAX_LENGTH = 4096;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const SESSION_HEADER_CANDIDATES = [
  "x-codex-session-id",
  "x-codex-thread-id",
  "x-codex-conversation-id",
  "openai-session-id",
  "openai-conversation-id",
  "x-openai-session-id",
  "x-request-session-id",
] as const;

export interface RequestIdentity {
  executionSessionId?: string;
  parentThreadId?: string;
  rootSessionId?: string;
  requestKind?: string;
  subagentKind?: string;
  requestedModel?: string;
  requestedEffort?: string;
  isSpawnedChild: boolean;
}

interface TurnMetadata {
  requestKind?: string;
  subagentKind?: string;
  hasExactThreadSpawnMarker: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeIdentityValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > IDENTITY_VALUE_MAX_LENGTH) return undefined;
  if (CONTROL_CHARACTER_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

function parseTurnMetadata(headers: Headers): TurnMetadata {
  const raw = headers.get("x-codex-turn-metadata");
  if (!raw || raw.length > TURN_METADATA_MAX_LENGTH || CONTROL_CHARACTER_PATTERN.test(raw)) {
    return { hasExactThreadSpawnMarker: false };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { hasExactThreadSpawnMarker: false };
    const requestKind = sanitizeIdentityValue(parsed.request_kind);
    const subagentKind = sanitizeIdentityValue(parsed.subagent_kind);
    return {
      ...(requestKind ? { requestKind } : {}),
      ...(subagentKind ? { subagentKind } : {}),
      hasExactThreadSpawnMarker: parsed.subagent_kind === "thread_spawn",
    };
  } catch {
    return { hasExactThreadSpawnMarker: false };
  }
}

function hasExactSpawnedChildMarker(headerKind: string | null, turnMetadata: TurnMetadata): boolean {
  return headerKind === "collab_spawn" || turnMetadata.hasExactThreadSpawnMarker;
}

function executionSessionIdFromHeaders(headers: Headers): string | undefined {
  for (const header of SESSION_HEADER_CANDIDATES) {
    const value = sanitizeIdentityValue(headers.get(header));
    if (value) return value;
  }
  return undefined;
}

function bodyValue(body: unknown, key: string): unknown {
  return isRecord(body) ? body[key] : undefined;
}

function requestedEffortFromBody(body: unknown): string | undefined {
  const reasoning = bodyValue(body, "reasoning");
  const nestedEffort = isRecord(reasoning)
    ? sanitizeIdentityValue(reasoning.effort)
    : undefined;
  return nestedEffort ?? sanitizeIdentityValue(bodyValue(body, "reasoning_effort"));
}

export function isSpawnedChildRequest(headers: Headers): boolean {
  const turnMetadata = parseTurnMetadata(headers);
  return hasExactSpawnedChildMarker(headers.get("x-openai-subagent"), turnMetadata);
}

export function requestIdentityFrom(headers: Headers, body: unknown): RequestIdentity {
  const executionSessionId = executionSessionIdFromHeaders(headers);
  const snakeParent = sanitizeIdentityValue(bodyValue(body, "parent_thread_id"));
  const parentThreadId = snakeParent ?? sanitizeIdentityValue(bodyValue(body, "parentThreadId"));
  const rootSessionId = parentThreadId ?? executionSessionId;
  const headerSubagentKind = sanitizeIdentityValue(headers.get("x-openai-subagent"));
  const turnMetadata = parseTurnMetadata(headers);
  const subagentKind = headerSubagentKind ?? turnMetadata.subagentKind;
  const requestedModel = sanitizeIdentityValue(bodyValue(body, "model"));
  const requestedEffort = requestedEffortFromBody(body);
  const isSpawnedChild = hasExactSpawnedChildMarker(headers.get("x-openai-subagent"), turnMetadata);

  return {
    ...(executionSessionId ? { executionSessionId } : {}),
    ...(parentThreadId ? { parentThreadId } : {}),
    ...(rootSessionId ? { rootSessionId } : {}),
    ...(turnMetadata.requestKind ? { requestKind: turnMetadata.requestKind } : {}),
    ...(subagentKind ? { subagentKind } : {}),
    ...(requestedModel ? { requestedModel } : {}),
    ...(requestedEffort ? { requestedEffort } : {}),
    isSpawnedChild,
  };
}
