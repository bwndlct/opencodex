import type { OcxConfig } from "../types";
import type { CodexAuthContext } from "../codex/auth-context";
import { readConfigDiagnostics, resolveEnvValue, saveConfig } from "../config";
import type { SessionRoutePolicy } from "./session-route-policy";

export type OpenAiDualUpstream = "personal" | "company";

/**
 * Runtime classification of the configured OpenAI secondary (company) source.
 *
 * - `api_key_ready`: an `openai-responses` provider with `authMode="key"` and a
 *   resolved nonblank active `apiKey`.
 * - `api_key_unavailable`: an `openai-responses` provider with `authMode="key"`
 *   whose key is missing or blank/unresolved. Must fail closed — no outbound
 *   unauthenticated request — but the failure stays eligible for pre-first-byte
 *   fallback to the personal (account) pool.
 * - `legacy_passthrough`: an `openai-responses` provider with `authMode="passthrough"`.
 *   Retained for backward compatibility with existing openai-responses+passthrough
 *   dual configs; treated as legacy only.
 * - `invalid`: disabled, missing, canonical `openai`, or wrong adapter/mode.
 */
export type OpenAiSecondarySourceKind =
  | "api_key_ready"
  | "api_key_unavailable"
  | "legacy_passthrough"
  | "invalid";

export interface OpenAiDualAttempt {
  upstream: OpenAiDualUpstream;
  providerName: string;
  excludedAccountIds: ReadonlySet<string>;
}

export interface OpenAiDualAttemptResult {
  response: Response;
  authContext?: CodexAuthContext;
  personalAccountId?: string;
  commit?: () => void;
  discard?: (statusOverride?: number) => void;
}

export interface OpenAiDualResult {
  response: Response;
  upstream: OpenAiDualUpstream;
  fallbackReason?: "all_personal_accounts_unavailable" | "company_upstream_unavailable";
  autoSwitched: boolean;
}

function preflightFailure(cause: unknown): Response {
  const message = cause instanceof Error && cause.name === "TimeoutError"
    ? "OpenAI upstream stalled before first output"
    : "OpenAI upstream closed before first output";
  return Response.json({ error: { type: "upstream_error", message } }, { status: 502 });
}

export function isBareOpenAiModel(value: unknown): value is string {
  return typeof value === "string" && /^(?:gpt-|o1-|o3-|o4-)/.test(value) && !value.includes("/");
}

/**
 * Classify whether a provider can serve as the secondary source. This intentionally
 * accepts any provider name so management APIs can enumerate candidates before one is
 * selected. Never throws; never reads credential values beyond a blank check.
 *
 * Classification rules (in order):
 * - disabled, missing provider, or canonical `openai` → invalid
 * - wrong adapter (not `openai-responses`) → invalid
 * - `authMode="passthrough"` → legacy_passthrough
 * - `authMode="key"` with resolved nonblank active apiKey → api_key_ready
 * - `authMode="key"` without a resolved key → api_key_unavailable
 * - any other authMode → invalid
 */
export function classifyOpenAiSecondarySource(
  config: OcxConfig,
  providerName: string,
): OpenAiSecondarySourceKind {
  const provider = config.providers[providerName];
  if (!provider || provider.disabled === true || providerName === "openai") return "invalid";
  if (provider.adapter !== "openai-responses") return "invalid";
  if (provider.authMode === "passthrough") return "legacy_passthrough";
  if (provider.authMode === "key") {
    const directKey = resolveEnvValue(provider.apiKey);
    if (typeof directKey === "string" && directKey.trim().length > 0) return "api_key_ready";
    return "api_key_unavailable";
  }
  return "invalid";
}

/**
 * Whether the secondary company source is configured as an API-key provider
 * (ready or unavailable), as opposed to legacy passthrough or invalid.
 */
function isOpenAiKeySource(kind: OpenAiSecondarySourceKind): boolean {
  return kind === "api_key_ready" || kind === "api_key_unavailable";
}

