/**
 * Verify src/server/index.ts hot-reload behavior through the public reloadServerConfig API and
 * real Bun HTTP requests: valid changes reach new requests, in-flight requests retain their
 * captured snapshot, failed changes keep the old config, listener-affecting changes require a
 * restart, and unsupported server objects are rejected.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reloadServerConfig, startServer } from "../src/server";
import type { OcxConfig } from "../src/types";

type TestServer = ReturnType<typeof startServer>;

interface ConfigSnapshot {
  websockets: boolean;
  port: number;
  hostname: string;
}

const originalOpencodexHome = process.env.OPENCODEX_HOME;
let testHome: string | undefined;
let server: TestServer | undefined;

function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    subagentModels: [],
    websockets: false,
    codexAutoStart: false,
    ...overrides,
  };
}

function requireTestHome(): string {
  if (!testHome) throw new Error("test home is not initialized");
  return testHome;
}

function requireServer(): TestServer {
  if (!server) throw new Error("test server is not running");
  return server;
}

async function writeTestConfig(config: OcxConfig): Promise<void> {
  await writeRawConfig(`${JSON.stringify(config)}\n`);
}

async function writeRawConfig(content: string): Promise<void> {
  await writeFile(join(requireTestHome(), "config.json"), content, "utf8");
}

async function startTestServer(config = baseConfig()): Promise<TestServer> {
  await writeTestConfig(config);
  const started = startServer(0);
  server = started;
  return started;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfigSnapshot(value: unknown): ConfigSnapshot {
  if (
    !isRecord(value)
    || typeof value.websockets !== "boolean"
    || typeof value.port !== "number"
    || typeof value.hostname !== "string"
  ) {
    throw new Error("unexpected /api/config response");
  }
  return {
    websockets: value.websockets,
    port: value.port,
    hostname: value.hostname,
  };
}

async function fetchConfigSnapshot(): Promise<ConfigSnapshot> {
  const response = await fetch(new URL("/api/config", requireServer().url));
  expect(response.status).toBe(200);
  return parseConfigSnapshot(await response.json());
}

async function expectRestartRequired(config: OcxConfig, message: string): Promise<void> {
  await startTestServer();
  await writeTestConfig(config);
  expect(() => reloadServerConfig(requireServer())).toThrow(message);
}

beforeEach(async () => {
  testHome = await mkdtemp(join(tmpdir(), "ocx-server-hot-reload-"));
  process.env.OPENCODEX_HOME = testHome;
});

afterEach(async () => {
  const runningServer = server;
  server = undefined;
  try {
    if (runningServer) await runningServer.stop(true);
  } finally {
    if (originalOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalOpencodexHome;
    const home = testHome;
    testHome = undefined;
    if (home) await rm(home, { recursive: true, force: true });
  }
});

describe("reloadServerConfig", () => {
  test("applies a valid reload before the next request is handled", async () => {
    const initialServer = await startTestServer();
    expect(initialServer).toBe(requireServer());
    expect((await fetchConfigSnapshot()).websockets).toBe(false);

    await writeTestConfig(baseConfig({ websockets: true }));
    const reloaded = reloadServerConfig(requireServer());

    expect(reloaded.websockets).toBe(true);
    expect((await fetchConfigSnapshot()).websockets).toBe(true);
  });

  test("keeps an in-flight request on its captured config while later requests use the reload", async () => {
    let releaseOldDiscovery: (() => void) | undefined;
    let oldDiscoveryStarted: (() => void) | undefined;
    const oldDiscoveryReady = new Promise<void>(resolve => { oldDiscoveryStarted = resolve; });
    const oldDiscoveryRelease = new Promise<void>(resolve => { releaseOldDiscovery = resolve; });
    const oldUpstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        oldDiscoveryStarted?.();
        await oldDiscoveryRelease;
        return Response.json({ data: [{ id: "old-model" }] });
      },
    });
    const newUpstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ data: [{ id: "new-model" }] }),
    });
    const providerConfig = (baseUrl: string): OcxConfig => ({
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "routed",
      openaiProviderTierVersion: 2,
      modelCacheTtlMs: 0,
      providers: {
        routed: {
          adapter: "openai-chat",
          authMode: "key",
          apiKey: "test-key",
          baseUrl,
          allowPrivateNetwork: true,
        },
      },
    });

    try {
      const started = await startTestServer(providerConfig(`${oldUpstream.url}v1`));
      const firstResponsePromise = fetch(new URL("/v1/models", started.url));
      await oldDiscoveryReady;

      await writeTestConfig(providerConfig(`${newUpstream.url}v1`));
      reloadServerConfig(started);
      releaseOldDiscovery?.();

      const firstModels = await firstResponsePromise.then(response => response.json()) as {
        data: Array<{ id: string }>;
      };
      const secondModels = await fetch(new URL("/v1/models", started.url))
        .then(response => response.json()) as { data: Array<{ id: string }> };
      expect(firstModels.data.map(model => model.id)).toContain("routed/old-model");
      expect(firstModels.data.map(model => model.id)).not.toContain("routed/new-model");
      expect(secondModels.data.map(model => model.id)).toContain("routed/new-model");
      expect(secondModels.data.map(model => model.id)).not.toContain("routed/old-model");
    } finally {
      releaseOldDiscovery?.();
      await oldUpstream.stop(true);
      await newUpstream.stop(true);
    }
  });

  test("keeps the previous config when a reload fails", async () => {
    await startTestServer();
    const before = await fetchConfigSnapshot();

    await writeTestConfig(baseConfig({ port: 12345, websockets: true }));
    expect(() => reloadServerConfig(requireServer())).toThrow("hostname or port changed; restart required");

    expect(await fetchConfigSnapshot()).toEqual(before);
  });

  test("rejects malformed JSON and keeps the previous config", async () => {
    await startTestServer();
    const before = await fetchConfigSnapshot();

    await writeRawConfig("{\"port\":");
    expect(() => reloadServerConfig(requireServer())).toThrow("invalid configuration: invalid_json");

    expect(await fetchConfigSnapshot()).toEqual(before);
  });

  test("rejects an unrecoverable schema error and keeps the previous config", async () => {
    await startTestServer();
    const before = await fetchConfigSnapshot();

    await writeRawConfig(JSON.stringify({ ...baseConfig(), port: "not-a-port" }));
    expect(() => reloadServerConfig(requireServer())).toThrow(/invalid configuration: schema_invalid:/);

    expect(await fetchConfigSnapshot()).toEqual(before);
  });

  test("requires a restart when port changes", async () => {
    await expectRestartRequired(baseConfig({ port: 12345 }), "hostname or port changed; restart required");
  });

  test("requires a restart when hostname changes", async () => {
    await expectRestartRequired(baseConfig({ hostname: "localhost" }), "hostname or port changed; restart required");
  });

  test("requires a restart when proxy changes", async () => {
    await expectRestartRequired(baseConfig({ proxy: "http://proxy.example.test:8080" }), "proxy changed; restart required");
  });

  test("rejects a server object that does not support config reload", () => {
    expect(() => reloadServerConfig({})).toThrow("server does not support config reload");
  });
});
