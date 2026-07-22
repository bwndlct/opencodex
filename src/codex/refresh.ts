import { existsSync, readFileSync } from "node:fs";
import { invalidateCodexModelsCache, syncCatalogModels } from "./catalog";
import type { OcxConfig } from "../types";

export interface CodexCatalogRefreshResult {
  added: number;
  path: string;
  catalogExists: boolean;
  cacheSynced: boolean;
  cacheModels?: readonly Record<string, unknown>[];
}

interface RefreshDeps {
  syncCatalogModels: typeof syncCatalogModels;
  invalidateCodexModelsCache: typeof invalidateCodexModelsCache;
  existsSync: typeof existsSync;
}

const defaultDeps: RefreshDeps = {
  syncCatalogModels,
  invalidateCodexModelsCache,
  existsSync,
};

export function syncCodexModelsCacheFromCatalog(catalogPath: string): void {
  const content = readFileSync(catalogPath, "utf8");
  const catalog = JSON.parse(content);
  invalidateCodexModelsCache(catalog.models ?? catalog);
}

/**
 * Rebuild Codex's on-disk model catalog and write the same client-version projection to the models
 * cache. Recovery-only rows remain in the persistent catalog, but the cache now shares the exact
 * model set and metadata emitted by `/v1/models?client_version`.
 */
export async function refreshCodexModelCatalog(
  config: OcxConfig,
  deps: RefreshDeps = defaultDeps,
): Promise<CodexCatalogRefreshResult> {
  const result = await deps.syncCatalogModels(config);
  const catalogExists = deps.existsSync(result.path);
  if (!catalogExists) return { ...result, catalogExists, cacheSynced: false };
  deps.invalidateCodexModelsCache(result.cacheModels);
  return { ...result, catalogExists, cacheSynced: true };
}
