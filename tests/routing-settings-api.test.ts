/**
 * Test goal: verify the credential-safe routing settings management contract,
 * including Account-vs-API-Key source routing validation and maximum-reasoning model lists.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { handleManagementAPI } from "../src/server/management-api";
import type { ManagementApiDeps } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";

let testHome = "";
let previousHome: string | undefined;

function config(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
      company: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "key",
        apiKey: "company-test-key",
      },
    },
  };
}

function request(method: "GET" | "PUT", body?: unknown): Request {
  return new Request("http://127.0.0.1/api/routing-settings", {
    method,
    ...(body === undefined ? {} : {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
}

async function call(configValue: OcxConfig, method: "GET" | "PUT", body?: unknown, deps: ManagementApiDeps = {}): Promise<Response> {
  const req = request(method, body);
  const response = await handleManagementAPI(req, new URL(req.url), configValue, deps);
  if (!response) throw new Error("management API did not handle routing settings");
  return response;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected JSON object");
  return value;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testHome = mkdtempSync(join(tmpdir(), "ocx-routing-settings-"));
  process.env.OPENCODEX_HOME = testHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
});

describe("/api/routing-settings", () => {
  test("GET returns effective defaults and only provider names", async () => {
    const response = await call(config(), "GET");
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.openAiDualUpstream).toBeNull();
    expect(body.companyProviders).toEqual([]);
    expect(body.apiKeyProviders).toEqual(["company"]);
    expect(body.canEnableDualUpstream).toBe(true);
    expect(body.lunaReasoningMaxModels).toEqual(["gpt-5.6-luna"]);
    expect(body.glmReasoningMaxModels).toEqual(["zai-anthropic/glm-5.2"]);
    expect(body).not.toHaveProperty("apiKey");
    expect(body).not.toHaveProperty("apiKeyPool");
    // No credential material leaks through the DTO.
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("company-test-key");
  });

  test("GET requires both personal and company providers before enabling dual upstream", async () => {
    const configValue = config();
    delete configValue.providers.company;
    const response = await call(configValue, "GET");
    const body = await json(response);
    expect(body.companyProviders).toEqual([]);
    expect(body.apiKeyProviders).toEqual([]);
    expect(body.canEnableDualUpstream).toBe(false);

    const disabledCompany = config();
    disabledCompany.providers.company!.disabled = true;
    const disabledCompanyBody = await json(await call(disabledCompany, "GET"));
    expect(disabledCompanyBody.companyProviders).toEqual([]);
    expect(disabledCompanyBody.apiKeyProviders).toEqual([]);
    expect(disabledCompanyBody.canEnableDualUpstream).toBe(false);

    const disabledPersonal = config();
    disabledPersonal.providers.openai!.disabled = true;
    expect((await json(await call(disabledPersonal, "GET"))).canEnableDualUpstream).toBe(false);
  });

  test("PUT rejects a disabled company provider", async () => {
    const configValue = config();
    configValue.providers.company!.disabled = true;
    const response = await call(configValue, "PUT", {
      openAiDualUpstream: { companyProvider: "company" },
    });
    expect(response.status).toBe(400);
  });

  test("PUT rejects a key-auth provider without a resolved API key", async () => {
    const configValue = config();
    delete configValue.providers.company!.apiKey;
    const response = await call(configValue, "PUT", {
      openAiDualUpstream: { companyProvider: "company" },
    });
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.error).toContain("API key");
  });

  test("PUT rejects a missing provider and a wrong-adapter provider", async () => {
    for (const name of ["missing-provider", "openai"]) {
      const response = await call(config(), "PUT", {
        openAiDualUpstream: { companyProvider: name },
      });
      expect(response.status).toBe(400);
    }

    const wrongAdapter = config();
    wrongAdapter.providers.company!.adapter = "openai-chat";
    const wrongAdapterResponse = await call(wrongAdapter, "PUT", {
      openAiDualUpstream: { companyProvider: "company" },
    });
    expect(wrongAdapterResponse.status).toBe(400);
  });

  test("GET excludes legacy passthrough providers from apiKeyProviders", async () => {
    const configValue = config();
    configValue.providers.legacy = {
      adapter: "openai-responses",
      baseUrl: "https://legacy.example/v1",
      authMode: "passthrough",
    };
    const body = await json(await call(configValue, "GET"));
    expect(body.apiKeyProviders).toEqual(["company"]);
    expect(body.companyProviders).toEqual(["legacy"]);
    expect(body.canEnableDualUpstream).toBe(true);
  });

  test("PUT round-trips dual policy and model lists, then refreshes catalog", async () => {
    const configValue = config();
    let refreshes = 0;
    const response = await call(configValue, "PUT", {
      openAiDualUpstream: {
        companyProvider: "company",
        defaultPolicy: "personal_first",
        autoSwitchToCompany: false,
      },
      lunaReasoningMaxModels: [" gpt-5.6-luna ", "custom-luna"],
      glmReasoningMaxModels: ["zai-anthropic/glm-5.2"],
    }, { refreshCodexCatalog: async () => { refreshes += 1; } });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.catalogRefreshNeeded).toBe(true);
    expect(body.openAiDualUpstream).toMatchObject({
      companyProvider: "company",
      defaultPolicy: "personal_first",
      autoSwitchToCompany: false,
      secondarySourceKind: "api_key_ready",
    });
    expect(body.lunaReasoningMaxModels).toEqual(["gpt-5.6-luna", "custom-luna"]);
    expect(refreshes).toBe(1);
    const persisted = loadConfig();
    expect(persisted.openAiDualUpstream?.defaultPolicy).toBe("personal_first");
    expect(persisted.lunaReasoningMaxModels).toEqual(["gpt-5.6-luna", "custom-luna"]);
  });

  test("PUT new API-key source defaults omitted fields to personal_first and false", async () => {
    const configValue = config();
    const response = await call(configValue, "PUT", {
      openAiDualUpstream: { companyProvider: "company" },
    });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.openAiDualUpstream).toMatchObject({
      companyProvider: "company",
      defaultPolicy: "personal_first",
      autoSwitchToCompany: false,
      secondarySourceKind: "api_key_ready",
    });
    const persisted = loadConfig();
    expect(persisted.openAiDualUpstream).toMatchObject({
      companyProvider: "company",
      defaultPolicy: "personal_first",
      autoSwitchToCompany: false,
    });
  });

  test("PUT rejects permanent automatic priority changes for an API-key source", async () => {
    const response = await call(config(), "PUT", {
      openAiDualUpstream: {
        companyProvider: "company",
        defaultPolicy: "personal_first",
        autoSwitchToCompany: true,
      },
    });
    expect(response.status).toBe(400);
    expect((await json(response)).error).toContain("permanent automatic priority");
  });

  test("null disables dual upstream without changing model policies", async () => {
    const configValue = config();
    configValue.openAiDualUpstream = { companyProvider: "company", defaultPolicy: "company_first", autoSwitchToCompany: true };
    configValue.glmReasoningMaxModels = ["custom/glm"];
    const response = await call(configValue, "PUT", { openAiDualUpstream: null });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.openAiDualUpstream).toBeNull();
    expect(body.glmReasoningMaxModels).toEqual(["custom/glm"]);
    expect(loadConfig().openAiDualUpstream).toBeUndefined();
  });

  test("empty model lists disable both max policies and refresh once", async () => {
    const configValue = config();
    let refreshes = 0;
    const response = await call(configValue, "PUT", {
      lunaReasoningMaxModels: [],
      glmReasoningMaxModels: [],
    }, { refreshCodexCatalog: async () => { refreshes += 1; } });
    const body = await json(response);
    expect(response.status).toBe(200);
    expect(body.lunaReasoningMaxModels).toEqual([]);
    expect(body.glmReasoningMaxModels).toEqual([]);
    expect(body.catalogRefreshNeeded).toBe(true);
    expect(refreshes).toBe(1);
    expect(loadConfig().lunaReasoningMaxModels).toEqual([]);
    expect(loadConfig().glmReasoningMaxModels).toEqual([]);
  });

  test("policy-only and effective no-op model updates do not refresh catalog", async () => {
    const configValue = config();
    let refreshes = 0;
    const deps = { refreshCodexCatalog: async () => { refreshes += 1; } };
    const policyResponse = await call(configValue, "PUT", {
      openAiDualUpstream: { companyProvider: "company" },
    }, deps);
    expect(policyResponse.status).toBe(200);
    expect((await json(policyResponse)).catalogRefreshNeeded).toBe(false);
    expect(configValue.openAiDualUpstream).toMatchObject({
      companyProvider: "company",
      defaultPolicy: "personal_first",
      autoSwitchToCompany: false,
    });

    const noOpResponse = await call(configValue, "PUT", {
      lunaReasoningMaxModels: ["gpt-5.6-luna"],
      glmReasoningMaxModels: ["zai-anthropic/glm-5.2"],
    }, deps);
    expect(noOpResponse.status).toBe(200);
    expect((await json(noOpResponse)).catalogRefreshNeeded).toBe(false);
    expect(refreshes).toBe(0);
  });

  test("legacy passthrough selection is preserved when saving unrelated Luna/GLM settings", async () => {
    // Start with an existing legacy passthrough dual-upstream config.
    const configValue = config();
    configValue.providers.legacy = {
      adapter: "openai-responses",
      baseUrl: "https://legacy.example/v1",
      authMode: "passthrough",
    };
    configValue.openAiDualUpstream = {
      companyProvider: "legacy",
      defaultPolicy: "personal_first",
      autoSwitchToCompany: true,
    };

    // Saving only Luna/GLM settings while re-sending the same legacy selection
    // (with unchanged routing fields) must preserve the legacy dual config.
    const response = await call(configValue, "PUT", {
      openAiDualUpstream: { companyProvider: "legacy", defaultPolicy: "personal_first", autoSwitchToCompany: true },
      lunaReasoningMaxModels: ["gpt-5.6-luna"],
    });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.openAiDualUpstream).toMatchObject({
      companyProvider: "legacy",
      defaultPolicy: "personal_first",
      autoSwitchToCompany: true,
      secondarySourceKind: "legacy_passthrough",
    });
    expect(configValue.openAiDualUpstream).toMatchObject({
      companyProvider: "legacy",
      defaultPolicy: "personal_first",
      autoSwitchToCompany: true,
    });
  });

  test("legacy passthrough routing fields cannot be changed", async () => {
    const configValue = config();
    configValue.providers.legacy = {
      adapter: "openai-responses",
      baseUrl: "https://legacy.example/v1",
      authMode: "passthrough",
    };
    configValue.openAiDualUpstream = {
      companyProvider: "legacy",
      defaultPolicy: "personal_first",
      autoSwitchToCompany: true,
    };

    // Attempting to change defaultPolicy on an existing legacy selection.
    const response = await call(configValue, "PUT", {
      openAiDualUpstream: { companyProvider: "legacy", defaultPolicy: "company_first" },
    });
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.error).toContain("legacy");

    // Live config must be unchanged.
    expect(configValue.openAiDualUpstream).toMatchObject({
      companyProvider: "legacy",
      defaultPolicy: "personal_first",
    });
  });

  test("legacy passthrough can be disabled and replaced with ready API key provider", async () => {
    const configValue = config();
    configValue.providers.legacy = {
      adapter: "openai-responses",
      baseUrl: "https://legacy.example/v1",
      authMode: "passthrough",
    };
    configValue.openAiDualUpstream = {
      companyProvider: "legacy",
      defaultPolicy: "personal_first",
      autoSwitchToCompany: true,
    };

    // Replace legacy with the ready API-key provider.
    const response = await call(configValue, "PUT", {
      openAiDualUpstream: { companyProvider: "company" },
    });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.openAiDualUpstream).toMatchObject({
      companyProvider: "company",
      defaultPolicy: "personal_first",
      autoSwitchToCompany: false,
      secondarySourceKind: "api_key_ready",
    });
  });

  test("legacy passthrough cannot be newly selected", async () => {
    const configValue = config();
    configValue.providers.legacy = {
      adapter: "openai-responses",
      baseUrl: "https://legacy.example/v1",
      authMode: "passthrough",
    };
    // No existing dual-upstream config.
    const response = await call(configValue, "PUT", {
      openAiDualUpstream: { companyProvider: "legacy" },
    });
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.error).toContain("legacy");
  });

  test("save failure leaves live and persisted configuration unchanged", async () => {
    const configValue = config();
    saveConfig(configValue);
    const originalLive = structuredClone(configValue);
    await expect(call(configValue, "PUT", {
      openAiDualUpstream: {
        companyProvider: "company",
        defaultPolicy: "personal_first",
        autoSwitchToCompany: false,
      },
      glmReasoningMaxModels: [],
    }, {
      saveConfig: () => { throw new Error("disk unavailable"); },
    })).rejects.toThrow("disk unavailable");
    expect(configValue).toEqual(originalLive);
    expect(loadConfig()).toEqual(originalLive);
  });

  test("rejects unsupported fields, credentials, invalid provider shape, and bad lists", async () => {
    const cases: unknown[] = [
      { unknown: true },
      { apiKey: "secret" },
      { openAiDualUpstream: { companyProvider: "company", apiKey: "secret" } },
      { openAiDualUpstream: { companyProvider: "company", headers: { Authorization: "secret" } } },
      { openAiDualUpstream: { companyProvider: "missing" } },
      { openAiDualUpstream: { companyProvider: "openai" } },
      { lunaReasoningMaxModels: ["same", "same"] },
      { glmReasoningMaxModels: ["bad\nmodel"] },
      { glmReasoningMaxModels: [42] },
      { glmReasoningMaxModels: ["x".repeat(257)] },
      { glmReasoningMaxModels: Array.from({ length: 33 }, (_, index) => `model-${index}`) },
    ];
    for (const body of cases) {
      const response = await call(config(), "PUT", body);
      expect(response.status).toBe(400);
    }
  });
});
