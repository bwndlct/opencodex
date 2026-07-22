import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isFixedEffort,
  isNativeOpenAiModel,
  listOverrideSources,
  modelRouteOverrideError,
  modelRouteOverrideIssues,
  normalizeModelRouteOverrides,
  overridesDependingOnCombo,
  overridesDependingOnProvider,
  overridesEnabled,
  resolveModelRouteOverride,
  removeOverrideRule,
} from "../src/model-route-overrides";
import { getConfigPath, readConfigDiagnostics, saveConfig } from "../src/config";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";

function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "zai-anthropic",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
      "zai-anthropic": {
        adapter: "openai-chat",
        baseUrl: "https://api.zai.ai/v1",
        apiKey: "zk-test",
        models: ["glm-5.2"],
      },
    },
    modelRouteOverrides: {
      enabled: true,
      rules: {
        "gpt-5.4": {
          target: "zai-anthropic/glm-5.2",
          effort: "max",
          enabled: true,
        },
      },
    },
    ...overrides,
  };
}

async function withTempHome<T>(run: (dir: string) => Promise<T> | T): Promise<T> {
  const previousHome = process.env.OPENCODEX_HOME;
  const dir = mkdtempSync(join(tmpdir(), "ocx-mro-"));
  process.env.OPENCODEX_HOME = dir;
  try {
    return await run(dir);
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function mroApi(
  config: OcxConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response | null> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleManagementAPI(req, new URL(req.url), config, {
    refreshCodexCatalog: async () => {},
  });
}

async function responseJson(response: Response | null): Promise<Record<string, unknown>> {
  expect(response).not.toBeNull();
  return response!.json() as Promise<Record<string, unknown>>;
}

afterEach(() => {});

describe("isNativeOpenAiModel", () => {
  test("identifies bare GPT and o-series models", () => {
    expect(isNativeOpenAiModel("gpt-5.4")).toBe(true);
    expect(isNativeOpenAiModel("gpt-5.4-mini")).toBe(true);
    expect(isNativeOpenAiModel("o1-preview")).toBe(true);
    expect(isNativeOpenAiModel("o3-mini")).toBe(true);
  });

  test("rejects namespaced and combo ids", () => {
    expect(isNativeOpenAiModel("zai-anthropic/glm-5.2")).toBe(false);
    expect(isNativeOpenAiModel("combo/free")).toBe(false);
    expect(isNativeOpenAiModel("claude-opus-4-6")).toBe(false);
  });
});

describe("overridesEnabled", () => {
  test("true when enabled flag is set", () => {
    expect(overridesEnabled(baseConfig())).toBe(true);
  });

  test("false when disabled, undefined, or missing", () => {
    expect(overridesEnabled(baseConfig({ modelRouteOverrides: { enabled: false, rules: {} } }))).toBe(false);
    expect(overridesEnabled(baseConfig({ modelRouteOverrides: undefined }))).toBe(false);
  });
});

describe("resolveModelRouteOverride — disabled states", () => {
  test("returns null when global override is disabled", () => {
    const config = baseConfig({ modelRouteOverrides: { enabled: false, rules: { "gpt-5.4": { target: "zai-anthropic/glm-5.2" } } } });
    expect(resolveModelRouteOverride(config, "gpt-5.4")).toBeNull();
  });

  test("returns null when rule is disabled", () => {
    const config = baseConfig({
      modelRouteOverrides: {
        enabled: true,
        rules: { "gpt-5.4": { target: "zai-anthropic/glm-5.2", enabled: false } },
      },
    });
    expect(resolveModelRouteOverride(config, "gpt-5.4")).toBeNull();
  });

  test("returns null when no rule matches", () => {
    expect(resolveModelRouteOverride(baseConfig(), "gpt-5.5")).toBeNull();
  });

  test("returns null for direct target requests (bypass)", () => {
    expect(resolveModelRouteOverride(baseConfig(), "zai-anthropic/glm-5.2")).toBeNull();
  });
});

describe("resolveModelRouteOverride — enabled matching", () => {
  test("exact source match resolves to target with fixed effort", () => {
    const result = resolveModelRouteOverride(baseConfig(), "gpt-5.4");
    expect(result).toEqual({
      sourceModel: "gpt-5.4",
      targetModel: "zai-anthropic/glm-5.2",
      effort: "max",
    });
  });

  test("effort defaults to inherit when omitted", () => {
    const config = baseConfig({
      modelRouteOverrides: {
        enabled: true,
        rules: { "gpt-5.4": { target: "zai-anthropic/glm-5.2" } },
      },
    });
    const result = resolveModelRouteOverride(config, "gpt-5.4");
    expect(result?.effort).toBe("inherit");
  });

  test("combo target resolves", () => {
    const config = baseConfig({
      combos: { free: { targets: [{ provider: "zai-anthropic", model: "glm-5.2" }] } },
      modelRouteOverrides: {
        enabled: true,
        rules: { "gpt-5.4": { target: "combo/free" } },
      },
    });
    const result = resolveModelRouteOverride(config, "gpt-5.4");
    expect(result?.targetModel).toBe("combo/free");
  });

  test("source equals target returns null (no self-override)", () => {
    const config = baseConfig({
      modelRouteOverrides: {
        enabled: true,
        rules: { "gpt-5.4": { target: "gpt-5.4" } },
      },
    });
    expect(resolveModelRouteOverride(config, "gpt-5.4")).toBeNull();
  });
});

describe("runtime resolve — no chaining", () => {
  test("resolve fires only once per request and does not chain", () => {
    // Even if a config somehow slips through with a chain (e.g. disabled rule),
    // runtime resolve fires only once: it does NOT re-check the resolved target.
    const config = baseConfig({
      modelRouteOverrides: {
        enabled: true,
        rules: {
          "gpt-5.4": { target: "gpt-5.5", enabled: false },
          "gpt-5.5": { target: "zai-anthropic/glm-5.2" },
        },
      },
    });
    // gpt-5.4 rule is disabled, so no override fires
    expect(resolveModelRouteOverride(config, "gpt-5.4")).toBeNull();
    // gpt-5.5 independently resolves
    const direct = resolveModelRouteOverride(config, "gpt-5.5");
    expect(direct?.targetModel).toBe("zai-anthropic/glm-5.2");
  });
});

describe("config-time chain detection", () => {
  test("chain A→B B→C is rejected at config time", () => {
    const config = baseConfig({
      modelRouteOverrides: {
        enabled: true,
        rules: {
          "gpt-5.4": { target: "gpt-5.5" },
          "gpt-5.5": { target: "zai-anthropic/glm-5.2" },
        },
      },
    });
    const error = modelRouteOverrideError(config);
    expect(error).toContain("chain");
  });

  test("direct cycle A→B B→A is rejected at config time", () => {
    const config = baseConfig({
      modelRouteOverrides: {
        enabled: true,
        rules: {
          "gpt-5.4": { target: "gpt-5.5" },
          "gpt-5.5": { target: "gpt-5.4" },
        },
      },
    });
    const error = modelRouteOverrideError(config);
    expect(error).toContain("chain");
  });

  test("disabled rules are exempt from chain detection", () => {
    const config = baseConfig({
      modelRouteOverrides: {
        enabled: true,
        rules: {
          "gpt-5.4": { target: "gpt-5.5", enabled: false },
          "gpt-5.5": { target: "zai-anthropic/glm-5.2" },
        },
      },
    });
    // No chain error because gpt-5.4 is disabled
    expect(modelRouteOverrideError(config)).toBeNull();
  });
});

describe("source key validation", () => {
  test("rejects namespaced source key", () => {
    const config = baseConfig({
      modelRouteOverrides: {
        enabled: true,
        rules: { "zai-anthropic/glm-5.2": { target: "openai/gpt-5.4" } },
      },
    });
    const error = modelRouteOverrideError(config);
    expect(error).toContain("bare native OpenAI id");
  });

  test("rejects combo source key", () => {
    const config = baseConfig({
      modelRouteOverrides: {
        enabled: true,
        rules: { "combo/free": { target: "zai-anthropic/glm-5.2" } },
      },
    });
    const error = modelRouteOverrideError(config);
    expect(error).toContain("bare native OpenAI id");
  });

  test("rejects whitespace-padded source key", () => {
    const config = baseConfig({
      modelRouteOverrides: {
        enabled: true,
        rules: { " gpt-5.4 ": { target: "zai-anthropic/glm-5.2" } },
      },
    });
    const error = modelRouteOverrideError(config);
    expect(error).toContain("whitespace");
  });

  test("rejects non-OpenAI bare source key", () => {
    const config = baseConfig({
      modelRouteOverrides: {
        enabled: true,
        rules: { "claude-opus-4-6": { target: "zai-anthropic/glm-5.2" } },
      },
    });
    const error = modelRouteOverrideError(config);
    expect(error).toContain("bare native OpenAI id");
  });
});

describe("isFixedEffort", () => {
  test("inherit is not fixed", () => {
    expect(isFixedEffort("inherit")).toBe(false);
  });
  test("all codex efforts are fixed", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"] as const) {
      expect(isFixedEffort(effort)).toBe(true);
    }
  });
});

