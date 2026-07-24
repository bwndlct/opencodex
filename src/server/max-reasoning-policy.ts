import type { OcxConfig, OcxParsedRequest } from "../types";

export const DEFAULT_LUNA_REASONING_MAX_MODELS = ["gpt-5.6-luna"] as const;
export const DEFAULT_GLM_REASONING_MAX_MODELS = ["zai-anthropic/glm-5.2"] as const;

const TURN_METADATA_MAX_LENGTH = 4096;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export type MaxReasoningPolicy = "luna" | "glm";

export interface MaxReasoningRewrite {
  policy: MaxReasoningPolicy;
  from?: string;
  to: "max";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configuredModels(configured: string[] | undefined, defaults: readonly string[]): readonly string[] {
  return configured ?? defaults;
}

function includesExactModel(modelId: string, configured: readonly string[]): boolean {
  const requested = modelId.trim();
  return configured.some(model => model.trim() === requested);
}

function policyForModel(modelId: string, config: OcxConfig): MaxReasoningPolicy | null {
  if (includesExactModel(modelId, configuredModels(config.lunaReasoningMaxModels, DEFAULT_LUNA_REASONING_MAX_MODELS))) {
    return "luna";
  }
  if (includesExactModel(modelId, configuredModels(config.glmReasoningMaxModels, DEFAULT_GLM_REASONING_MAX_MODELS))) {
    return "glm";
  }
  return null;
}

function requestKindFromClientMetadata(rawBody: unknown): string | undefined {
  if (!isRecord(rawBody) || !isRecord(rawBody.client_metadata)) return undefined;
  const raw = rawBody.client_metadata["x-codex-turn-metadata"];
  if (
    typeof raw !== "string"
    || raw.length > TURN_METADATA_MAX_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(raw)
  ) {
    return undefined;
  }
  try {
    const metadata: unknown = JSON.parse(raw);
    if (!isRecord(metadata) || typeof metadata.request_kind !== "string") return undefined;
    const requestKind = metadata.request_kind.trim();
    return requestKind && !CONTROL_CHARACTER_PATTERN.test(requestKind) ? requestKind : undefined;
  } catch {
    return undefined;
  }
}

export function forceConfiguredReasoningMax(
  parsed: OcxParsedRequest,
  requestedModelId: string,
  requestKind: string | undefined,
  subagentKind: string | undefined,
  requestedEffort: string | undefined,
  config: OcxConfig,
): MaxReasoningRewrite | null {
  const policy = policyForModel(requestedModelId, config);
  const current = parsed.options.reasoning ?? requestedEffort;
  const effectiveRequestKind = requestKind ?? requestKindFromClientMetadata(parsed._rawBody);
  const isMemoryTurn =
    effectiveRequestKind === "memory" || subagentKind === "memory_consolidation";
  if (
    policy === null
    || current?.toLowerCase() === "max"
    || (policy === "luna" && isMemoryTurn)
    || (policy === "luna" && current?.toLowerCase() === "low")
  ) {
    return null;
  }

  parsed.options.reasoning = "max";
  const raw = parsed._rawBody;
  if (isRecord(raw)) {
    if (raw.reasoning !== undefined && raw.reasoning !== null && !isRecord(raw.reasoning)) {
      parsed.options.reasoning = requestedEffort;
      return null;
    }
    const reasoning = isRecord(raw.reasoning) ? raw.reasoning : {};
    raw.reasoning = { ...reasoning, effort: "max" };
    if (Object.hasOwn(raw, "reasoning_effort")) raw.reasoning_effort = "max";
  }
  return { policy, ...(current ? { from: current } : {}), to: "max" };
}

export function forceMaxCatalogModel(modelId: string, config: OcxConfig): boolean {
  return includesExactModel(
    modelId,
    configuredModels(config.glmReasoningMaxModels, DEFAULT_GLM_REASONING_MAX_MODELS),
  );
}