export function effectiveOpenAiRoutePolicy(
  config: OcxConfig,
  sessionPolicy: SessionRoutePolicy,
): "personal_first" | "company_first" {
  if (sessionPolicy === "personal_first" || sessionPolicy === "company_first") return sessionPolicy;
  const dual = config.openAiDualUpstream;
  if (dual?.defaultPolicy) return dual.defaultPolicy;
  // Omitted-default behavior is source-aware:
  // - API-key company source defaults to personal_first (account pool preferred).
  // - Legacy passthrough (or absent) keeps the historical company_first default.
  const kind = dual ? classifyOpenAiSecondarySource(config, dual.companyProvider) : "invalid";
  return isOpenAiKeySource(kind) ? "personal_first" : "company_first";
}

/**
 * Effective auto-switch-to-company setting. For API-key company sources the default
 * is `false` (do not persist company_first after personal exhaustion); for legacy
 * passthrough it remains `true` (historical behavior).
 */
export function effectiveOpenAiAutoSwitch(config: OcxConfig): boolean {
  const dual = config.openAiDualUpstream;
  if (!dual) return false;
  const kind = classifyOpenAiSecondarySource(config, dual.companyProvider);
  if (isOpenAiKeySource(kind)) return false;
  if (kind === "legacy_passthrough") return dual.autoSwitchToCompany ?? true;
  return false;
}

function personalFailureCanHop(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 408 || status === 429 || status >= 500;
}

function companyFailureCanHop(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 408 || status === 429 || status >= 500;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* already closed */ }
}

async function preflightCommittedResponse(response: Response): Promise<Response> {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let first;
  try {
    first = await reader.read();
  } catch (cause) {
    try { await reader.cancel(); } catch { /* already failed */ }
    throw cause;
  }
  if (first.done) throw new Error("upstream returned an empty response");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first.value);
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (cause) {
        controller.error(cause);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch { /* already closed */ }
    },
  });
  return new Response(body, response);
}

function personalAccountId(result: OpenAiDualAttemptResult): string | undefined {
  if (result.personalAccountId) return result.personalAccountId;
  return result.authContext?.kind === "pool" || result.authContext?.kind === "main-pool"
    ? result.authContext.accountId
    : undefined;
}

