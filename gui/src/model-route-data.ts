/**
 * Pure view-model helpers for the Model Routing "native model replacement" tab.
 * No network — transforms GET /api/model-route-overrides into editable rows.
 */

export interface ModelOption {
  provider: string;
  id: string;
  namespaced?: string;
  native?: boolean;
}

export function isNativeGptModel(id: string): boolean {
  return !id.includes("/") && /^(?:gpt-|o1-|o3-|o4-)/.test(id);
}

export function nativeGptModels(models: ModelOption[]): string[] {
  const ids = models
    .filter((model) => (model.native === true || model.provider === "openai") && isNativeGptModel(model.id))
    .map((model) => model.id);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export function targetOptions(models: ModelOption[], combos: { id: string; model: string }[]): string[] {
  const routed = models
    .filter((model) => model.provider !== "combo")
    .map((model) => model.namespaced ?? `${model.provider}/${model.id}`);
  const comboIds = combos.map((combo) => combo.model);
  return [...new Set([...routed, ...comboIds])].sort((a, b) => a.localeCompare(b));
}

export type OverrideEffort = "inherit" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export const OVERRIDE_EFFORTS: OverrideEffort[] = ["inherit", "low", "medium", "high", "xhigh", "max", "ultra"];

export interface OverrideRuleItem {
  source: string;
  target: string;
  effort: OverrideEffort;
  enabled: boolean;
}

export interface ModelRouteOverridesState {
  enabled: boolean;
  rules: OverrideRuleItem[];
}

export function parseModelRouteOverrides(payload: unknown): ModelRouteOverridesState {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { enabled: false, rules: [] };
  }
  const raw = payload as Record<string, unknown>;
  const enabled = raw.enabled === true;
  const rulesRaw = raw.rules;
  if (!rulesRaw || typeof rulesRaw !== "object" || Array.isArray(rulesRaw)) {
    return { enabled, rules: [] };
  }
  const rules: OverrideRuleItem[] = [];
  for (const [source, ruleRaw] of Object.entries(rulesRaw as Record<string, unknown>)) {
    if (!ruleRaw || typeof ruleRaw !== "object" || Array.isArray(ruleRaw)) continue;
    const rule = ruleRaw as Record<string, unknown>;
    const target = typeof rule.target === "string" ? rule.target.trim() : "";
    if (!target) continue;
    const effort = typeof rule.effort === "string" && (OVERRIDE_EFFORTS as string[]).includes(rule.effort)
      ? (rule.effort as OverrideEffort)
      : "inherit";
    rules.push({
      source,
      target,
      effort,
      enabled: rule.enabled !== false,
    });
  }
  return {
    enabled,
    rules: rules.sort((a, b) => a.source.localeCompare(b.source)),
  };
}

export function toPutBody(state: ModelRouteOverridesState): {
  enabled: boolean;
  rules: Record<string, { target: string; effort: OverrideEffort; enabled: boolean }>;
} {
  const rules: Record<string, { target: string; effort: OverrideEffort; enabled: boolean }> = {};
  for (const rule of state.rules) {
    rules[rule.source] = {
      target: rule.target.trim(),
      effort: rule.effort,
      enabled: rule.enabled,
    };
  }
  return { enabled: state.enabled, rules };
}

export function emptyOverrideRule(): OverrideRuleItem {
  return { source: "", target: "", effort: "inherit", enabled: true };
}

export function stateEquals(a: ModelRouteOverridesState, b: ModelRouteOverridesState): boolean {
  if (a.enabled !== b.enabled) return false;
  if (a.rules.length !== b.rules.length) return false;
  return a.rules.every((rule, i) => {
    const other = b.rules[i];
    return !!other
      && rule.source === other.source
      && rule.target === other.target
      && rule.effort === other.effort
      && rule.enabled === other.enabled;
  });
}
