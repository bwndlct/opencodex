import { isCodexReasoningEffort } from "./reasoning-effort";
import type {
  OcxComboConfig,
  OcxConfig,
  OcxModelRouteOverrideEffort,
  OcxModelRouteOverrideRule,
  OcxModelRouteOverrides,
  OcxProviderConfig,
} from "./types";

export const OVERRIDE_EFFORTS: readonly OcxModelRouteOverrideEffort[] = [
  "inherit", "low", "medium", "high", "xhigh", "max", "ultra",
];

export const FIXED_EFFORTS: readonly OcxModelRouteOverrideEffort[] = [
  "low", "medium", "high", "xhigh", "max", "ultra",
];

export interface ModelRouteOverrideValidationIssue {
  path: Array<string | number>;
  message: string;
}

export interface ModelRouteOverrideResult {
  sourceModel: string;
  targetModel: string;
  effort: OcxModelRouteOverrideEffort;
}

export function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a model id is a bare native OpenAI slug (no "/" prefix), eligible as a source key.
 * Combo ids ("combo/...") and namespaced ids ("provider/model") are NOT valid sources.
 */
export function isNativeOpenAiModel(modelId: string): boolean {
  return !modelId.includes("/") && /^(?:gpt-|o1-|o3-|o4-)/.test(modelId);
}

/**
 * True when the global override is armed (exists AND enabled).
 */
export function overridesEnabled(config: OcxConfig): boolean {
  return config.modelRouteOverrides?.enabled === true;
}

/**
 * Get the raw rule for a source model, or undefined when none exists.
 */
function rawRule(
  overrides: OcxModelRouteOverrides | undefined,
  sourceModel: string,
): OcxModelRouteOverrideRule | undefined {
  if (!overrides || !overrides.rules) return undefined;
  const rule = overrides.rules[sourceModel];
  if (!rule || typeof rule !== "object") return undefined;
  return rule;
}

/**
 * Resolve whether an override should fire for the given source model.
 * Returns the resolved override result, or null when no override applies.
 *
 * Guards:
 * - Global disabled → null
 * - Rule disabled → null
 * - Source must be a bare native OpenAI model → null for namespaced/combo ids
 *   (direct requests for routed targets bypass overrides entirely)
 */
export function resolveModelRouteOverride(
  config: OcxConfig,
  sourceModel: string,
): ModelRouteOverrideResult | null {
  if (!overridesEnabled(config)) return null;
  const overrides = config.modelRouteOverrides;
  if (!overrides) return null;

  const rule = rawRule(overrides, sourceModel);
  if (!rule) return null;
  if (rule.enabled === false) return null;

  const target = typeof rule.target === "string" ? rule.target.trim() : "";
  if (!target) return null;

  // Guard: source must equal target (no-op or misconfigured) — treat as no override.
  if (target === sourceModel) return null;

  const effort: OcxModelRouteOverrideEffort =
    typeof rule.effort === "string" && isOverrideEffort(rule.effort)
      ? rule.effort
      : "inherit";

  return { sourceModel, targetModel: target, effort };
}

export function isOverrideEffort(value: string): value is OcxModelRouteOverrideEffort {
  return (OVERRIDE_EFFORTS as readonly string[]).includes(value);
}

/**
 * True when the override effort should replace the client's effort
 * (i.e. it is a fixed value, not "inherit").
 */
export function isFixedEffort(effort: OcxModelRouteOverrideEffort): effort is Exclude<OcxModelRouteOverrideEffort, "inherit"> {
  return effort !== "inherit" && (FIXED_EFFORTS as readonly string[]).includes(effort);
}

/**
 * Validate the complete modelRouteOverrides config block.
 * Checks structure, rule shapes, source eligibility, target resolvability,
 * self-referencing, and explicit chain/cycle rejection.
 *
 * Chain detection: when an enabled rule's target EXACTLY equals another enabled
 * rule's source key, the override would create a redirect chain (A→B, B→C).
 * This is rejected at config time — not merely prevented at runtime — because a
 * chain indicates a misconfiguration the user should resolve explicitly.
 */