describe("validation", () => {
  test("valid config has no issues", () => {
    expect(modelRouteOverrideIssues(baseConfig())).toEqual([]);
  });

  test("empty config has no issues", () => {
    expect(modelRouteOverrideIssues(baseConfig({ modelRouteOverrides: undefined }))).toEqual([]);
  });

  test("source equals target is flagged", () => {
    const config = baseConfig({
      modelRouteOverrides: {
        enabled: true,
        rules: { "gpt-5.4": { target: "gpt-5.4" } },
      },
    });
    const error = modelRouteOverrideError(config);
    expect(error).toContain("cannot equal source");
  });

  test("unresolvable target is flagged", () => {
    const config = baseConfig({
      modelRouteOverrides: {
        enabled: true,
        rules: { "gpt-5.4": { target: "nonexistent/model" } },
      },
    });
    const error = modelRouteOverrideError(config);
    expect(error).toContain("not configured");
  });

  test("combo target with missing combo is flagged", () => {
    const config = baseConfig({
      modelRouteOverrides: {
        enabled: true,
        rules: { "gpt-5.4": { target: "combo/nonexistent" } },
      },
    });
    const error = modelRouteOverrideError(config);
    expect(error).toContain("not configured");
  });

  test("invalid effort is flagged", () => {
    const config = baseConfig({
      modelRouteOverrides: {
        enabled: true,
        rules: { "gpt-5.4": { target: "zai-anthropic/glm-5.2", effort: "turbo" as "inherit" } },
      },
    });
    const error = modelRouteOverrideError(config);
    expect(error).toContain("effort");
  });
});

