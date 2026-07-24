import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

// Issue #88: text-only input models (DeepSeek, ...) get "eyes" — the vision sidecar describes
// attached images via a vision-capable forward model and replaces them with text BEFORE the main
// call. These tests observe the fallback path actually firing end-to-end (activation evidence),
// and that models outside `noVisionModels` keep their images untouched (regression guard).

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
let sidecar: ReturnType<typeof Bun.serve> | null = null;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-vision-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-vision-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  upstream?.stop(true);
  upstream = null;
  sidecar?.stop(true);
  sidecar = null;
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

const PNG_DATA_URL = "data:image/png;base64,aGVsbG8taW1hZ2UtYnl0ZXM=";
const CAPTION = "A red square logo with the word OPENCODEX in white monospace text.";

/** Fake ChatGPT forward backend: answers /responses with an SSE caption stream. */
function serveSidecar(onRequest: (req: Request, bodyText: string) => void) {
  return Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const bodyText = await req.text();
      onRequest(req, bodyText);
      const sse = [
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: CAPTION })}`,
        "",
        "data: [DONE]",
        "", "",
      ].join("\n");
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    },
  });
}

/** Fake text-only upstream (openai-chat wire): records the forwarded body. */
function serveUpstream(record: (bodyText: string) => void) {
  return Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      record(await req.text());
      return new Response(JSON.stringify({
        id: "chatcmpl-vision-1", object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "I see a red logo." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }), { headers: { "content-type": "application/json" } });
    },
  });
}

function baseRequest(model: string) {
  return {
    model, stream: false,
    input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: "what does this logo say?" },
      { type: "input_image", image_url: PNG_DATA_URL },
    ]}],
  };
}

describe("vision sidecar fallback (issue #88, end-to-end)", () => {
  test("noVisionModels request fires the sidecar and forwards the caption instead of the image", async () => {
    let upstreamBody = "";
    let sidecarBody = "";
    let sidecarAuth: string | null = null;
    let sidecarHits = 0;
    upstream = serveUpstream(b => { upstreamBody = b; });
    sidecar = serveSidecar((req, b) => { sidecarHits += 1; sidecarBody = b; sidecarAuth = req.headers.get("authorization"); });
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(requestUrl);
      const prefix = "/backend-api/codex";
      if (url.hostname === "chatgpt.com" && url.pathname.startsWith(prefix)) {
        return originalFetch(new URL(`${url.pathname.slice(prefix.length)}${url.search}`, sidecar!.url), init);
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "textonly", openaiProviderTierVersion: 2,
      providers: {
        textonly: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "key-alpha-000111222333",
          noVisionModels: ["blind-model"],
        },
        openai: {
          adapter: "openai-responses",
          authMode: "forward",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          codexAccountMode: "direct",
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer forward-oauth-token" },
        body: JSON.stringify(baseRequest("textonly/blind-model")),
      });
      expect(res.status).toBe(200);

      // Activation evidence: the sidecar actually ran, got the image + OAuth passthrough.
      expect(sidecarHits).toBe(1);
      expect(sidecarAuth).toBe("Bearer forward-oauth-token");
      expect(sidecarBody).toContain("input_image");
      expect(sidecarBody).toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");
      expect(JSON.parse(sidecarBody).model).toBe("gpt-5.6-luna");

      // The text-only upstream saw the caption, not the image bytes.
      expect(upstreamBody).toContain(CAPTION);
      expect(upstreamBody).not.toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");
      expect(upstreamBody).not.toContain("image_url");
    } finally {
      server.stop(true);
    }
  });

  test("explicit passthrough vision provider describes through /v1/responses without affecting the main route", async () => {
    let upstreamBody = "";
    let sidecarBody = "";
    let sidecarPath = "";
    let sidecarAuth: string | null = null;
    let sidecarAccount: string | null = null;
    let sidecarProject: string | null = null;
    upstream = serveUpstream(body => { upstreamBody = body; });
    sidecar = serveSidecar((req, body) => {
      sidecarBody = body;
      sidecarPath = new URL(req.url).pathname;
      sidecarAuth = req.headers.get("authorization");
      sidecarAccount = req.headers.get("chatgpt-account-id");
      sidecarProject = req.headers.get("openai-project");
    });

    const config: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "textonly",
      providers: {
        textonly: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "key-alpha-000111222333",
          noVisionModels: ["blind-model"],
        },
        company: {
          adapter: "openai-responses",
          authMode: "passthrough",
          baseUrl: `${sidecar.url}v1`,
          allowPrivateNetwork: true,
        },
      },
      visionSidecar: { backend: "openai", provider: "company", model: "gpt-5.6-luna" },
    };
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer company-forwarded-token",
          "chatgpt-account-id": "must-not-reach-company",
          "openai-project": "project-alpha",
        },
        body: JSON.stringify(baseRequest("textonly/blind-model")),
      });
      expect(res.status).toBe(200);
      expect(sidecarPath).toBe("/v1/responses");
      expect(sidecarAuth).toBe("Bearer company-forwarded-token");
      expect(sidecarAccount).toBeNull();
      expect(sidecarProject).toBe("project-alpha");
      expect(JSON.parse(sidecarBody).model).toBe("gpt-5.6-luna");
      expect(sidecarBody).toContain(PNG_DATA_URL);
      expect(upstreamBody).toContain(CAPTION);
      expect(upstreamBody).not.toContain(PNG_DATA_URL);
    } finally {
      server.stop(true);
    }
  });

  test("explicit API-key vision provider uses its configured key and /v1/responses", async () => {
    let upstreamBody = "";
    let sidecarBody = "";
    let sidecarPath = "";
    let sidecarAuth: string | null = null;
    let sidecarAccount: string | null = null;
    let sidecarProject: string | null = null;
    upstream = serveUpstream(body => { upstreamBody = body; });
    sidecar = serveSidecar((req, body) => {
      sidecarBody = body;
      sidecarPath = new URL(req.url).pathname;
      sidecarAuth = req.headers.get("authorization");
      sidecarAccount = req.headers.get("chatgpt-account-id");
      sidecarProject = req.headers.get("openai-project");
    });

    const config: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "textonly",
      providers: {
        textonly: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "main-key-test",
          noVisionModels: ["blind-model"],
        },
        companyKey: {
          adapter: "openai-responses",
          authMode: "key",
          baseUrl: sidecar.url,
          allowPrivateNetwork: true,
          apiKey: "vision-key-test",
        },
      },
      visionSidecar: { backend: "openai", provider: "companyKey", model: "gpt-5.6-luna" },
    };
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Caller caller-credential-must-not-forward",
          "chatgpt-account-id": "caller-account-must-not-forward",
          "openai-project": "caller-project-must-not-forward",
        },
        body: JSON.stringify(baseRequest("textonly/blind-model")),
      });
      expect(res.status).toBe(200);
      expect(sidecarPath).toBe("/v1/responses");
      expect(sidecarAuth).toBe("Bearer vision-key-test");
      expect(sidecarAccount).toBeNull();
      expect(sidecarProject).toBeNull();
      expect(JSON.parse(sidecarBody).model).toBe("gpt-5.6-luna");
      expect(upstreamBody).toContain(CAPTION);
      expect(upstreamBody).not.toContain(PNG_DATA_URL);
    } finally {
      server.stop(true);
    }
  });

  test("models outside noVisionModels keep their image untouched (no sidecar call)", async () => {
    let upstreamBody = "";
    let sidecarHits = 0;
    upstream = serveUpstream(b => { upstreamBody = b; });
    sidecar = serveSidecar(() => { sidecarHits += 1; });

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "seeing", openaiProviderTierVersion: 2,
      providers: {
        seeing: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "key-alpha-000111222333",
          noVisionModels: ["blind-model"],
        },
        openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer forward-oauth-token" },
        body: JSON.stringify(baseRequest("seeing/vision-model")),
      });
      expect(res.status).toBe(200);
      expect(sidecarHits).toBe(0);
      expect(upstreamBody).toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");
      expect(upstreamBody).not.toContain(CAPTION);
    } finally {
      server.stop(true);
    }
  });
});
