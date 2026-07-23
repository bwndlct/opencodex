import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import type { PersistedUsageEntry } from "../src/usage/log";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "forward",
      },
    },
  } as OcxConfig;
}

function makeEntry(overrides: Partial<PersistedUsageEntry>): PersistedUsageEntry {
  return {
    requestId: "req-1",
    timestamp: 1000,
    provider: "openai",
    model: "gpt-5",
    status: 200,
    durationMs: 50,
    usageStatus: "reported",
    usage: { inputTokens: 100, outputTokens: 50 },
    totalTokens: 150,
    ...overrides,
  };
}

function writeFixture(entries: PersistedUsageEntry[]): void {
  const lines = entries.map(e => JSON.stringify(e));
  writeFileSync(join(testDir, "usage.jsonl"), `${lines.join("\n")}\n`, { mode: 0o600 });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-api-sess-hist-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-api-sess-hist-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("GET /api/sessions/history", () => {
  test("returns documented envelope with generatedAt and retentionDays", async () => {
    writeFixture([makeEntry({ rootSessionId: "sess-a" })]);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/sessions/history", server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.generatedAt).toEqual(expect.any(Number));
      expect(body.retentionDays).toBe(30);
      expect(Array.isArray(body.sessions)).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("groups by rootSessionId newest first", async () => {
    writeFixture([
      makeEntry({ requestId: "r1", rootSessionId: "sess-old", timestamp: 1000 }),
      makeEntry({ requestId: "r2", rootSessionId: "sess-new", timestamp: 3000 }),
      makeEntry({ requestId: "r3", rootSessionId: "sess-old", timestamp: 2000 }),
    ]);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/sessions/history", server.url));
      const body = await res.json();
      expect(body.sessions.map((s: { rootSessionId: string }) => s.rootSessionId)).toEqual(["sess-new", "sess-old"]);
      expect(body.sessions[1].requestCount).toBe(2);
    } finally {
      await server.stop(true);
    }
  });

  test("respects limit query parameter", async () => {
    writeFixture(Array.from({ length: 5 }, (_, i) =>
      makeEntry({ requestId: `r${i}`, rootSessionId: `sess-${i}`, timestamp: 1000 + i }),
    ));
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/sessions/history?limit=2", server.url));
      const body = await res.json();
      expect(body.sessions).toHaveLength(2);
      expect(body.sessions[0].rootSessionId).toBe("sess-4");
    } finally {
      await server.stop(true);
    }
  });

  test("invalid limit falls back to default", async () => {
    writeFixture([makeEntry({ rootSessionId: "sess-a" })]);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/sessions/history?limit=abc", server.url));
      const body = await res.json();
      expect(body.sessions).toHaveLength(1);
    } finally {
      await server.stop(true);
    }
  });

  test("omits totalTokens when no measured request exists", async () => {
    writeFixture([
      makeEntry({
        requestId: "r1", rootSessionId: "sess-a",
        usageStatus: "unreported", usage: undefined, totalTokens: undefined,
      }),
    ]);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/sessions/history", server.url));
      const body = await res.json();
      expect(body.sessions[0].totalTokens).toBeUndefined();
      expect(body.sessions[0].measuredRequests).toBe(0);
      expect(body.sessions[0].unmeteredRequests).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test("includes token sum for reported and estimated requests", async () => {
    writeFixture([
     makeEntry({ requestId: "r1", rootSessionId: "sess-a", usageStatus: "reported",
       usage: { inputTokens: 100, outputTokens: 50 }, totalTokens: 150 }),
    makeEntry({ requestId: "r2", rootSessionId: "sess-a", usageStatus: "estimated",
      usage: { inputTokens: 10, outputTokens: 5, estimated: true }, totalTokens: undefined }),
    ]);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/sessions/history", server.url));
      const body = await res.json();
      expect(body.sessions[0].totalTokens).toBe(165);
      expect(body.sessions[0].measuredRequests).toBe(2);
      expect(body.sessions[0].estimatedRequests).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test("projects latest identity and model fields", async () => {
    writeFixture([
      makeEntry({
        requestId: "r1", rootSessionId: "sess-a", timestamp: 1000,
        provider: "openai", model: "gpt-4", resolvedModel: "gpt-4-turbo",
        requestedModel: "openai/gpt-5", requestedEffort: "high",
        executionSessionId: "exec-1",
      }),
      makeEntry({
        requestId: "r2", rootSessionId: "sess-a", timestamp: 5000,
        provider: "anthropic", model: "claude-3", resolvedModel: "claude-3.5-sonnet",
        requestedModel: "anthropic/claude-3.5-sonnet", requestedEffort: "max",
        executionSessionId: "exec-2",
      }),
    ]);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/sessions/history", server.url));
      const body = await res.json();
      const s = body.sessions[0];
      expect(s.effectiveProvider).toBe("anthropic");
      expect(s.effectiveModel).toBe("claude-3.5-sonnet");
      expect(s.requestedProvider).toBe("anthropic");
      expect(s.requestedModel).toBe("anthropic/claude-3.5-sonnet");
      expect(s.requestedEffort).toBe("max");
      expect(s.executionSessionId).toBe("exec-2");
    } finally {
      await server.stop(true);
    }
  });

  test("returns empty sessions when no usage file exists", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/sessions/history", server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessions).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });
});

describe("GET /api/sessions/{id}/logs", () => {
  test("returns logs for exact rootSessionId match newest first", async () => {
    writeFixture([
      makeEntry({ requestId: "r1", rootSessionId: "sess-a", timestamp: 1000 }),
      makeEntry({ requestId: "r2", rootSessionId: "sess-b", timestamp: 2000 }),
      makeEntry({ requestId: "r3", rootSessionId: "sess-a", timestamp: 3000 }),
    ]);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/sessions/sess-a/logs", server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rootSessionId).toBe("sess-a");
      expect(body.retentionDays).toBe(30);
      expect(body.logs.map((l: { requestId: string }) => l.requestId)).toEqual(["r3", "r1"]);
    } finally {
      await server.stop(true);
    }
  });

  test("handles URL-encoded rootSessionId", async () => {
    writeFixture([
      makeEntry({ requestId: "r1", rootSessionId: "sess special+id", timestamp: 1000 }),
    ]);
    const server = startServer(0);
    try {
      const encoded = encodeURIComponent("sess special+id");
      const res = await fetch(new URL(`/api/sessions/${encoded}/logs`, server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rootSessionId).toBe("sess special+id");
      expect(body.logs).toHaveLength(1);
    } finally {
      await server.stop(true);
    }
  });

  test("returns 400 for invalid session id with path traversal", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/sessions/..%2Fetc%2Fpasswd/logs", server.url));
      expect(res.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });

  test("returns 400 for empty session id", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/sessions//logs", server.url));
      expect(res.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });

  test("respects limit query parameter", async () => {
    writeFixture(Array.from({ length: 5 }, (_, i) =>
      makeEntry({ requestId: `r${i}`, rootSessionId: "sess-a", timestamp: 1000 + i }),
    ));
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/sessions/sess-a/logs?limit=2", server.url));
      const body = await res.json();
      expect(body.logs).toHaveLength(2);
      expect(body.logs[0].requestId).toBe("r4");
    } finally {
      await server.stop(true);
    }
  });

  test("returns empty logs for non-existent session", async () => {
    writeFixture([makeEntry({ rootSessionId: "sess-a" })]);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/sessions/sess-other/logs", server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.logs).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  test("does not leak secret fields in projected logs", async () => {
    writeFixture([
      makeEntry({
        requestId: "r1", rootSessionId: "sess-a", timestamp: 1000,
        attempts: [{
          ordinal: 1, provider: "openai", model: "gpt-5", adapter: "openai-responses",
          status: 200, durationMs: 10, sendCount: 1, recoveryKinds: [], usageStatus: "reported",
        }],
        upstreamError: "should not appear",
      }),
    ]);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/sessions/sess-a/logs", server.url));
      const body = await res.json();
      const log = body.logs[0];
      expect(log.attempts).toBeUndefined();
      expect(log.upstreamError).toBeUndefined();
      expect(log.requestId).toBe("r1");
    } finally {
      await server.stop(true);
    }
  });
});

describe("existing endpoints unchanged", () => {
 test("/api/usage still works", async () => {
    writeFixture([makeEntry({ rootSessionId: "sess-a", timestamp: Date.now() })]);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/usage", server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary.requests).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test("/api/sessions/active still works", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/sessions/active", server.url));
      expect(res.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });
});
