/**
 * Goal: verify that src/config.ts loads valid OpenAI dual-upstream and max-reasoning settings,
 * while rejecting invalid routing combinations, model lists, and passthrough secret storage.
 * Also verifies that API-key (authMode=key) company providers are accepted alongside legacy passthrough.
 * Strategy: use isolated on-disk configs and assert the public load/diagnostics APIs as a black box.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, getDefaultConfig, loadConfig, readConfigDiagnostics } from "../src/config";

type ProviderConfig = Record<string, unknown>;

type ConfigOverrides = {
  providers?: Record<string, ProviderConfig>;
  withoutProviders?: string[];
  dual?: Record<string, unknown>;
};

let testDir = "";
let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = await mkdtemp(join(tmpdir(), "ocx-dual-config-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) await rm(testDir, { recursive: true, force: true });
  testDir = "";
});

function dualConfig(overrides: ConfigOverrides = {}): Record<string, unknown> {
  const providers: Record<string, ProviderConfig> = {
    openai: {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
    },
    company: {
      adapter: "openai-responses",
      baseUrl: "https://company.example/v1",
      authMode: "passthrough",
    },
    ...overrides.providers,
  };
  for (const name of overrides.withoutProviders ?? []) delete providers[name];

  return {
    port: 10100,
    providers,
    defaultProvider: "openai",
    openAiDualUpstream: {
      companyProvider: "company",
      defaultPolicy: "personal_first",
      autoSwitchToCompany: true,
      ...overrides.dual,
    },
  };
}

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  await Bun.write(getConfigPath(), JSON.stringify(config));
}

function expectSchemaRejected(message: string): void {
  const diagnostics = readConfigDiagnostics();

  expect(diagnostics.source).toBe("fallback");
  expect(diagnostics.error).not.toBeNull();
  expect(diagnostics.error ?? "").toContain(message);
  expect(diagnostics.config).toEqual(getDefaultConfig());
}

describe("OpenAI dual-upstream config validation", () => {
  test("loads a valid dual-upstream config with its routing options", async () => {
    await writeConfig(dualConfig({
      dual: { defaultPolicy: "company_first", autoSwitchToCompany: false },
    }));

    const loaded = loadConfig();

    expect(loaded).toMatchObject({
      defaultProvider: "openai",
      openAiDualUpstream: {
        companyProvider: "company",
        defaultPolicy: "company_first",
        autoSwitchToCompany: false,
      },
    });
  });

  test("accepts both supported default-policy enum values", async () => {
    for (const defaultPolicy of ["personal_first", "company_first"]) {
      await writeConfig(dualConfig({ dual: { defaultPolicy } }));

      const diagnostics = readConfigDiagnostics();

      expect(diagnostics.source).toBe("file");
      expect(diagnostics.error).toBeNull();
      expect(diagnostics.config.openAiDualUpstream?.defaultPolicy).toBe(defaultPolicy);
    }
  });

  test("rejects an unsupported default-policy enum value", async () => {
    await writeConfig(dualConfig({ dual: { defaultPolicy: "round_robin" } }));

    expectSchemaRejected("openAiDualUpstream.defaultPolicy");
  });

  test("rejects a companyProvider that is not configured", async () => {
    await writeConfig(dualConfig({ withoutProviders: ["company"] }));

    expectSchemaRejected("companyProvider must reference a configured provider other than openai");
  });

  test("rejects openai as the companyProvider", async () => {
    await writeConfig(dualConfig({ dual: { companyProvider: "openai" } }));

    expectSchemaRejected("companyProvider must reference a configured provider other than openai");
  });

  test("rejects a companyProvider that does not use openai-responses", async () => {
    await writeConfig(dualConfig({
      providers: {
        company: { adapter: "openai-chat", baseUrl: "https://company.example/v1", authMode: "passthrough" },
      },
    }));

    expectSchemaRejected("companyProvider must use the openai-responses adapter with authMode passthrough");
  });

  test("rejects a companyProvider that does not use passthrough auth", async () => {
    // authMode=key is now accepted (the management layer classifies it as
    // api_key_ready or api_key_unavailable). Only truly unsupported authModes
    // (e.g. "oauth") are still rejected at the config level.
    await writeConfig(dualConfig({
      providers: {
        company: { adapter: "openai-responses", baseUrl: "https://company.example/v1", authMode: "oauth" },
      },
    }));

    expectSchemaRejected("companyProvider must use the openai-responses adapter with authMode passthrough or key");
  });

  test("accepts an API-key company provider with authMode=key", async () => {
    await writeConfig(dualConfig({
      providers: {
        company: {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authMode: "key",
          apiKey: "sk-company-test-key",
        },
      },
    }));

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.config.openAiDualUpstream?.companyProvider).toBe("company");
  });


  test("rejects a personal openai provider that is not canonical forward", async () => {
    for (const openai of [
      { adapter: "openai-chat", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
      { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "passthrough" },
      { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "forward" },
    ]) {
      await writeConfig(dualConfig({ providers: { openai } }));

      expectSchemaRejected("dual upstream requires the canonical openai forward provider");
    }
  });

  test("loads trimmed Luna and GLM max-reasoning model lists and accepts explicit disablement", async () => {
    await writeConfig({
      ...dualConfig(),
      lunaReasoningMaxModels: [" gpt-5.6-luna "],
      glmReasoningMaxModels: [" zai-anthropic/glm-5.2 "],
    });
    expect(loadConfig()).toMatchObject({
      lunaReasoningMaxModels: ["gpt-5.6-luna"],
      glmReasoningMaxModels: ["zai-anthropic/glm-5.2"],
    });

    await writeConfig({
      ...dualConfig(),
      lunaReasoningMaxModels: [],
      glmReasoningMaxModels: [],
    });
    expect(loadConfig()).toMatchObject({
      lunaReasoningMaxModels: [],
      glmReasoningMaxModels: [],
    });
  });

  test("rejects malformed max-reasoning model lists", async () => {
    const invalidLists = [
      { glmReasoningMaxModels: ["   "] },
      { glmReasoningMaxModels: ["x".repeat(257)] },
      { glmReasoningMaxModels: Array.from({ length: 33 }, (_, index) => `provider/model-${index}`) },
      { lunaReasoningMaxModels: [42] },
    ];
    for (const invalid of invalidLists) {
      await writeConfig({ ...dualConfig(), ...invalid });
      expectSchemaRejected(Object.keys(invalid)[0] ?? "ReasoningMaxModels");
    }
  });

  test("rejects passthrough providers that retain an API key or key pool", async () => {
    const secrets = [
      { apiKey: "must-not-persist" },
      { apiKeyPool: [{ id: "company-key", key: "must-not-persist" }] },
    ];
    for (const secret of secrets) {
      await writeConfig(dualConfig({
        providers: {
          company: {
            adapter: "openai-responses",
            baseUrl: "https://company.example/v1",
            authMode: "passthrough",
            ...secret,
          },
        },
      }));
      expectSchemaRejected("passthrough providers must not store API keys");
    }
  });
  test("key-auth company provider can store an API key (passthrough-only restriction does not apply)", async () => {
    await writeConfig(dualConfig({
      providers: {
        company: {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authMode: "key",
          apiKey: "sk-company-test-key",
        },
      },
    }));

    const loaded = loadConfig();
    expect(loaded.providers.company?.authMode).toBe("key");
    expect(loaded.providers.company?.apiKey).toBe("sk-company-test-key");
  });
});
