/**
 * Catalog-shaped projection layer for the client_version endpoint and the on-disk models cache.
 *
 * The persistent on-disk catalog (managed by catalog.ts) may retain recovery-only rows and
 * disabled natives; this module builds the exact model set that `/v1/models?client_version`
 * and the models cache should expose — the current native catalog shape plus currently
 * selectable routed models.
 *
 * Extracted from catalog.ts to keep upstream-facing functions at their baseline signatures.
 */
import {
  applyNativeVisibility,
  buildCatalogEntries,
  disabledNativeSlugs,
  DOCUMENTED_NATIVE_OPENAI_ADDITIONS,
  exactComboCatalogSlugs,
  filterCatalogVisibleModels,
  invalidateCodexModelsCache,
  listCatalogNativeSlugs,
  loadCatalogTemplate,
  NATIVE_OPENAI_MODELS,
  orderForSubagents,
  activeCodexModelsCachePath,
} from "./catalog";
import type {
  CatalogModel,
  MultiAgentMode,
  RawEntry,
} from "./catalog";
import { atomicWriteFile, websocketsEnabled } from "../config";
import type { OcxConfig } from "../types";

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Native slugs for the catalog-shaped projection. Merges the live Codex catalog's bare slugs
 * (listCatalogNativeSlugs already layers in documented additions) with the static fallback set
 * so every supported native appears even when the live catalog has it disabled (hidden). This
 * guarantees restore/re-enable symmetry: applyNativeVisibility flips disabled rows to "hide"
 * rather than removing them.
 */
export function nativeSlugsForProjection(): string[] {
  return unique([
    ...listCatalogNativeSlugs(),
    ...NATIVE_OPENAI_MODELS,
    ...DOCUMENTED_NATIVE_OPENAI_ADDITIONS,
  ]);
}

/**
 * All supported bare (non-routed) native slugs from the given catalog-shaped models, including
 * hidden rows. Upstream filterSupportedNativeSlugs only returns picker-visible (visibility
 * === "list") entries; this wrapper relaxes the visibility gate so disabled-but-supported
 * natives are retained in catalog-shaped projections.
 */
export function filterSlugsWithHidden(models: readonly RawEntry[]): string[] {
  const supported = new Set(NATIVE_OPENAI_MODELS);
  return models
    .filter(m => {
      const slug = m.slug;
      return typeof slug === "string" && !slug.includes("/") && supported.has(slug);
    })
    .map(m => m.slug as string);
}

/**
 * Build the exact Codex catalog projection shared by the client_version endpoint and the on-disk
 * models cache. The persistent catalog may retain recovery-only rows, but this projection contains
 * only the current native catalog shape plus currently selectable routed models.
 */
export function buildCodexCatalogEntries(
  config: OcxConfig,
  routedModels: CatalogModel[],
  template: RawEntry | null = loadCatalogTemplate(),
): RawEntry[] {
  const visibleRouted = filterCatalogVisibleModels(routedModels, config);
  const featured = config.subagentModels ?? [];
  const orderedRouted = orderForSubagents(visibleRouted, featured);
  const multiAgentMode: MultiAgentMode = config.multiAgentMode === "v1" || config.multiAgentMode === "v2"
    ? config.multiAgentMode
    : "default";
  const exactComboSlugs = exactComboCatalogSlugs(config);
  const entries = buildCatalogEntries(
    template,
    nativeSlugsForProjection(),
    orderedRouted,
    featured,
    websocketsEnabled(config),
    multiAgentMode,
    exactComboSlugs,
  );
  return applyNativeVisibility(entries, disabledNativeSlugs(config));
}

/**
 * Refresh Codex's models cache from a pre-computed projection. When `models` is provided, writes
 * that projection directly to the cache with the standard wrapper shape (fetched_at /
 * client_version). When omitted, delegates to upstream invalidateCodexModelsCache which reads
 * from the on-disk catalog.
 */
export function invalidateCacheWithProjection(models?: readonly RawEntry[]): void {
  try {
    if (models === undefined) {
      invalidateCodexModelsCache();
      return;
    }
    const wrapper = {
      fetched_at: "2000-01-01T00:00:00Z",
      client_version: "0.0.0",
      models,
    };
    atomicWriteFile(activeCodexModelsCachePath(), JSON.stringify(wrapper, null, 2) + "\n");
  } catch { /* best-effort */ }
}