describe("dependency tracking", () => {
  test("overridesDependingOnProvider finds references", () => {
    const config = baseConfig();
    expect(overridesDependingOnProvider(config, "zai-anthropic")).toEqual(["gpt-5.4"]);
    expect(overridesDependingOnProvider(config, "openai")).toEqual([]);
  });

  test("overridesDependingOnCombo finds references", () => {
    const config = baseConfig({
      combos: { free: { targets: [{ provider: "zai-anthropic", model: "glm-5.2" }] } },
      modelRouteOverrides: {
        enabled: true,
        rules: { "gpt-5.4": { target: "combo/free" } },
      },
    });
    expect(overridesDependingOnCombo(config, "free")).toEqual(["gpt-5.4"]);
    expect(overridesDependingOnCombo(config, "other")).toEqual([]);
  });
});

describe("removeOverrideRule", () => {
  test("removes existing rule", () => {
    const config = baseConfig();
    expect(removeOverrideRule(config, "gpt-5.4")).toBe(true);
    expect(listOverrideSources(config)).toEqual([]);
  });

  test("returns false for missing rule", () => {
    const config = baseConfig();
    expect(removeOverrideRule(config, "gpt-5.5")).toBe(false);
  });
});

describe("normalizeModelRouteOverrides", () => {
  test("trims targets and defaults effort/enabled", () => {
    const normalized = normalizeModelRouteOverrides({
      enabled: true,
      rules: {
        "gpt-5.4": { target: "  zai-anthropic/glm-5.2  ", effort: "inherit", enabled: true },
        "gpt-5.5": { target: "zai-anthropic/glm-5.2" },
      },
    });
    expect(normalized.rules["gpt-5.4"]?.target).toBe("zai-anthropic/glm-5.2");
    expect(normalized.rules["gpt-5.5"]?.effort).toBe("inherit");
    expect(normalized.rules["gpt-5.5"]?.enabled).toBe(true);
  });

  test("drops rules with empty targets", () => {
    const normalized = normalizeModelRouteOverrides({
      enabled: true,
      rules: {
        "gpt-5.4": { target: "  " },
        "gpt-5.5": { target: "zai-anthropic/glm-5.2" },
      },
    });
    expect(Object.keys(normalized.rules)).toEqual(["gpt-5.5"]);
  });
});

describe("persisted config validation", () => {
  test("valid overrides load from disk without diagnostics", async () => {
    await withTempHome(async () => {
      const config = baseConfig();
      saveConfig(config);
      const diag = readConfigDiagnostics();
      expect(diag.source).toBe("file");
      expect(diag.error).toBeNull();
      expect(diag.config.modelRouteOverrides).toEqual(config.modelRouteOverrides);
    });
  });

  test("invalid source=target override fails diagnostics", async () => {
    await withTempHome(() => {
      const config = baseConfig({
        modelRouteOverrides: {
          enabled: true,
          rules: { "gpt-5.4": { target: "gpt-5.4" } },
        },
      });
      writeFileSync(getConfigPath(), JSON.stringify(config), "utf8");
      const diag = readConfigDiagnostics();
      expect(diag.source).toBe("fallback");
      expect(diag.error).toContain("cannot equal source");
    });
  });
});