export function modelRouteOverrideIssues(
  config: OcxConfig,
): ModelRouteOverrideValidationIssue[] {
  const issues: ModelRouteOverrideValidationIssue[] = [];
  const overrides = config.modelRouteOverrides;
  if (overrides === undefined) return issues;

  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    issues.push({ path: ["modelRouteOverrides"], message: "modelRouteOverrides must be an object" });
    return issues;
  }
  if (overrides.enabled !== undefined && typeof overrides.enabled !== "boolean") {
    issues.push({ path: ["modelRouteOverrides", "enabled"], message: "modelRouteOverrides.enabled must be a boolean" });
  }
  if (overrides.rules === undefined) {
    return issues;
  }
  if (!overrides.rules || typeof overrides.rules !== "object" || Array.isArray(overrides.rules)) {
    issues.push({ path: ["modelRouteOverrides", "rules"], message: "modelRouteOverrides.rules must be an object" });
    return issues;
  }

  // Collect valid source keys (after source validation) for chain detection.
  const validSources = new Set<string>();

  for (const [sourceModel, rawRule] of Object.entries(overrides.rules)) {
    const path = ["modelRouteOverrides", "rules", sourceModel];

    // Source key validation: must be a bare native OpenAI model id.
    // Rejects namespaced ids, combo ids, whitespace-padded keys, and empty strings.
    if (sourceModel.trim() === "") {
      issues.push({ path, message: "source model key cannot be empty or whitespace-only" });
    } else if (sourceModel !== sourceModel.trim()) {
      issues.push({ path, message: `source model key "${sourceModel}" must not have leading/trailing whitespace` });
    } else if (!isNativeOpenAiModel(sourceModel)) {
      issues.push({
        path,
        message: `source model key "${sourceModel}" must be a bare native OpenAI id (e.g. gpt-5.4), not a namespaced or combo id`,
      });
    } else {
      validSources.add(sourceModel);
    }

    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
      issues.push({ path, message: `override rule for "${sourceModel}" must be an object` });
      continue;
    }
    const rule = rawRule;
    if (typeof rule.target !== "string" || rule.target.trim() === "") {
      issues.push({ path: [...path, "target"], message: `target is required and must be a non-empty string` });
    }
    if (rule.target !== undefined && typeof rule.target === "string" && rule.target.trim() === sourceModel.trim()) {
      issues.push({ path: [...path, "target"], message: `target cannot equal source "${sourceModel}"` });
    }
    if (rule.enabled !== undefined && typeof rule.enabled !== "boolean") {
      issues.push({ path: [...path, "enabled"], message: "enabled must be a boolean" });
    }
    if (rule.effort !== undefined) {
      if (typeof rule.effort !== "string" || !isOverrideEffort(rule.effort)) {
        issues.push({ path: [...path, "effort"], message: `effort must be one of: inherit, low, medium, high, xhigh, max, ultra` });
      }
      if (typeof rule.effort === "string" && rule.effort !== "inherit" && !isCodexReasoningEffort(rule.effort)) {
        issues.push({ path: [...path, "effort"], message: `effort must be a valid reasoning level or "inherit"` });
      }
    }
    // Target resolvability: must be a concrete provider/model, combo/<id>, or bare native model.
    if (typeof rule.target === "string" && rule.target.trim()) {
      const targetIssue = validateTargetResolvable(rule.target.trim(), config);
      if (targetIssue) {
        issues.push({ path: [...path, "target"], message: targetIssue });
      }
    }
  }

  // Chain detection: an enabled rule's target must not equal another enabled rule's source.
  // This catches A→B + B→C chains AND direct cycles A→B + B→A at config time.
  for (const [sourceModel, rawRule] of Object.entries(overrides.rules)) {
    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) continue;
    const rule = rawRule;
    if (rule.enabled === false) continue; // disabled rules are exempt from chain detection
    if (typeof rule.target !== "string") continue;
    const target = rule.target.trim();
    if (!target) continue;
    if (validSources.has(target)) {
      issues.push({
        path: ["modelRouteOverrides", "rules", sourceModel, "target"],
        message: `override chain detected: "${sourceModel}" targets "${target}", which is itself an override source — chains are not allowed`,
      });
    }
  }

  return issues;
}

/**
 * Validate that a target string can be resolved by routeModel.
 * Returns an error message string, or null when valid.
 */
