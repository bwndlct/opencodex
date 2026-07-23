import type { OcxConfig } from "../types";
import { isValidProviderName, saveConfig } from "../config";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import { readUsageEntries } from "../usage/log";
import {
  modelRouteOverrideError,
  normalizeModelRouteOverrides,
  isOverrideEffort,
  isStringRecord,
} from "../model-route-overrides";
import { snapshotDrainState } from "./lifecycle";
import { IncidentHistory, DEFAULT_INCIDENT_LIMIT, MAX_INCIDENT_LIMIT } from "./incidents";
import { buildHealthReport } from "./health";
import { getRequestLogEntries } from "./request-log";
import { sanitizeIdentityValue } from "./request-identity";
import { snapshotRequestActivity } from "./request-activity";
import {
  getSessionRoutePolicy,
  hasSessionRoutePolicy,
  isSessionRoutePolicy,
  normalizeRootSessionId,
  setSessionRoutePolicy,
} from "./session-route-policy";
import { jsonResponse } from "./auth-cors";

// ---------------------------------------------------------------------------
// Fork API handler dependencies (structurally compatible with ManagementApiDeps)
// ---------------------------------------------------------------------------

export interface ForkApiDeps {
  readUsageEntries?: () => ReturnType<typeof readUsageEntries>;
  healthNow?: () => number;
  saveConfig?: (config: OcxConfig) => void;
  refreshCodexCatalog?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Routing settings helpers
// ---------------------------------------------------------------------------

const DEFAULT_ROUTING_LUNA_MODELS = ["gpt-5.6-luna"];
const DEFAULT_ROUTING_GLM_MODELS = ["zai-anthropic/glm-5.2"];
const ROUTING_MODEL_LIST_LIMIT = 32;
const ROUTING_MODEL_ID_LIMIT = 256;

/** Narrow an unknown JSON value to a plain (non-array) object for strict request-body validation. */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function routingCompanyProviders(config: OcxConfig): string[] {
  return Object.entries(config.providers)
    .filter(([name, provider]) => name !== "openai"
      && provider.disabled !== true
      && provider.adapter === "openai-responses"
      && provider.authMode === "passthrough")
    .map(([name]) => name)
    .sort();
}

function routingSettingsDTO(config: OcxConfig): Record<string, unknown> {
  const dual = config.openAiDualUpstream;
  const companyProviders = routingCompanyProviders(config);
  return {
    openAiDualUpstream: dual ? {
      companyProvider: dual.companyProvider,
      defaultPolicy: dual.defaultPolicy ?? "company_first",
      autoSwitchToCompany: dual.autoSwitchToCompany !== false,
    } : null,
    companyProviders,
    canEnableDualUpstream: Boolean(
      config.providers.openai
      && config.providers.openai.disabled !== true
      && isCanonicalOpenAiForwardProvider(config.providers.openai)
      && companyProviders.length > 0,
    ),
    lunaReasoningMaxModels: config.lunaReasoningMaxModels ?? DEFAULT_ROUTING_LUNA_MODELS,
    glmReasoningMaxModels: config.glmReasoningMaxModels ?? DEFAULT_ROUTING_GLM_MODELS,
    lunaReasoningConfigured: config.lunaReasoningMaxModels !== undefined,
    glmReasoningConfigured: config.glmReasoningMaxModels !== undefined,
    appliesTo: "future_requests",
  };
}

function isRoutingPolicy(value: unknown): value is "personal_first" | "company_first" {
  return value === "personal_first" || value === "company_first";
}

function normalizeRoutingModelList(value: unknown, field: string): { models?: string[]; error?: string } {
  if (!Array.isArray(value)) return { error: `${field} must be an array of model ids` };
  if (value.length > ROUTING_MODEL_LIST_LIMIT) return { error: `${field} may contain at most ${ROUTING_MODEL_LIST_LIMIT} model ids` };
  const models: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") return { error: `${field} entries must be strings` };
    const model = raw.trim();
    if (!model || model.length > ROUTING_MODEL_ID_LIMIT || /[\u0000-\u001f\u007f]/.test(model)) {
      return { error: `${field} entries must be nonblank, control-free ids up to ${ROUTING_MODEL_ID_LIMIT} characters` };
    }
    if (seen.has(model)) return { error: `${field} entries must be unique` };
    seen.add(model);
    models.push(model);
  }
  return { models };
}

function sameRoutingModels(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((model, index) => model === right[index]);
}

