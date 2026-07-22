/**
 * Test goal: verify responses.ts preserves request identity and parseRequest-normalized
 * request metadata in ordinary and combo-adjacent log contexts without external services.
 */
import { describe, expect, test } from "bun:test";
import { isSpawnedChildRequest, requestIdentityFrom } from "../src/server/request-identity";
import { handleResponses } from "../src/server/responses";
import type { RequestLogContext } from "../src/server/request-log";
import type { OcxConfig } from "../src/types";

const SESSION_HEADERS = [
  "x-codex-session-id",
  "x-codex-thread-id",
  "x-codex-conversation-id",
  "openai-session-id",
  "openai-conversation-id",
  "x-openai-session-id",
  "x-request-session-id",
] as const;

class RawHeaderValues extends Headers {
  constructor(private readonly rawValues: Record<string, string>) {
    super();
  }

  override get(name: string): string | null {
    return this.rawValues[name.toLowerCase()] ?? super.get(name);
  }
}

function unavailableConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "disabled",
    providers: {
      disabled: {
        adapter: "openai-chat",
        baseUrl: "https://example.com/v1",
        apiKey: "test-key",
        disabled: true,
      },
    },
    combos: {
      free: {
        targets: [{ provider: "disabled", model: "model-a" }],
      },
    },
  };
}

