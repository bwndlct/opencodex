import { sanitizeIdentityValue } from "./request-identity";

export interface RequestActivityIdentity {
  rootSessionId?: string;
  executionSessionId?: string;
}

export interface RequestActivitySession {
  rootSessionId: string;
  activeRequests: number;
  executionSessionIds: string[];
  oldestStartedAt: number;
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
}

const activeRequestById = new Map<string, ActiveRequest>();

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

export function snapshotRequestActivity(generatedAt = Date.now()): RequestActivitySnapshot {
  const sessions = new Map<string, {
    activeRequests: number;
    executionSessionIds: Set<string>;
    oldestStartedAt: number;
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
      })),
  };
}

/** Test-only process-state reset. */
export function resetRequestActivityForTests(): void {
  activeRequestById.clear();
}
