/**
 * Test goal: exercise live root-session activity through a real local proxy and local upstream,
 * including concurrent main/child streams, terminal cleanup, client cancellation, and API privacy.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { clearRequestLogsForTests } from "../src/server/request-log";
import {
  resetRequestActivityForTests,
  type RequestActivitySession,
  type RequestActivitySnapshot,
} from "../src/server/request-activity";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

interface Gate {
  promise: Promise<void>;
  release: () => void;
}

function deferred(): Gate {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isActivitySession(value: unknown): value is RequestActivitySession {
  if (!isRecord(value)) return false;
  return typeof value.rootSessionId === "string"
    && typeof value.activeRequests === "number"
    && Array.isArray(value.executionSessionIds)
    && value.executionSessionIds.every(id => typeof id === "string")
    && typeof value.oldestStartedAt === "number"
    && value.routePolicy === "inherit"
    && value.requestedProvider === "local-activity"
    && value.requestedModel === "local-activity/activity-model"
    && value.effectiveProvider === "local-activity"
    && value.effectiveModel === "activity-model"
    && value.effectiveUpstream === "provider"
    && value.fallbackReason === undefined;
}

function isActivitySnapshot(value: unknown): value is RequestActivitySnapshot {
  if (!isRecord(value)) return false;
  return typeof value.generatedAt === "number"
    && typeof value.activeRequests === "number"
    && typeof value.unattributedActiveRequests === "number"
    && Array.isArray(value.sessions)
    && value.sessions.every(isActivitySession);
}

function activitySession(snapshot: RequestActivitySnapshot): RequestActivitySession | undefined {
  return snapshot.sessions.find(session => session.rootSessionId === "root-session");
}

async function waitFor<T>(read: () => Promise<T>, matches: (value: T) => boolean, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!matches(last) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
    last = await read();
  }
  if (!matches(last)) throw new Error(`timed out waiting for expected activity state: ${JSON.stringify(last)}`);
  return last;
}

function config(baseUrl: string): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "local-activity",
    providers: {
      "local-activity": {
        adapter: "openai-chat",
        baseUrl,
        allowPrivateNetwork: true,
        authMode: "key",
        apiKey: "test-api-key",
        defaultModel: "activity-model",
      },
    },
  };
}

function heldChatStream(gate: Promise<void>): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "held" }, finish_reason: null }] })}\n\n`,
      ));
      void gate.then(() => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\n`,
          ));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
          /* The client may have cancelled after the gate was released. */
        }
      });
    },
    cancel() {
      cancelled = true;
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let proxy: ReturnType<typeof startServer> | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
const gates = new Map<string, Gate>();

beforeEach(async () => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-request-activity-codex-");
  testDir = await mkdtemp(join(tmpdir(), "ocx-request-activity-"));
  process.env.OPENCODEX_HOME = testDir;
  gates.clear();
  resetRequestActivityForTests();
  clearRequestLogsForTests();
});

afterEach(async () => {
  await proxy?.stop(true);
  proxy = null;
  await upstream?.stop(true);
  upstream = null;
  gates.clear();
  resetRequestActivityForTests();
  clearRequestLogsForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) await rm(testDir, { recursive: true, force: true });
  testDir = "";
});

async function readActivity(proxyServer: ReturnType<typeof startServer>): Promise<RequestActivitySnapshot> {
  const response = await fetch(new URL("/api/sessions/active", proxyServer.url));
  expect(response.status).toBe(200);
  const payload: unknown = await response.json();
  if (!isActivitySnapshot(payload)) throw new Error("activity API returned an invalid snapshot");
  return payload;
}

async function postResponses(
  proxyServer: ReturnType<typeof startServer>,
  headers: Record<string, string>,
  input: string,
  parentThreadId?: string,
): Promise<Response> {
  return fetch(new URL("/v1/responses", proxyServer.url), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: "local-activity/activity-model",
      input,
      stream: true,
      ...(parentThreadId ? { parent_thread_id: parentThreadId } : {}),
    }),
  });
}

function startLocalServers(): void {
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const requestBody = await request.text();
      const sessionId = requestBody.includes("private child prompt text")
        ? "child-session"
        : requestBody.includes("cancelled prompt text")
        ? "cancel-session"
        : "root-session";
      const gate = deferred();
      gates.set(sessionId, gate);
      return heldChatStream(gate.promise);
    },
  });
  saveConfig(config(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  proxy = startServer(0);
}

describe("live root session activity (end-to-end)", () => {
  test("aggregates concurrent main and child streams as 2 -> 1 -> 0 and keeps the API private", async () => {
    startLocalServers();
    if (!proxy) throw new Error("proxy server was not started");
    const server = proxy;
    const mainResponsePromise = postResponses(
      server,
      { "x-codex-session-id": "root-session" },
      "private prompt text must not appear in activity",
    );
    const childResponsePromise = postResponses(
      server,
      {
        "x-codex-session-id": "child-session",
      },
      "private child prompt text must not appear in activity",
      "root-session",
    );

    const [mainResponse, childResponse] = await Promise.all([mainResponsePromise, childResponsePromise]);
    expect(mainResponse.status).toBe(200);
    expect(childResponse.status).toBe(200);

    const activeAtTwo = await waitFor(
      () => readActivity(server),
      snapshot => activitySession(snapshot)?.activeRequests === 2,
    );
    expect(activeAtTwo.activeRequests).toBe(2);
    expect(activeAtTwo.unattributedActiveRequests).toBe(0);
    expect(activitySession(activeAtTwo)).toMatchObject({
      executionSessionIds: ["child-session", "root-session"],
      routePolicy: "inherit",
      requestedProvider: "local-activity",
      requestedModel: "local-activity/activity-model",
      effectiveProvider: "local-activity",
      effectiveModel: "activity-model",
      effectiveUpstream: "provider",
    });
    const serialized = JSON.stringify(activeAtTwo);
    expect(serialized).not.toContain("private prompt text");
    expect(serialized).not.toContain("private child prompt text");
    expect(serialized).not.toContain("test-api-key");
    expect(serialized).not.toContain("accountId");

    gates.get("root-session")?.release();
    await mainResponse.text();
    const activeAtOne = await waitFor(
      () => readActivity(server),
      snapshot => activitySession(snapshot)?.activeRequests === 1,
    );
    expect(activeAtOne.activeRequests).toBe(1);
    expect(activitySession(activeAtOne)?.executionSessionIds).toEqual(["child-session"]);

    gates.get("child-session")?.release();
    await childResponse.text();
    const activeAtZero = await waitFor(
      () => readActivity(server),
      snapshot => snapshot.activeRequests === 0,
    );
    expect(activeAtZero).toMatchObject({
      activeRequests: 0,
      unattributedActiveRequests: 0,
      sessions: [],
    });
  });

  test("releases activity when the client cancels a local stream", async () => {
    startLocalServers();
    if (!proxy) throw new Error("proxy server was not started");
    const server = proxy;
    const response = await postResponses(
      server,
      { "x-codex-session-id": "cancel-session" },
      "cancelled prompt text must not appear in activity",
    );
    expect(response.status).toBe(200);
    await waitFor(
      () => readActivity(server),
      snapshot => snapshot.activeRequests === 1,
    );

    const reader = response.body?.getReader();
    await reader?.cancel("client cancelled test stream");
    gates.get("cancel-session")?.release();
    const afterCancel = await waitFor(
      () => readActivity(server),
      snapshot => snapshot.activeRequests === 0,
    );
    expect(afterCancel.sessions).toEqual([]);
  });
});