describe("request identity", () => {
  test("uses current Codex session and thread headers with their official semantics", () => {
    const identity = requestIdentityFrom(
      new Headers({
        "session-id": "root-session",
        "thread-id": "child-thread",
        "x-codex-parent-thread-id": "parent-thread",
      }),
      {},
    );

    expect(identity).toMatchObject({
      executionSessionId: "child-thread",
      parentThreadId: "parent-thread",
      rootSessionId: "root-session",
    });
  });

  test("uses fixed client_metadata identity fields when compatibility headers are absent", () => {
    const identity = requestIdentityFrom(new Headers(), {
      client_metadata: {
        session_id: "root-session",
        thread_id: "child-thread",
        "x-codex-parent-thread-id": "parent-thread",
        nested: { session_id: "ignored-nested-session" },
      },
    });

    expect(identity).toMatchObject({
      executionSessionId: "child-thread",
      parentThreadId: "parent-thread",
      rootSessionId: "root-session",
    });
  });

  test("supports the codex-proxy session headers in their exact priority order", () => {
    for (const [index, header] of SESSION_HEADERS.entries()) {
      const identity = requestIdentityFrom(new Headers({ [header]: ` session-${index} ` }), {});
      expect(identity.executionSessionId).toBe(`session-${index}`);
      expect(identity.rootSessionId).toBe(`session-${index}`);
    }

    const headers = new Headers();
    for (const [index, header] of SESSION_HEADERS.entries()) headers.set(header, `session-${index}`);
    expect(requestIdentityFrom(headers, {}).executionSessionId).toBe("session-0");
  });

  test("rolls a child up to its parent while retaining the execution session", () => {
    const identity = requestIdentityFrom(
      new Headers({
        "x-codex-session-id": "child-session",
        "x-openai-subagent": "collab_spawn",
        "x-codex-turn-metadata": JSON.stringify({
          request_kind: "agent_turn",
          subagent_kind: "thread_spawn",
        }),
      }),
      {
        model: " zai-anthropic/glm-5.2 ",
        parent_thread_id: " root-session ",
        reasoning: { effort: " high " },
      },
    );

    expect(identity).toEqual({
      executionSessionId: "child-session",
      parentThreadId: "root-session",
      rootSessionId: "root-session",
      requestKind: "agent_turn",
      subagentKind: "collab_spawn",
      requestedModel: "zai-anthropic/glm-5.2",
      requestedEffort: "high",
      isSpawnedChild: true,
    });
  });

  test("uses camelCase parent and top-level reasoning fallback without recursively scanning data", () => {
    const identity = requestIdentityFrom(
      new Headers({ "x-codex-session-id": "main-session" }),
      {
        parentThreadId: "parent-session",
        reasoning_effort: "medium",
        session_id: "ignored-top-level-session",
        metadata: { session_id: "ignored-nested-session" },
        client_metadata: { nested: { session_id: "ignored-nested-session" } },
        input: [{ prompt: "session_id=ignored-content" }],
      },
    );

    expect(identity).toMatchObject({
      executionSessionId: "main-session",
      parentThreadId: "parent-session",
      rootSessionId: "parent-session",
      requestedEffort: "medium",
      isSpawnedChild: false,
    });
    expect(identity.requestKind).toBeUndefined();
  });

  test("recognizes only exact child markers and fails closed on malformed metadata", () => {
    expect(requestIdentityFrom(
      new Headers({ "x-codex-turn-metadata": JSON.stringify({ subagent_kind: "thread_spawn" }) }),
      {},
    ).isSpawnedChild).toBe(true);

    for (const headers of [
      new Headers({ "x-openai-subagent": "review" }),
      new Headers({ "x-openai-subagent": "collab_spawn_extra" }),
      new Headers({ "x-codex-turn-metadata": "{not-json" }),
      new Headers({ "x-codex-turn-metadata": JSON.stringify({ subagent_kind: 42 }) }),
    ]) {
      expect(requestIdentityFrom(headers, {}).isSpawnedChild).toBe(false);
    }

    const paddedHeader = new RawHeaderValues({ "x-openai-subagent": " collab_spawn " });
    expect(isSpawnedChildRequest(paddedHeader)).toBe(false);
    expect(requestIdentityFrom(paddedHeader, {}).isSpawnedChild).toBe(false);

    const paddedMetadata = new Headers({
      "x-codex-turn-metadata": JSON.stringify({ subagent_kind: " thread_spawn " }),
    });
    expect(isSpawnedChildRequest(paddedMetadata)).toBe(false);
    expect(requestIdentityFrom(paddedMetadata, {}).isSpawnedChild).toBe(false);
  });

  test("drops empty, oversized, control-character, and non-string identity values", () => {
    const identity = requestIdentityFrom(
      new Headers({
        "x-codex-session-id": "x".repeat(257),
        "x-codex-turn-metadata": JSON.stringify({
          request_kind: `bad\u0000kind`,
          subagent_kind: "x".repeat(257),
        }),
      }),
      {
        parent_thread_id: 42,
        parentThreadId: " ",
        model: "m".repeat(257),
        reasoning: { effort: `bad\u007feffort` },
      },
    );

    expect(identity).toEqual({ isSpawnedChild: false });
  });

  test("writes identity to ordinary and combo log contexts before later handling", async () => {
    const headers = {
      "content-type": "application/json",
      "x-codex-session-id": "child-session",
      "x-openai-subagent": "collab_spawn",
    };
    const ordinaryLog: RequestLogContext = { model: "", provider: "" };
    const ordinary = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "missing/model",
        parent_thread_id: "root-session",
        input: "hello",
        stream: false,
      }),
    }), unavailableConfig(), ordinaryLog);
    expect(ordinary.status).toBe(404);
    expect(ordinaryLog).toMatchObject({
      executionSessionId: "child-session",
      parentThreadId: "root-session",
      rootSessionId: "root-session",
      requestedModel: "missing/model",
      isSpawnedChild: true,
    });

    const comboLog: RequestLogContext = { model: "", provider: "" };
    const combo = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "combo/free",
        parentThreadId: "root-session",
        reasoning: { effort: "medium" },
        input: "hello",
        stream: false,
      }),
    }), unavailableConfig(), comboLog);
    expect(combo.status).toBe(503);
    expect(comboLog).toMatchObject({
      executionSessionId: "child-session",
      parentThreadId: "root-session",
      rootSessionId: "root-session",
      requestedModel: "combo/free",
      requestedEffort: "medium",
      isSpawnedChild: true,
    });
  });

  test("keeps parseRequest-normalized requested model and effort for ordinary requests", async () => {
    const normalized = { model: "missing/model", effort: "ultra", expectedEffort: "max" };
    const invalid = { model: "missing/model", effort: "not-a-codex-effort", expectedEffort: undefined };

    for (const current of [normalized, invalid]) {
      const logCtx: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: current.model,
          input: "hello",
          reasoning: { effort: current.effort },
          stream: false,
        }),
      }), unavailableConfig(), logCtx);

      expect(response.status).toBe(404);
      expect(logCtx.requestedModel).toBe(current.model);
      expect(logCtx.requestedEffort).toBe(current.expectedEffort);
    }
  });
});