describe("management API", () => {
  test("GET returns the overrides config", async () => {
    await withTempHome(async () => {
      const config = baseConfig();
      saveConfig(config);
      const res = await mroApi(config, "GET", "/api/model-route-overrides");
      expect(res?.status).toBe(200);
      const json = await responseJson(res);
      expect(json.enabled).toBe(true);
      expect(json.rules).toBeDefined();
    });
  });

  test("PUT saves valid overrides", async () => {
    await withTempHome(async () => {
      const config = baseConfig({ modelRouteOverrides: undefined });
      saveConfig(config);
      const res = await mroApi(config, "PUT", "/api/model-route-overrides", {
        enabled: true,
        rules: {
          "gpt-5.4": { target: "zai-anthropic/glm-5.2", effort: "max", enabled: true },
        },
      });
      expect(res?.status).toBe(200);
      const json = await responseJson(res);
      expect(json.success).toBe(true);
      expect(config.modelRouteOverrides?.enabled).toBe(true);
      expect(config.modelRouteOverrides?.rules["gpt-5.4"]?.target).toBe("zai-anthropic/glm-5.2");
    });
  });

  test("PUT rejects invalid overrides without mutation", async () => {
    await withTempHome(async () => {
      const config = baseConfig();
      saveConfig(config);
      const before = JSON.stringify(config.modelRouteOverrides);
      const res = await mroApi(config, "PUT", "/api/model-route-overrides", {
        enabled: true,
        rules: {
          "gpt-5.4": { target: "gpt-5.4" },
        },
      });
      expect(res?.status).toBe(400);
      expect(JSON.stringify(config.modelRouteOverrides)).toBe(before);
    });
  });

  test("PUT rejects malformed rule shape (not an object)", async () => {
    await withTempHome(async () => {
      const config = baseConfig();
      saveConfig(config);
      const res = await mroApi(config, "PUT", "/api/model-route-overrides", {
        enabled: true,
        rules: { "gpt-5.4": "not-an-object" },
      });
      expect(res?.status).toBe(400);
    });
  });

  test("PUT rejects missing target (no silent drop)", async () => {
    await withTempHome(async () => {
      const config = baseConfig();
      saveConfig(config);
      const before = JSON.stringify(config.modelRouteOverrides);
      const res = await mroApi(config, "PUT", "/api/model-route-overrides", {
        enabled: true,
        rules: { "gpt-5.4": { target: "  " } },
      });
      expect(res?.status).toBe(400);
      // Config must be unchanged — normalize must NOT silently drop the invalid rule
      expect(JSON.stringify(config.modelRouteOverrides)).toBe(before);
    });
  });

  test("PUT rejects chain at API boundary", async () => {
    await withTempHome(async () => {
      const config = baseConfig({ modelRouteOverrides: undefined });
      saveConfig(config);
      const res = await mroApi(config, "PUT", "/api/model-route-overrides", {
        enabled: true,
        rules: {
          "gpt-5.4": { target: "gpt-5.5" },
          "gpt-5.5": { target: "zai-anthropic/glm-5.2" },
        },
      });
      expect(res?.status).toBe(400);
      const json = await responseJson(res);
      expect(json.error).toContain("chain");
    });
  });

  test("PUT rejects invalid effort value", async () => {
    await withTempHome(async () => {
      const config = baseConfig();
      saveConfig(config);
      const res = await mroApi(config, "PUT", "/api/model-route-overrides", {
        enabled: true,
        rules: { "gpt-5.4": { target: "zai-anthropic/glm-5.2", effort: "turbo" } },
      });
      expect(res?.status).toBe(400);
    });
  });

  test("PUT with empty rules is valid (disables overrides)", async () => {
    await withTempHome(async () => {
      const config = baseConfig();
      saveConfig(config);
      const res = await mroApi(config, "PUT", "/api/model-route-overrides", {
        enabled: false,
        rules: {},
      });
      expect(res?.status).toBe(200);
    });
  });

  test("provider DELETE blocked by override dependency", async () => {
    await withTempHome(async () => {
      const config = baseConfig({ defaultProvider: "openai" });
      saveConfig(config);
      const res = await mroApi(config, "DELETE", "/api/providers?name=zai-anthropic");
      expect(res?.status).toBe(409);
      const json = await responseJson(res);
      expect(json.overrides).toEqual(["gpt-5.4"]);
    });
  });

  test("combo DELETE blocked by override dependency", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        combos: { free: { targets: [{ provider: "zai-anthropic", model: "glm-5.2" }] } },
        modelRouteOverrides: {
          enabled: true,
          rules: { "gpt-5.4": { target: "combo/free" } },
        },
      });
      saveConfig(config);
      const res = await mroApi(config, "DELETE", "/api/combos?id=free");
      expect(res?.status).toBe(409);
      const json = await responseJson(res);
      expect(json.overrides).toEqual(["gpt-5.4"]);
    });
  });
});
