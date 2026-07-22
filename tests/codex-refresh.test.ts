import { describe, expect, test } from "bun:test";
import { refreshCodexModelCatalog } from "../src/codex/refresh";
import type { OcxConfig } from "../src/types";

const config = {
  port: 10100,
  defaultProvider: "openai",
  providers: {},
} as OcxConfig;

describe("Codex catalog refresh", () => {
  test("writes an expired Codex models cache whenever the materialized catalog exists", async () => {
    let invalidated = 0;
    let cachedModels: readonly Record<string, unknown>[] | undefined;
    const result = await refreshCodexModelCatalog(config, {
      syncCatalogModels: async () => ({
        added: 0,
        path: "/tmp/opencodex-catalog.json",
        cacheModels: [{ slug: "gpt-5.6-luna", visibility: "list" }],
      }),
      invalidateCodexModelsCache: models => {
        invalidated += 1;
        cachedModels = models;
      },
      existsSync: () => true,
    });

    expect(result).toMatchObject({
      added: 0,
      path: "/tmp/opencodex-catalog.json",
      catalogExists: true,
      cacheSynced: true,
    });
    expect(invalidated).toBe(1);
    expect(cachedModels).toEqual([{ slug: "gpt-5.6-luna", visibility: "list" }]);
  });

  test("does not touch the cache when no Codex catalog can be materialized", async () => {
    let invalidated = 0;
    const result = await refreshCodexModelCatalog(config, {
      syncCatalogModels: async () => ({ added: 0, path: "/tmp/missing-catalog.json" }),
      invalidateCodexModelsCache: () => { invalidated += 1; },
      existsSync: () => false,
    });

    expect(result.catalogExists).toBe(false);
    expect(result.cacheSynced).toBe(false);
    expect(invalidated).toBe(0);
  });
});
