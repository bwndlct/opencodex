/**
 * Test goal: verify the management API's company passthrough contract. POST and PATCH may
 * persist authMode "passthrough" only for the OpenAI Responses adapter and never with stored
 * API keys; GET exposes that mode, the connectivity test skips upstream /models, and API-key
 * management excludes it. Rejected writes must leave live and persisted configuration intact.
 * Strategy: exercise the public handler with isolated config persistence and a fetch sentinel.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const originalFetch = globalThis.fetch;
let previousHome: string | undefined;
let temporaryHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env.OPENCODEX_HOME;
  temporaryHome = await mkdtemp(join(tmpdir(), "ocx-passthrough-management-"));
  process.env.OPENCODEX_HOME = temporaryHome;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (temporaryHome) await rm(temporaryHome, { recursive: true, force: true });
  previousHome = undefined;
  temporaryHome = undefined;
});

function companyProvider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-responses",
    baseUrl: "https://company.example/v1",
    ...overrides,
  };
}

function config(providers: OcxConfig["providers"]): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: Object.keys(providers)[0] ?? "company",
    providers,
  };
}

function startManagementServer(liveConfig: OcxConfig): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async request => (await handleManagementAPI(
      request,
      new URL(request.url),
      liveConfig,
      { refreshCodexCatalog: async () => {} },
    )) ?? new Response("not found", { status: 404 }),
  });
}

async function withManagementServer<T>(liveConfig: OcxConfig, run: (server: ReturnType<typeof Bun.serve>) => Promise<T>): Promise<T> {
  const server = startManagementServer(liveConfig);
  try {
    return await run(server);
  } finally {
    await server.stop(true);
  }
}

async function management(
  server: ReturnType<typeof Bun.serve>,
  path: string,
  method: "GET" | "POST" | "PATCH",
  body?: unknown,
): Promise<Response> {
  const response = await originalFetch(new URL(path, server.url), {
    method,
    headers: {
      host: "localhost:10100",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return response;
}

describe("company passthrough management API", () => {
  test("POST and PATCH accept passthrough only with the openai-responses adapter", async () => {
    const liveConfig = config({
      seed: { adapter: "openai-chat", baseUrl: "https://seed.example/v1" },
      company: companyProvider(),
    });

    await withManagementServer(liveConfig, async server => {
      const created = await management(server, "/api/providers", "POST", {
        name: "new-company",
        provider: companyProvider({ authMode: "passthrough" }),
      });
      expect(created.status).toBe(200);
      expect(liveConfig.providers["new-company"]).toMatchObject({
        adapter: "openai-responses",
        authMode: "passthrough",
      });

      const patched = await management(server, "/api/providers?name=company", "PATCH", {
        authMode: "passthrough",
      });
      expect(patched.status).toBe(200);
      expect(liveConfig.providers.company.authMode).toBe("passthrough");

      const rejectedPost = await management(server, "/api/providers", "POST", {
        name: "bad-post",
        provider: { adapter: "openai-chat", baseUrl: "https://bad-post.example/v1", authMode: "passthrough" },
      });
      expect(rejectedPost.status).toBe(400);
      expect(await rejectedPost.json()).toMatchObject({
        error: expect.stringContaining('authMode "passthrough" requires the openai-responses adapter'),
      });

      const rejectedPatch = await management(server, "/api/providers?name=seed", "PATCH", {
        authMode: "passthrough",
      });
      expect(rejectedPatch.status).toBe(400);
      expect(await rejectedPatch.json()).toMatchObject({
        error: expect.stringContaining('authMode "passthrough" requires the openai-responses adapter'),
      });
    });
  });

  test("POST rejects passthrough providers with apiKey or apiKeyPool without persisting them", async () => {
    const liveConfig = config({
      seed: { adapter: "openai-chat", baseUrl: "https://seed.example/v1" },
    });
    saveConfig(liveConfig);
    const originalConfig = structuredClone(liveConfig);
    const attempts = [
      {
        name: "with-api-key",
        provider: companyProvider({ authMode: "passthrough", apiKey: "post-secret" }),
      },
      {
        name: "with-api-key-pool",
        provider: companyProvider({
          authMode: "passthrough",
          apiKeyPool: [{ id: "post-pool-key", key: "post-pool-secret" }],
        }),
      },
    ];

    await withManagementServer(liveConfig, async server => {
      for (const attempt of attempts) {
        const response = await management(server, "/api/providers", "POST", attempt);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: `provider ${attempt.name} authMode "passthrough" must not store API keys`,
        });
        expect(liveConfig).toEqual(originalConfig);
        expect(loadConfig()).toEqual(originalConfig);
      }
    });
  });

  test("PATCH rejects converting providers with stored key material to passthrough without mutation", async () => {
    const liveConfig = config({
      withApiKey: companyProvider({ authMode: "key", apiKey: "stored-secret" }),
      withApiKeyPool: companyProvider({
        authMode: "key",
        apiKeyPool: [{ id: "stored-pool-key", key: "stored-pool-secret" }],
      }),
    });
    saveConfig(liveConfig);
    const originalConfig = structuredClone(liveConfig);

    await withManagementServer(liveConfig, async server => {
      for (const name of ["withApiKey", "withApiKeyPool"]) {
        const response = await management(server, `/api/providers?name=${name}`, "PATCH", {
          authMode: "passthrough",
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: `provider ${name} authMode "passthrough" must not store API keys`,
        });
        expect(liveConfig).toEqual(originalConfig);
        expect(loadConfig()).toEqual(originalConfig);
      }
    });
  });

  test("GET /api/providers exposes authMode for passthrough providers", async () => {
    const liveConfig = config({
      company: companyProvider({ authMode: "passthrough" }),
      keyed: { adapter: "openai-chat", baseUrl: "https://keyed.example/v1", authMode: "key", apiKey: "key-secret" },
    });

    await withManagementServer(liveConfig, async server => {
      const response = await management(server, "/api/providers", "GET");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "company", adapter: "openai-responses", authMode: "passthrough" }),
        expect.objectContaining({ name: "keyed", authMode: "key" }),
      ]));
    });
  });

  test("passthrough provider connection tests do not request upstream /models", async () => {
    const requests: string[] = [];
    globalThis.fetch = async input => {
      requests.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      return new Response(JSON.stringify({ data: [{ id: "unexpected-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const liveConfig = config({ company: companyProvider({ authMode: "passthrough" }) });

    await withManagementServer(liveConfig, async server => {
      const response = await management(server, "/api/providers/test?name=company", "POST");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, latencyMs: 0 });
      expect(requests).toEqual([]);
    });
  });

  test("passthrough providers are absent from the API-key management surface", async () => {
    const liveConfig = config({
      company: companyProvider({ authMode: "passthrough", apiKey: "company-credential" }),
    });

    await withManagementServer(liveConfig, async server => {
      const listed = await management(server, "/api/providers/keys?name=company", "GET");
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ activeId: null, keys: [] });

      const added = await management(server, "/api/providers/keys", "POST", {
        name: "company",
        key: "should-not-be-added",
      });
      expect(added.status).toBe(400);
      expect(await added.json()).toMatchObject({ error: "provider does not use API-key auth" });
      expect(liveConfig.providers.company.apiKey).toBe("company-credential");
    });
  });
});
