/**
 * Luna effort migration contract: exact configured models are raised to max while memory and
 * explicitly low requests remain untouched. Both parsed and raw Responses shapes stay aligned.
 */
import { describe, expect, test } from "bun:test";
import { forceConfiguredReasoningMax } from "../src/server/max-reasoning-policy";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig, OcxParsedRequest } from "../src/types";

function config(lunaReasoningMaxModels?: string[], glmReasoningMaxModels?: string[]): OcxConfig {
  return {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    ...(lunaReasoningMaxModels !== undefined ? { lunaReasoningMaxModels } : {}),
    ...(glmReasoningMaxModels !== undefined ? { glmReasoningMaxModels } : {}),
  };
}

function parsed(reasoning?: string, rawBody: unknown = {
  model: "gpt-5.6-luna",
  reasoning: reasoning ? { effort: reasoning, summary: "detailed" } : { summary: "detailed" },
}): OcxParsedRequest {
  return {
    modelId: "gpt-5.6-luna",
    context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    stream: true,
    options: reasoning ? { reasoning } : {},
    _rawBody: rawBody,
  };
}

describe("forceConfiguredReasoningMax", () => {
  test("forces absent and ordinary efforts while preserving both raw reasoning shapes", () => {
    for (const effort of [undefined, "medium", "high", "xhigh"]) {
      const request = parsed(effort, {
        model: "gpt-5.6-luna",
        reasoning: { ...(effort ? { effort } : {}), summary: "detailed", extra: true },
        reasoning_effort: effort ?? "medium",
      });

      expect(forceConfiguredReasoningMax(request, "gpt-5.6-luna", "turn", effort, config())).toEqual({
        policy: "luna",
        ...(effort ? { from: effort } : {}),
        to: "max",
      });
      expect(request.options.reasoning).toBe("max");
      expect(request._rawBody).toEqual({
        model: "gpt-5.6-luna",
        reasoning: { effort: "max", summary: "detailed", extra: true },
        reasoning_effort: "max",
      });
    }
  });

  test("adds nested reasoning but does not invent the legacy top-level field", () => {
    const request = parsed(undefined, { model: "gpt-5.6-luna", stream: true });

    expect(forceConfiguredReasoningMax(request, "gpt-5.6-luna", undefined, undefined, config())).toEqual({ policy: "luna", to: "max" });
    expect(request._rawBody).toEqual({
      model: "gpt-5.6-luna",
      stream: true,
      reasoning: { effort: "max" },
    });
  });

  test("preserves memory, explicit low, and already-max requests", () => {
    const cases = [
      { effort: "medium", requestKind: "memory" },
      { effort: "low", requestKind: "turn" },
      { effort: "LOW", requestKind: "turn" },
      { effort: "max", requestKind: "turn" },
    ];
    for (const item of cases) {
      const request = parsed(item.effort);
      const before = structuredClone(request);
      expect(forceConfiguredReasoningMax(request, "gpt-5.6-luna", item.requestKind, item.effort, config())).toBeNull();
      expect(request).toEqual(before);
    }
  });

  test("matches configured model ids exactly after trim and remains case-sensitive", () => {
    for (const model of ["other", "gpt-5.6-luna-preview", "openai/gpt-5.6-luna", "GPT-5.6-LUNA"]) {
      const request = parsed("medium");
      expect(forceConfiguredReasoningMax(request, model, "turn", "medium", config())).toBeNull();
      expect(request.options.reasoning).toBe("medium");
    }
    const trimmed = parsed("medium");
    expect(forceConfiguredReasoningMax(trimmed, "  gpt-5.6-luna  ", "turn", "medium", config())).not.toBeNull();
    expect(trimmed.options.reasoning).toBe("max");
  });

  test("configured models replace the default and an empty list disables the policy", () => {
    const replacement = parsed("high");
    expect(forceConfiguredReasoningMax(replacement, "custom-luna", "turn", "high", config(["custom-luna"]))).not.toBeNull();
    expect(replacement.options.reasoning).toBe("max");

    const defaultModel = parsed("high");
    expect(forceConfiguredReasoningMax(defaultModel, "gpt-5.6-luna", "turn", "high", config(["custom-luna"]))).toBeNull();
    expect(forceConfiguredReasoningMax(parsed("high"), "gpt-5.6-luna", "turn", "high", config([]))).toBeNull();
  });

  test("malformed raw bodies do not block the parsed rewrite", () => {
    for (const rawBody of [undefined, null, "invalid", []]) {
      const request = parsed("medium", rawBody);
      expect(() => forceConfiguredReasoningMax(request, "gpt-5.6-luna", "turn", "medium", config())).not.toThrow();
      expect(request.options.reasoning).toBe("max");
    }
  });

  test("honors legacy top-level low and leaves malformed nested reasoning unchanged", () => {
    const legacyLow = parsed(undefined, { model: "gpt-5.6-luna", reasoning_effort: "low" });
    expect(forceConfiguredReasoningMax(legacyLow, "gpt-5.6-luna", "turn", "low", config())).toBeNull();
    expect(legacyLow.options.reasoning).toBeUndefined();
    expect(legacyLow._rawBody).toEqual({ model: "gpt-5.6-luna", reasoning_effort: "low" });

    const malformed = parsed(undefined, { model: "gpt-5.6-luna", reasoning: "invalid" });
    expect(forceConfiguredReasoningMax(malformed, "gpt-5.6-luna", "turn", undefined, config())).toBeNull();
    expect(malformed.options.reasoning).toBeUndefined();
    expect(malformed._rawBody).toEqual({ model: "gpt-5.6-luna", reasoning: "invalid" });
  });

  test("honors the legacy top-level client_metadata memory marker for Luna", () => {
    const request = parsed("medium", {
      model: "gpt-5.6-luna",
      reasoning: { effort: "medium" },
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "memory" }),
      },
    });
    const before = structuredClone(request);

    expect(forceConfiguredReasoningMax(request, "gpt-5.6-luna", undefined, "medium", config())).toBeNull();
    expect(request).toEqual(before);
  });

  test("forces every configured GLM effort including low and memory to max", () => {
    for (const effort of [undefined, "low", "medium", "high", "xhigh"]) {
      const request = parsed(effort, {
        model: "zai-anthropic/glm-5.2",
        ...(effort ? { reasoning: { effort } } : {}),
      });

      expect(forceConfiguredReasoningMax(
        request,
        "zai-anthropic/glm-5.2",
        "memory",
        effort,
        config(),
      )).toEqual({ policy: "glm", ...(effort ? { from: effort } : {}), to: "max" });
      expect(request.options.reasoning).toBe("max");
    }
  });

  test("GLM matching is exact and configurable", () => {
    for (const model of ["glm-5.2", "zai-anthropic/glm-5.2-preview", "other/glm-5.2"]) {
      const request = parsed("medium");
      expect(forceConfiguredReasoningMax(request, model, "turn", "medium", config())).toBeNull();
    }

    const replacement = parsed("medium");
    expect(forceConfiguredReasoningMax(
      replacement,
      "custom/glm",
      "turn",
      "medium",
      config(undefined, ["custom/glm"]),
    )).toEqual({ policy: "glm", from: "medium", to: "max" });
    expect(forceConfiguredReasoningMax(
      parsed("medium"),
      "zai-anthropic/glm-5.2",
      "turn",
      "medium",
      config(undefined, []),
    )).toBeNull();
  });

  test("handleResponses sends forced GLM max as the highest Anthropic thinking budget", async () => {
    const originalFetch = globalThis.fetch;
    let upstreamBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      upstreamBody = JSON.parse(String(init?.body));
      return Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "glm-5.2",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    };
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "zai-anthropic/glm-5.2",
          input: "hello",
          stream: false,
          reasoning: { effort: "low" },
        }),
      }), {
        port: 10100,
        defaultProvider: "zai-anthropic",
        providers: {
          "zai-anthropic": {
            adapter: "anthropic",
            baseUrl: "https://api.z.ai/api/anthropic",
            authMode: "key",
            apiKey: "test-key",
            allowPrivateNetwork: true,
          },
        },
      }, { model: "", provider: "" });

      expect(response.status).toBe(200);
      expect(upstreamBody?.thinking).toEqual({ type: "enabled", budget_tokens: 27904 });
      expect(upstreamBody?.max_tokens).toBe(32000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