export async function runOpenAiDualUpstream(
  config: OcxConfig,
  sessionPolicy: SessionRoutePolicy,
  attempt: (spec: OpenAiDualAttempt) => Promise<OpenAiDualAttemptResult>,
): Promise<OpenAiDualResult> {
  const dual = config.openAiDualUpstream;
  if (!dual) throw new Error("OpenAI dual-upstream routing is not configured");
  const policy = effectiveOpenAiRoutePolicy(config, sessionPolicy);
  // Classify once for source-aware defaults. The company branch classifies again
  // immediately before each attempt in case live provider configuration changed.
  const companySourceKind = classifyOpenAiSecondarySource(config, dual.companyProvider);
  // Effective auto-switch is source-aware: false for API-key sources, true for legacy.
  const autoSwitchToCompany = effectiveOpenAiAutoSwitch(config);
  const order: OpenAiDualUpstream[] = policy === "personal_first"
    ? ["personal", "company"]
    : ["company", "personal"];
  const excludedAccountIds = new Set<string>();
  let lastFailure: OpenAiDualAttemptResult | undefined;
  let fallbackReason: OpenAiDualResult["fallbackReason"];
  let autoSwitched = false;
  let autoSwitchAfterCompanySuccess = false;

  const persistCompanyFirst = (): void => {
    try {
      const diagnostics = readConfigDiagnostics();
      const persistedConfig = diagnostics.source === "file" ? diagnostics.config : config;
      const persistedDual = persistedConfig.openAiDualUpstream;
      const persistedSourceKind = persistedDual
        ? classifyOpenAiSecondarySource(persistedConfig, persistedDual.companyProvider)
        : "invalid";
      if (diagnostics.error) throw new Error(diagnostics.error);
      if (
        diagnostics.source === "file"
        && (
          !persistedDual
          || persistedDual.companyProvider !== dual.companyProvider
          || persistedSourceKind !== companySourceKind
          || (persistedDual.defaultPolicy ?? (isOpenAiKeySource(companySourceKind) ? "personal_first" : "company_first")) !== (dual.defaultPolicy ?? (isOpenAiKeySource(companySourceKind) ? "personal_first" : "company_first"))
          || (persistedDual.autoSwitchToCompany ?? autoSwitchToCompany) !== (dual.autoSwitchToCompany ?? autoSwitchToCompany)
        )
      ) {
        throw new Error("configuration changed during request");
      }
      const nextDual: NonNullable<OcxConfig["openAiDualUpstream"]> = {
        ...(persistedDual ?? dual),
        defaultPolicy: "company_first",
      };
      saveConfig({ ...persistedConfig, openAiDualUpstream: nextDual });
      config.openAiDualUpstream = nextDual;
      autoSwitched = true;
    } catch (error) {
      console.warn(`[openai-dual] failed to persist company_first: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  for (let upstreamIndex = 0; upstreamIndex < order.length; upstreamIndex += 1) {
    const upstream = order[upstreamIndex]!;
    const hasLaterUpstream = upstreamIndex < order.length - 1;
    if (upstream === "company") {
      const liveCompanySourceKind = classifyOpenAiSecondarySource(config, dual.companyProvider);
      // Fail closed for unavailable or invalid sources. The synthesized 503 stays
      // eligible for pre-first-byte fallback to the personal account pool.
      if (liveCompanySourceKind === "api_key_unavailable" || liveCompanySourceKind === "invalid") {
        lastFailure = {
          response: Response.json(
            { error: { type: "upstream_error", message: "Configured OpenAI secondary source is unavailable" } },
            { status: 503 },
          ),
        };
        fallbackReason = "company_upstream_unavailable";
        continue;
      }
      const result = await attempt({
        upstream,
        providerName: dual.companyProvider,
        excludedAccountIds,
      });
      if (result.response.ok) {
        try {
          const response = await preflightCommittedResponse(result.response);
          result.commit?.();
          if (autoSwitchAfterCompanySuccess) persistCompanyFirst();
          return {
            response,
            upstream,
            ...(fallbackReason ? { fallbackReason } : {}),
            autoSwitched,
          };
        } catch (cause) {
          result.discard?.(502);
          lastFailure = { response: preflightFailure(cause) };
          if (policy !== "company_first") return { response: lastFailure.response, upstream, autoSwitched };
          fallbackReason = "company_upstream_unavailable";
          continue;
        }
      }
      lastFailure = result;
      if (!companyFailureCanHop(result.response.status) || policy !== "company_first") {
        result.commit?.();
        return { response: result.response, upstream, autoSwitched };
      }
      fallbackReason = "company_upstream_unavailable";
      await cancelResponseBody(result.response);
      result.discard?.();
      continue;
    }

    while (true) {
      const result = await attempt({
        upstream,
        providerName: "openai",
        excludedAccountIds,
      });
      const accountId = personalAccountId(result);
      if (result.response.ok) {
        try {
          const response = await preflightCommittedResponse(result.response);
          result.commit?.();
          return {
            response,
            upstream,
            ...(fallbackReason ? { fallbackReason } : {}),
            autoSwitched,
          };
        } catch (cause) {
          result.discard?.(502);
          lastFailure = { response: preflightFailure(cause) };
        }
      }
      if (!result.response.ok) lastFailure = result;
      const failureStatus = result.response.ok ? 502 : result.response.status;
      if (!personalFailureCanHop(failureStatus)) {
        result.commit?.();
        return { response: result.response, upstream, autoSwitched };
      }
      if (!accountId || excludedAccountIds.has(accountId)) {
        if (hasLaterUpstream) {
          await cancelResponseBody(result.response);
          result.discard?.();
        } else {
          result.commit?.();
        }
        break;
      }
      excludedAccountIds.add(accountId);
      await cancelResponseBody(result.response);
      result.discard?.();
    }

    if (policy === "personal_first") {
      fallbackReason = "all_personal_accounts_unavailable";
      if (sessionPolicy === "inherit" && autoSwitchToCompany) {
        autoSwitchAfterCompanySuccess = true;
      }
    }
  }

  return {
    response: lastFailure?.response ?? Response.json({ error: { type: "server_error", message: "No OpenAI upstream available" } }, { status: 502 }),
    upstream: order[order.length - 1]!,
    ...(fallbackReason ? { fallbackReason } : {}),
    autoSwitched,
  };
}
