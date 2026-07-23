import {
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexPoolAuthenticationError,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
  type CodexAuthContext,
} from "../codex/auth-context";
import { validateForwardAdmissionCredential } from "./auth-cors";
import { getSessionRoutePolicy, type SessionRoutePolicy } from "./session-route-policy";
import type { CodexAccountMode, OcxConfig } from "../types";

export interface RequestCodexAuthSelection {
  context: CodexAuthContext;
  mode: CodexAccountMode;
  routePolicy: SessionRoutePolicy;
  usedConfiguredFallback: boolean;
}

export function allowsPersonalFirstAuthFallback(error: unknown): boolean {
  return error instanceof CodexPoolAuthenticationError
    || error instanceof CodexAuthContextError
    || error instanceof CodexAccountCooldownError;
}

/**
 * Resolve the Codex auth context for an incoming request, honoring session-route
 * policy and personal-first fallback. rootSessionId is injected via the
 * x-codex-parent-thread-id header so the upstream resolveCodexAuthContext
 * signature (headers, config, mode, excludedAccountIds?) stays unchanged.
 */
export async function resolveRequestCodexAuth(
  headers: Headers,
  config: OcxConfig,
  configuredMode: CodexAccountMode,
  rootSessionId?: string,
  excludedAccountIds?: ReadonlySet<string>,
): Promise<RequestCodexAuthSelection> {
  const routePolicy = getSessionRoutePolicy(rootSessionId);
  const personalFirstOverride = routePolicy === "personal_first" && configuredMode === "direct";
  const initialMode: CodexAccountMode = personalFirstOverride ? "pool" : configuredMode;
  if (initialMode === "direct") validateForwardAdmissionCredential(headers, config);

  const routedHeaders = new Headers(headers);
  if (rootSessionId) routedHeaders.set("x-codex-parent-thread-id", rootSessionId);

  try {
    const context = await resolveCodexAuthContext(routedHeaders, config, initialMode, excludedAccountIds);
    if (isCodexAuthContextUsable(context, config) || !personalFirstOverride) {
      return { context, mode: initialMode, routePolicy, usedConfiguredFallback: false };
    }
  } catch (error) {
    if (!personalFirstOverride || !allowsPersonalFirstAuthFallback(error)) throw error;
  }

  validateForwardAdmissionCredential(headers, config);
  const context = await resolveCodexAuthContext(routedHeaders, config, configuredMode, excludedAccountIds);
  return { context, mode: configuredMode, routePolicy, usedConfiguredFallback: true };
}

export function explicitRequestedProvider(modelId: string): string | undefined {
  const separator = modelId.indexOf("/");
  return separator > 0 ? modelId.slice(0, separator) : undefined;
}