function routingDualConfigError(config: OcxConfig, value: unknown): string | null {
  if (value === null) return null;
  if (!isPlainRecord(value)) return "openAiDualUpstream must be an object or null";
  const allowed = new Set(["companyProvider", "defaultPolicy", "autoSwitchToCompany"]);
  if (!Object.keys(value).every(key => allowed.has(key))) return "openAiDualUpstream contains an unsupported field";
  if (typeof value.companyProvider !== "string" || !isValidProviderName(value.companyProvider)) {
    return "openAiDualUpstream.companyProvider must be a valid provider name";
  }
  if (value.defaultPolicy !== undefined && !isRoutingPolicy(value.defaultPolicy)) {
    return "openAiDualUpstream.defaultPolicy must be personal_first or company_first";
  }
  if (value.autoSwitchToCompany !== undefined && typeof value.autoSwitchToCompany !== "boolean") {
    return "openAiDualUpstream.autoSwitchToCompany must be a boolean";
  }
  const personal = config.providers.openai;
  if (!personal || personal.disabled === true || !isCanonicalOpenAiForwardProvider(personal)) {
    return "dual upstream requires the canonical personal openai provider";
  }
  const company = config.providers[value.companyProvider];
  if (!company || company.disabled === true || value.companyProvider === "openai") {
    return "openAiDualUpstream.companyProvider must reference an existing company provider";
  }
  if (company.adapter !== "openai-responses" || company.authMode !== "passthrough") {
    return "companyProvider must use the openai-responses adapter with authMode passthrough";
  }
  return null;
}

async function refreshCodexCatalogBestEffort(config: OcxConfig, deps: ForkApiDeps): Promise<void> {
  if (deps.refreshCodexCatalog) return deps.refreshCodexCatalog();
  try {
    const { refreshCodexModelCatalog } = await import("../codex/refresh");
    await refreshCodexModelCatalog(config);
  } catch {
    /* catalog absent */
  }
}

// ---------------------------------------------------------------------------
// Incident query helper
// ---------------------------------------------------------------------------

type IncidentQuery = { limit: number; rootSessionId?: string };
type IncidentQueryResult =
  | { ok: true; query: IncidentQuery }
  | { ok: false; error: "invalid_limit" | "invalid_root_session_id" };

function parseIncidentQuery(url: URL): IncidentQueryResult {
  const rawLimit = url.searchParams.get("limit");
  let limit = DEFAULT_INCIDENT_LIMIT;
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit)) return { ok: false, error: "invalid_limit" };
    const parsed = Number(rawLimit);
    if (!Number.isSafeInteger(parsed)) return { ok: false, error: "invalid_limit" };
    limit = Math.min(MAX_INCIDENT_LIMIT, Math.max(1, parsed));
  }

  const rawRootSessionId = url.searchParams.get("rootSessionId");
  if (rawRootSessionId === null) return { ok: true, query: { limit } };
  const rootSessionId = sanitizeIdentityValue(rawRootSessionId);
  if (!rootSessionId) return { ok: false, error: "invalid_root_session_id" };
  return { ok: true, query: { limit, rootSessionId } };
}

// ---------------------------------------------------------------------------
// Session route-policy path helper
// ---------------------------------------------------------------------------

const SESSION_ROUTE_POLICY_PREFIX = "/api/sessions/";
const SESSION_ROUTE_POLICY_SUFFIX = "/route-policy";

type SessionRoutePolicyPathMatch =
  | { matched: false }
  | { matched: true; rootSessionId?: string };

function matchSessionRoutePolicyPath(pathname: string): SessionRoutePolicyPathMatch {
  if (!pathname.startsWith(SESSION_ROUTE_POLICY_PREFIX) || !pathname.endsWith(SESSION_ROUTE_POLICY_SUFFIX)) {
    return { matched: false };
  }
  const encoded = pathname.slice(SESSION_ROUTE_POLICY_PREFIX.length, -SESSION_ROUTE_POLICY_SUFFIX.length);
  if (!encoded) return { matched: true };
  try {
    const decoded = decodeURIComponent(encoded);
    const rootSessionId = normalizeRootSessionId(decoded);
    return rootSessionId ? { matched: true, rootSessionId } : { matched: true };
  } catch {
    return { matched: true };
  }
}

function isObservedRootSession(rootSessionId: string): boolean {
  if (hasSessionRoutePolicy(rootSessionId)) return true;
  if (snapshotRequestActivity().sessions.some(session => session.rootSessionId === rootSessionId)) return true;
  return getRequestLogEntries().some(entry => entry.rootSessionId === rootSessionId);
}

// ---------------------------------------------------------------------------
// Unified fork endpoint dispatch
// ---------------------------------------------------------------------------

