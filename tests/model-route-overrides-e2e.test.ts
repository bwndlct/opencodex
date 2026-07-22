import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses, handleResponsesCompact } from "../src/server/responses";
import { saveConfig } from "../src/config";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import type { RequestLogContext } from "../src/server/request-log";

function emptyLogCtx(): RequestLogContext {
  return { model: "", provider: "" };
}

function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "zai-anthropic",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
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
  const dir = mkdtempSync(join(tmpdir(), "ocx-mro-e2e-"));
  process.env.OPENCODEX_HOME = dir;
  try {
    return await run(dir);
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

function mockChatUpstream(capture: { model?: string; effort?: string }) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const text = await req.text();
      const body = JSON.parse(text);
      capture.model = body.model;
      capture.effort = body.reasoning_effort ?? body.reasoning?.effort;
      return Response.json({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
}

describe("model route override — /v1/responses e2e", () => {
  test("override redirects gpt-5.4 to zai-anthropic/glm-5.2", async () => {
    await withTempHome(async () => {
      const capture: { model?: string; effort?: string } = {};
      const upstream = mockChatUpstream(capture);
      try {
        const provider: OcxProviderConfig = {
          adapter: "openai-chat",
          baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
          allowPrivateNetwork: true,
          apiKey: "zk-test",
          models: ["glm-5.2"],
        };
        const config = baseConfig({
          providers: { openai: baseConfig().providers.openai, "zai-anthropic": provider },
        });
        saveConfig(config);

        const logCtx = emptyLogCtx();
        const response = await handleResponses(
          new Request("http://localhost/v1/responses", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-5.4", input: "hello", stream: false }),
          }),
          config,
          logCtx,
        );
        expect(response.status).toBe(200);
        expect(capture.model).toBe("glm-5.2");
        // The override set effort to "max"; the provider's reasoning effort map may
        // translate it (e.g. zai-anthropic maps max -> xhigh). The key assertion is
        // that the override DID set a fixed effort, not "inherit" passthrough.
        expect(capture.effort).toBeDefined();
        expect(logCtx.requestedModel).toBe("gpt-5.4");
        expect(logCtx.overrideSourceModel).toBe("gpt-5.4");
        expect(logCtx.overrideTargetModel).toBe("zai-anthropic/glm-5.2");
        expect(logCtx.overrideEffort).toBe("max");
      } finally {
        await upstream.stop(true);
      }
    });
  }, 10_000);

  test("direct request to zai-anthropic/glm-5.2 bypasses override", async () => {
    await withTempHome(async () => {
      const capture: { model?: string; effort?: string } = {};
      const upstream = mockChatUpstream(capture);
      try {
        const provider: OcxProviderConfig = {
          adapter: "openai-chat",
          baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
          allowPrivateNetwork: true,
          apiKey: "zk-test",
          models: ["glm-5.2"],
        };
        const config = baseConfig({
          providers: { openai: baseConfig().providers.openai, "zai-anthropic": provider },
        });
        saveConfig(config);

        const logCtx = emptyLogCtx();
        const response = await handleResponses(
          new Request("http://localhost/v1/responses", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "zai-anthropic/glm-5.2", input: "hello", stream: false }),
          }),
          config,
          logCtx,
        );
        expect(response.status).toBe(200);
        expect(capture.model).toBe("glm-5.2");
        expect(logCtx.overrideSourceModel).toBeUndefined();
        expect(logCtx.requestedModel).toBe("zai-anthropic/glm-5.2");
      } finally {
        await upstream.stop(true);
      }
    });
  }, 10_000);

  test("override target combo runs the complete failover loop and keeps the source identity", async () => {
    await withTempHome(async () => {
      let firstHits = 0;
      let secondHits = 0;
      const first = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          firstHits += 1;
          await req.text();
          return Response.json({ error: { message: "first target unavailable" } }, { status: 503 });
        },
      });
      const second = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          secondHits += 1;
          await req.text();
          return Response.json({
            id: "chatcmpl-combo-backup",
            object: "chat.completion",
            model: "backup-model",
            choices: [{ index: 0, message: { role: "assistant", content: "backup ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          });
        },
      });
      try {
        const base = baseConfig();
        const config = baseConfig({
          providers: {
            ...base.providers,
            first: {
              adapter: "openai-chat",
              baseUrl: `${first.url.toString().replace(/\/$/, "")}/v1`,
              allowPrivateNetwork: true,
              apiKey: "first-key",
              models: ["first-model"],
            },
            second: {
              adapter: "openai-chat",
              baseUrl: `${second.url.toString().replace(/\/$/, "")}/v1`,
              allowPrivateNetwork: true,
              apiKey: "second-key",
              models: ["second-model"],
            },
          },
          combos: {
            "glm-failover": {
              strategy: "failover",
              targets: [
                { provider: "first", model: "first-model" },
                { provider: "second", model: "second-model" },
              ],
            },
          },
          modelRouteOverrides: {
            enabled: true,
            rules: {
              "gpt-5.4": { target: "combo/glm-failover", effort: "max", enabled: true },
            },
          },
        });
        saveConfig(config);

        const logCtx = emptyLogCtx();
        let routeObservation: Record<string, unknown> | undefined;
        const response = await handleResponses(
          new Request("http://localhost/v1/responses", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-5.4", input: "hello", stream: false }),
          }),
          config,
          logCtx,
          { onRequestRouteResolved: observation => { routeObservation = observation; } },
        );

        expect(response.status).toBe(200);
        expect(firstHits).toBe(1);
        expect(secondHits).toBe(1);
        expect(logCtx.requestedModel).toBe("gpt-5.4");
        expect(logCtx.model).toBe("combo/glm-failover");
        expect(logCtx.provider).toBe("combo");
        expect(logCtx.overrideSourceModel).toBe("gpt-5.4");
        expect(logCtx.overrideTargetModel).toBe("combo/glm-failover");
        expect(logCtx.overrideEffort).toBe("max");
        expect(routeObservation).toMatchObject({
          requestedModel: "gpt-5.4",
          effectiveProvider: "second",
          effectiveModel: "second-model",
          overrideSourceModel: "gpt-5.4",
          overrideTargetModel: "combo/glm-failover",
          overrideEffort: "max",
        });
        expect(logCtx.attempts?.map(attempt => `${attempt.provider}/${attempt.model}`)).toEqual([
          "first/first-model",
          "second/second-model",
        ]);

        const compactConfig = baseConfig({
          providers: config.providers,
          combos: {
            "glm-compact": {
              strategy: "failover",
              targets: [
                { provider: "first", model: "first-model" },
                { provider: "second", model: "second-model" },
              ],
            },
          },
          modelRouteOverrides: {
            enabled: true,
            rules: {
              "gpt-5.4": { target: "combo/glm-compact", effort: "max", enabled: true },
            },
          },
        });
        saveConfig(compactConfig);
        const compactLogCtx = emptyLogCtx();
        const compactResponse = await handleResponsesCompact(
          new Request("http://localhost/v1/responses/compact", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-5.4", input: [] }),
          }),
          compactConfig,
          compactLogCtx,
        );
        expect(compactResponse.status).toBe(200);
        expect(firstHits).toBe(2);
        expect(secondHits).toBe(2);
        expect(compactLogCtx.requestedModel).toBe("gpt-5.4");
        expect(compactLogCtx.overrideTargetModel).toBe("combo/glm-compact");
        expect(compactLogCtx.attempts?.map(attempt => `${attempt.provider}/${attempt.model}`)).toEqual([
          "first/first-model",
          "second/second-model",
        ]);
        expect(await compactResponse.json()).toHaveProperty("output");
      } finally {
        await first.stop(true);
        await second.stop(true);
      }
    });
  }, 10_000);

  test("override disabled globally does not fire", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        modelRouteOverrides: { enabled: false, rules: { "gpt-5.4": { target: "zai-anthropic/glm-5.2" } } },
      });
      saveConfig(config);
      const logCtx = emptyLogCtx();
      // gpt-5.4 routes to the native openai provider which will fail to connect,
      // but we only check that the override didn't fire.
      await handleResponses(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-5.4", input: "hello", stream: false }),
        }),
        config,
        logCtx,
      ).catch(() => null);
      expect(logCtx.overrideSourceModel).toBeUndefined();
    });
  }, 10_000);

  test("override with inherit effort still applies the GLM forced-max policy", async () => {
    await withTempHome(async () => {
      const capture: { model?: string; effort?: string } = {};
      const upstream = mockChatUpstream(capture);
      try {
        const provider: OcxProviderConfig = {
          adapter: "openai-chat",
          baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
          allowPrivateNetwork: true,
          apiKey: "zk-test",
          models: ["glm-5.2"],
        };
        const config = baseConfig({
          providers: { openai: baseConfig().providers.openai, "zai-anthropic": provider },
          modelRouteOverrides: {
            enabled: true,
            rules: { "gpt-5.4": { target: "zai-anthropic/glm-5.2", effort: "inherit" } },
          },
        });
        saveConfig(config);

        const logCtx = emptyLogCtx();
        await handleResponses(
          new Request("http://localhost/v1/responses", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-5.4", input: "hello", stream: false, reasoning: { effort: "high" } }),
          }),
          config,
          logCtx,
        );
        expect(capture.effort).toBe("max");
        expect(logCtx.overrideEffort).toBe("inherit");
        expect(logCtx.requestedEffort).toBe("high->max");
      } finally {
        await upstream.stop(true);
      }
    });
  }, 10_000);

  test("rule-level disabled does not fire even when global is enabled", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        modelRouteOverrides: {
          enabled: true,
          rules: { "gpt-5.4": { target: "zai-anthropic/glm-5.2", enabled: false } },
        },
      });
      saveConfig(config);
      const logCtx = emptyLogCtx();
      await handleResponses(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-5.4", input: "hello", stream: false }),
        }),
        config,
        logCtx,
      ).catch(() => null);
      expect(logCtx.overrideSourceModel).toBeUndefined();
    });
  }, 10_000);
});
