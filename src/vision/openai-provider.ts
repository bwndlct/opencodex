import { copyPassthroughHeaders } from "../adapters/openai-responses";
import { resolveEnvValue } from "../config";
import type { OcxConfig, OcxProviderConfig } from "../types";
import {
  listOpenAiForwardSidecarCandidates,
  resolveFirstUsableOpenAiSidecar,
  type ResolvedOpenAiForwardSidecar,
} from "../providers/openai-sidecar";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import type { SidecarOutcomeRecorder } from "../web-search/executor";

export interface OpenAiVisionProviderOption {
  name: string;
}

export interface ResolvedOpenAiVisionSidecar {
  providerName: string;
  provider: OcxProviderConfig;
  headers: Headers;
  recordOutcome?: SidecarOutcomeRecorder;
}

function isKeyAuthProvider(provider: OcxProviderConfig): boolean {
  // Omitted authMode has always meant key auth for OpenAI Responses providers.
  return provider.authMode === undefined || provider.authMode === "key";
}

function resolvedApiKey(provider: OcxProviderConfig): string | undefined {
  return resolveEnvValue(provider.apiKey)?.trim() || undefined;
}

function eligibleVisionProvider(provider: OcxProviderConfig | undefined): provider is OcxProviderConfig {
  if (!provider || provider.disabled === true || provider.adapter !== "openai-responses") return false;
  if (provider.authMode === "passthrough") return true;
  if (provider.authMode === "forward") return isCanonicalOpenAiForwardProvider(provider);
  return isKeyAuthProvider(provider) && !!resolvedApiKey(provider);
}

export function listOpenAiVisionProviders(config: OcxConfig): OpenAiVisionProviderOption[] {
  return Object.entries(config.providers)
    .filter(([, provider]) => eligibleVisionProvider(provider))
    .map(([name]) => ({ name }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function resolveOpenAiVisionSidecar(
  config: OcxConfig,
  incomingHeaders: Headers,
  fallback?: ResolvedOpenAiForwardSidecar,
): Promise<ResolvedOpenAiVisionSidecar | undefined> {
  const explicitName = config.visionSidecar?.provider;
  if (!explicitName) return fallback;

  const provider = config.providers[explicitName];
  if (!eligibleVisionProvider(provider)) return undefined;
  if (provider.authMode === "passthrough") {
    const headers = new Headers();
    copyPassthroughHeaders(headers, incomingHeaders);
    return { providerName: explicitName, provider, headers };
  }

  if (isKeyAuthProvider(provider)) {
    const apiKey = resolvedApiKey(provider);
    if (!apiKey) return undefined;
    return {
      providerName: explicitName,
      provider,
      // Key-auth sidecars must never inherit the caller's Authorization or account identity.
      headers: new Headers({ authorization: `Bearer ${apiKey}` }),
    };
  }

  if (fallback?.providerName === explicitName) return fallback;
  const candidates = listOpenAiForwardSidecarCandidates(config)
    .filter(candidate => candidate.providerName === explicitName);
  return resolveFirstUsableOpenAiSidecar(candidates, incomingHeaders, config);
}