export async function handleForkEndpoints(
  req: Request,
  url: URL,
  config: OcxConfig,
  deps: ForkApiDeps = {},
): Promise<Response | null> {
  // ---- /api/routing-settings ----
  if (url.pathname === "/api/routing-settings" && req.method === "GET") {
    return jsonResponse(routingSettingsDTO(config));
  }

  if (url.pathname === "/api/routing-settings" && req.method === "PUT") {
    let body: unknown;
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(body)) return jsonResponse({ error: "request body must be an object" }, 400);
    const allowed = new Set(["openAiDualUpstream", "lunaReasoningMaxModels", "glmReasoningMaxModels"]);
    if (!Object.keys(body).every(key => allowed.has(key)) || Object.keys(body).length === 0) {
      return jsonResponse({ error: "body contains unsupported fields" }, 400);
    }

    if (Object.hasOwn(body, "openAiDualUpstream")) {
      const error = routingDualConfigError(config, body.openAiDualUpstream);
      if (error) return jsonResponse({ error }, 400);
    }
    const luna = Object.hasOwn(body, "lunaReasoningMaxModels")
      ? normalizeRoutingModelList(body.lunaReasoningMaxModels, "lunaReasoningMaxModels")
      : {};
    if (luna.error) return jsonResponse({ error: luna.error }, 400);
    const glm = Object.hasOwn(body, "glmReasoningMaxModels")
      ? normalizeRoutingModelList(body.glmReasoningMaxModels, "glmReasoningMaxModels")
      : {};
    if (glm.error) return jsonResponse({ error: glm.error }, 400);

    const nextConfig: OcxConfig = { ...config };
    if (Object.hasOwn(body, "openAiDualUpstream")) {
      if (body.openAiDualUpstream === null) delete nextConfig.openAiDualUpstream;
      else if (isPlainRecord(body.openAiDualUpstream)) {
        const current = config.openAiDualUpstream;
        const companyProvider = body.openAiDualUpstream.companyProvider;
        const defaultPolicy = body.openAiDualUpstream.defaultPolicy;
        const autoSwitchToCompany = body.openAiDualUpstream.autoSwitchToCompany;
        nextConfig.openAiDualUpstream = {
          companyProvider: typeof companyProvider === "string" ? companyProvider : current?.companyProvider ?? "",
          defaultPolicy: defaultPolicy === undefined
            ? current?.defaultPolicy ?? "company_first"
            : isRoutingPolicy(defaultPolicy) ? defaultPolicy : current?.defaultPolicy ?? "company_first",
          autoSwitchToCompany: autoSwitchToCompany === undefined
            ? current?.autoSwitchToCompany ?? true
            : typeof autoSwitchToCompany === "boolean" ? autoSwitchToCompany : current?.autoSwitchToCompany ?? true,
        };
      }
    }
    if (luna.models !== undefined) nextConfig.lunaReasoningMaxModels = luna.models;
    if (glm.models !== undefined) nextConfig.glmReasoningMaxModels = glm.models;

    const catalogRefreshNeeded = Boolean(
      (luna.models !== undefined
        && !sameRoutingModels(luna.models, config.lunaReasoningMaxModels ?? DEFAULT_ROUTING_LUNA_MODELS))
      || (glm.models !== undefined
        && !sameRoutingModels(glm.models, config.glmReasoningMaxModels ?? DEFAULT_ROUTING_GLM_MODELS)),
    );

    (deps.saveConfig ?? saveConfig)(nextConfig);
    if (Object.hasOwn(body, "openAiDualUpstream")) {
      if (nextConfig.openAiDualUpstream) config.openAiDualUpstream = nextConfig.openAiDualUpstream;
      else delete config.openAiDualUpstream;
    }
    if (luna.models !== undefined) config.lunaReasoningMaxModels = luna.models;
    if (glm.models !== undefined) config.glmReasoningMaxModels = glm.models;
    if (catalogRefreshNeeded) await refreshCodexCatalogBestEffort(config, deps);
    return jsonResponse({ ok: true, catalogRefreshNeeded, ...routingSettingsDTO(config) });
  }

  // ---- /api/incidents ----
  if (url.pathname === "/api/incidents" && req.method === "GET") {
    const parsedQuery = parseIncidentQuery(url);
    if (!parsedQuery.ok) return jsonResponse({ error: parsedQuery.error }, 400, req, config);
    try {
      return jsonResponse(new IncidentHistory(deps.readUsageEntries).list(parsedQuery.query), 200, req, config);
    } catch {
      return jsonResponse({ error: "incident_history_unavailable" }, 500, req, config);
    }
  }

  // ---- /api/health ----
  if (url.pathname === "/api/health" && req.method === "GET") {
    return jsonResponse(buildHealthReport(config, {
      readEntries: deps.readUsageEntries ?? readUsageEntries,
      now: deps.healthNow?.(),
    }), 200, req, config);
  }

  // ---- /api/sessions/:id/route-policy ----
  const sessionRoutePolicyPath = matchSessionRoutePolicyPath(url.pathname);
  if (sessionRoutePolicyPath.matched) {
    const rootSessionId = sessionRoutePolicyPath.rootSessionId;
    if (!rootSessionId) return jsonResponse({ error: "invalid_session_id" }, 400);
    if (req.method === "GET") {
      return jsonResponse({
        ok: true,
        rootSessionId,
        routePolicy: getSessionRoutePolicy(rootSessionId),
        appliesTo: "future_requests",
      });
    }
    if (req.method === "PUT") {
      let body: unknown;
      try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
      if (!isPlainRecord(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "routePolicy")) {
        return jsonResponse({ error: "routePolicy is required" }, 400);
      }
      if (!isSessionRoutePolicy(body.routePolicy)) {
        return jsonResponse({ error: "routePolicy must be inherit, personal_first, or company_first" }, 400);
      }
      if (!isObservedRootSession(rootSessionId)) {
        return jsonResponse({ error: "session_not_found" }, 404);
      }
      try {
        const result = setSessionRoutePolicy(rootSessionId, body.routePolicy);
        return jsonResponse({
          ok: true,
          rootSessionId,
          routePolicy: result.record.routePolicy,
          appliesTo: "future_requests",
        });
      } catch {
        return jsonResponse({ error: "persist_failed" }, 500);
      }
    }
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  // ---- /api/sessions/active ----
  if (url.pathname === "/api/sessions/active" && req.method === "GET") {
    return jsonResponse(snapshotRequestActivity());
  }

  // ---- /api/model-route-overrides ----
  if (url.pathname === "/api/model-route-overrides" && req.method === "GET") {
    return jsonResponse(config.modelRouteOverrides ?? { enabled: false, rules: {} });
  }

  if (url.pathname === "/api/model-route-overrides" && req.method === "PUT") {
    let rawBody: unknown;
    try { rawBody = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(rawBody)) {
      return jsonResponse({ error: "request body must be an object" }, 400);
    }
    const body: Record<string, unknown> = rawBody;
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return jsonResponse({ error: "enabled must be a boolean" }, 400);
    }
    if (!body.rules || typeof body.rules !== "object" || Array.isArray(body.rules)) {
      return jsonResponse({ error: "rules must be an object" }, 400);
    }
    // STRICT raw-shape validation BEFORE normalize: any malformed rule returns 400.
    // normalizeModelRouteOverrides silently drops invalid entries, so we validate
    // the raw input here to surface errors instead of silently losing data.
    const rawRules: Record<string, unknown> = isStringRecord(body.rules) ? body.rules : {};
    for (const [source, ruleRaw] of Object.entries(rawRules)) {
      if (!ruleRaw || typeof ruleRaw !== "object" || Array.isArray(ruleRaw)) {
        return jsonResponse({ error: `override rule for "${source}" must be an object` }, 400);
      }
      if (!isStringRecord(ruleRaw)) {
        return jsonResponse({ error: `override rule for "${source}" must be an object` }, 400);
      }
      const rule = ruleRaw;
      if (typeof rule.target !== "string" || rule.target.trim() === "") {
        return jsonResponse({ error: `target for "${source}" is required and must be a non-empty string` }, 400);
      }
      if (rule.enabled !== undefined && typeof rule.enabled !== "boolean") {
        return jsonResponse({ error: `enabled for "${source}" must be a boolean` }, 400);
      }
      if (rule.effort !== undefined && (typeof rule.effort !== "string" || !isOverrideEffort(rule.effort))) {
        return jsonResponse({ error: `effort for "${source}" must be one of: inherit, low, medium, high, xhigh, max, ultra` }, 400);
      }
    }
    const overridesInput = {
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      rules: rawRules,
    };
    const normalized = normalizeModelRouteOverrides(overridesInput);
    // Atomic semantic validation: save the old value, set the new one, validate, and revert on failure.
    const previous = config.modelRouteOverrides;
    config.modelRouteOverrides = normalized;
    const error = modelRouteOverrideError(config);
    if (error) {
      config.modelRouteOverrides = previous;
      return jsonResponse({ error }, 400);
    }
    saveConfig(config);
    return jsonResponse({ success: true, modelRouteOverrides: normalized });
  }

  // ---- /api/drain ----
  if (url.pathname === "/api/drain" && req.method === "GET") {
    const snapshot = snapshotDrainState();
    return jsonResponse(snapshot, snapshot.ready ? 200 : 409);
  }

  return null;
}