function validateTargetResolvable(target: string, config: OcxConfig): string | null {
  // Combo target: "combo/<id>"
  if (target.startsWith("combo/")) {
    const comboId = target.slice("combo/".length);
    if (!comboId) return `combo target "${target}" has no id`;
    if (!config.combos || !Object.hasOwn(config.combos, comboId)) {
      return `combo target "${target}" is not configured`;
    }
    return null;
  }
  // Namespaced target: "<provider>/<model>"
  const slash = target.indexOf("/");
  if (slash > 0) {
    const provName = target.slice(0, slash);
    if (!config.providers || !Object.hasOwn(config.providers, provName)) {
      return `target provider "${provName}" is not configured`;
    }
    return null;
  }
  // Bare native model target — must be a known bare OpenAI family id or resolve to a provider.
  if (isNativeOpenAiModel(target)) {
    // Bare native targets are valid (they route to the canonical OpenAI provider).
    return null;
  }
  // Unknown bare id: check if any provider has it as defaultModel or in models list.
  for (const prov of Object.values(config.providers ?? {})) {
    if (prov.defaultModel === target) return null;
    if (Array.isArray(prov.models) && prov.models.includes(target)) return null;
  }
  return `target "${target}" does not resolve to any provider, combo, or known model`;
}

/**
 * The first validation issue's message, or null when valid.
 */
export function modelRouteOverrideError(config: OcxConfig): string | null {
  return modelRouteOverrideIssues(config)[0]?.message ?? null;
}

/**
 * Returns the set of override rules that reference a given provider as a target.
 * Used for dependency checks when deleting/renaming a provider.
 */
export function overridesDependingOnProvider(
  config: OcxConfig,
  providerName: string,
): string[] {
  const overrides = config.modelRouteOverrides;
  if (!overrides?.rules) return [];
  return Object.entries(overrides.rules)
    .filter(([, rule]) => {
      const target = typeof rule?.target === "string" ? rule.target.trim() : "";
      const slash = target.indexOf("/");
      return slash > 0 && target.slice(0, slash) === providerName;
    })
    .map(([source]) => source)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Returns the set of override rules that reference a given combo id as a target.
 * Used for dependency checks when deleting/renaming a combo.
 */
export function overridesDependingOnCombo(
  config: OcxConfig,
  comboId: string,
): string[] {
  const overrides = config.modelRouteOverrides;
  if (!overrides?.rules) return [];
  const target = `combo/${comboId}`;
  return Object.entries(overrides.rules)
    .filter(([, rule]) => {
      const t = typeof rule?.target === "string" ? rule.target.trim() : "";
      return t === target;
    })
    .map(([source]) => source)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Remove a single override rule (by source model). Returns true if removed.
 */
export function removeOverrideRule(config: OcxConfig, sourceModel: string): boolean {
  const overrides = config.modelRouteOverrides;
  if (!overrides?.rules || !Object.hasOwn(overrides.rules, sourceModel)) return false;
  delete overrides.rules[sourceModel];
  if (Object.keys(overrides.rules).length === 0) {
    delete config.modelRouteOverrides;
  }
  return true;
}

/**
 * Normalize a raw overrides config: trim targets, default effort to "inherit",
 * default enabled to true for each rule.
 */
export function normalizeModelRouteOverrides(
  raw: { enabled?: boolean; rules?: Record<string, unknown> },
): OcxModelRouteOverrides {
  const rules: Record<string, OcxModelRouteOverrideRule> = {};
  for (const [source, ruleRaw] of Object.entries(raw.rules ?? {})) {
    if (!ruleRaw || typeof ruleRaw !== "object" || Array.isArray(ruleRaw)) continue;
    if (!isStringRecord(ruleRaw)) continue;
    const rule = ruleRaw;
    const target = typeof rule.target === "string" ? rule.target.trim() : "";
    if (!target) continue;
    rules[source] = {
      target,
      effort: typeof rule.effort === "string" && isOverrideEffort(rule.effort) ? rule.effort : "inherit",
      enabled: rule.enabled !== false,
    };
  }
  return {
    enabled: raw.enabled === true,
    rules,
  };
}

/**
 * List all source model ids from the overrides config (sorted).
 */
export function listOverrideSources(config: OcxConfig): string[] {
  return Object.keys(config.modelRouteOverrides?.rules ?? {}).sort((a, b) => a.localeCompare(b));
}
