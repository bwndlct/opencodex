/**
 * Test goal: verify the credential-safe routing settings management contract,
 * including dual-upstream validation and maximum-reasoning model lists.
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
        baseUrl: "https://company.example/v1",
        authMode: "passthrough",
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
    expect(body.companyProviders).toEqual(["company"]);
    expect(body.canEnableDualUpstream).toBe(true);
    expect(body.lunaReasoningMaxModels).toEqual(["gpt-5.6-luna"]);
    expect(body.glmReasoningMaxModels).toEqual(["zai-anthropic/glm-5.2"]);
    expect(body).not.toHaveProperty("apiKey");
    expect(body).not.toHaveProperty("apiKeyPool");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  test("GET requires both personal and company providers before enabling dual upstream", async () => {
    const configValue = config();
    delete configValue.providers.company;
    const response = await call(configValue, "GET");
    const body = await json(response);
    expect(body.companyProviders).toEqual([]);
    expect(body.canEnableDualUpstream).toBe(false);

    const disabledCompany = config();
    disabledCompany.providers.company!.disabled = true;
    const disabledCompanyBody = await json(await call(disabledCompany, "GET"));
    expect(disabledCompanyBody.companyProviders).toEqual([]);
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
    expect(body.openAiDualUpstream).toEqual({ companyProvider: "company", defaultPolicy: "personal_first", autoSwitchToCompany: false });
    expect(body.lunaReasoningMaxModels).toEqual(["gpt-5.6-luna", "custom-luna"]);
    expect(refreshes).toBe(1);
    const persisted = loadConfig();
    expect(persisted.openAiDualUpstream?.defaultPolicy).toBe("personal_first");
    expect(persisted.lunaReasoningMaxModels).toEqual(["gpt-5.6-luna", "custom-luna"]);
  });

  test("null disables dual upstream without changing model policies", async () => {
    const configValue = config();
    configValue.openAiDualUpstream = { companyProvider: "company", defaultPolicy: "company_first" };
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
    expect(configValue.openAiDualUpstream).toEqual({
      companyProvider: "company",
      defaultPolicy: "company_first",
      autoSwitchToCompany: true,
    });

    const noOpResponse = await call(configValue, "PUT", {
      lunaReasoningMaxModels: ["gpt-5.6-luna"],
      glmReasoningMaxModels: ["zai-anthropic/glm-5.2"],
    }, deps);
    expect(noOpResponse.status).toBe(200);
    expect((await json(noOpResponse)).catalogRefreshNeeded).toBe(false);
    expect(refreshes).toBe(0);
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
