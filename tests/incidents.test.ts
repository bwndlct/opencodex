// Goal: verify incident projection and GET /api/incidents expose only durable, redacted outcome diagnostics.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import {
  projectIncident,
  projectIncidents,
  type Incident,
} from "../src/server/incidents";
import type { OcxConfig } from "../src/types";
import type { PersistedUsageAttempt, PersistedUsageEntry } from "../src/usage/log";

let testDir = "";
let previousHome: string | undefined;

const config: OcxConfig = {
  port: 10100,
  defaultProvider: "openai",
  providers: {},
};

function baseEntry(overrides: Partial<PersistedUsageEntry> = {}): PersistedUsageEntry {
  return {
    requestId: "request-default",
    timestamp: 1_000,
    provider: "openai",
    model: "gpt-test",
    status: 200,
    durationMs: 120,
    usageStatus: "unreported",
    ...overrides,
  };
}

function baseAttempt(overrides: Partial<PersistedUsageAttempt> = {}): PersistedUsageAttempt {
  return {
    ordinal: 1,
    provider: "openai",
    model: "gpt-test",
    adapter: "openai-responses",
    status: 200,
    durationMs: 80,
    sendCount: 1,
    recoveryKinds: [],
    usageStatus: "unreported",
    ...overrides,
  };
}

function request(path: string): { req: Request; url: URL } {
  const url = new URL(path, "http://localhost");
  return { req: new Request(url), url };
}

async function readApi(path: string, deps: Parameters<typeof handleManagementAPI>[3] = {}): Promise<{ response: Response; body: unknown }> {
  const { req, url } = request(path);
  const response = await handleManagementAPI(req, url, config, deps);
  expect(response).not.toBeNull();
  return { response: response!, body: await response!.json() };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-incidents-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("incident projection", () => {
  test("classifies parent failures as errors, recovered physical attempts as warnings, and omits clean success", () => {
    const incidents = projectIncidents([
      baseEntry({ requestId: "error-status", status: 502, timestamp: 100 }),
      baseEntry({ requestId: "error-terminal", terminalStatus: "incomplete", timestamp: 200 }),
      baseEntry({
        requestId: "warning-status",
        timestamp: 300,
        attempts: [baseAttempt({ status: 503, recoveryKinds: [] })],
      }),
      baseEntry({
        requestId: "warning-recovery",
        timestamp: 400,
        attempts: [baseAttempt({ recoveryKinds: ["oauth-401"] })],
      }),
      baseEntry({ requestId: "success", timestamp: 500, attempts: [baseAttempt()] }),
      baseEntry({ requestId: "success-without-attempt", timestamp: 600 }),
    ]);

    expect(incidents.map(incident => [incident.requestId, incident.severity])).toEqual([
      ["warning-recovery", "warning"],
      ["warning-status", "warning"],
      ["error-terminal", "error"],
      ["error-status", "error"],
    ]);
  });

  test("orders newest first and applies the bounded projection limit", () => {
    const entries = Array.from({ length: 205 }, (_, index) => baseEntry({
      requestId: `error-${index}`,
      timestamp: index,
      status: 500,
    }));
    const incidents = projectIncidents(entries, { limit: 999 });

    expect(incidents).toHaveLength(200);
    expect(incidents[0]?.requestId).toBe("error-204");
    expect(incidents.at(-1)?.requestId).toBe("error-5");
  });

  test("uses append order as the newest-first tie breaker", () => {
    const incidents = projectIncidents([
      baseEntry({ requestId: "first", timestamp: 100, status: 500 }),
      baseEntry({ requestId: "second", timestamp: 100, status: 500 }),
    ]);

    expect(incidents.map(incident => incident.requestId)).toEqual(["second", "first"]);
  });

  test("keeps legacy rows visible while normalizing fields and excluding unsafe extras", () => {
    const bearer = ["Bearer", "credential-token-value-123456789"].join(" ");
    const legacyRow = {
      ...baseEntry({
        requestId: " legacy-error ",
        timestamp: 900,
        provider: " openai ",
        model: " gpt-test ",
        status: 502,
        requestedModel: " requested-model ",
        resolvedModel: " resolved-model ",
        rootSessionId: " root-legacy ",
        executionSessionId: " exec-legacy ",
        parentThreadId: " parent-legacy ",
        requestKind: " main ",
        subagentKind: " worker ",
        errorCode: " upstream_error ",
        upstreamError: `provider rejected ${bearer}`,
        usage: { inputTokens: 400, outputTokens: 20 },
        totalTokens: 420,
      }),
      prompt: "private prompt",
      headers: { authorization: bearer },
      toolArgs: { command: "private command" },
      apiKey: "private key",
      accountId: "private account",
    };
    const incidents = projectIncidents([legacyRow]);
    const incident = incidents[0];

    expect(incident).toMatchObject({
      requestId: "legacy-error",
      provider: "openai",
      model: "gpt-test",
      requestedModel: "requested-model",
      resolvedModel: "resolved-model",
      rootSessionId: "root-legacy",
      executionSessionId: "exec-legacy",
      parentThreadId: "parent-legacy",
      requestKind: "main",
      subagentKind: "worker",
      errorCode: "upstream_error",
      status: 502,
      severity: "error",
    });
    expect(incident?.upstreamError).toContain("[REDACTED]");
    expect(incident).not.toHaveProperty("usage");
    expect(incident).not.toHaveProperty("totalTokens");
    expect(incident).not.toHaveProperty("prompt");
    expect(incident).not.toHaveProperty("headers");
    expect(incident).not.toHaveProperty("toolArgs");
    expect(incident).not.toHaveProperty("apiKey");
    expect(incident).not.toHaveProperty("accountId");
    expect(JSON.stringify(incident)).not.toContain("private prompt");
  });

  test("compacts physical attempts to safe outcome fields", () => {
    const incident = projectIncident(baseEntry({
      status: 200,
      attempts: [baseAttempt({
        status: 503,
        adapter: "private-adapter",
        sendCount: 3,
        recoveryKinds: ["transient-5xx", "transient-5xx"],
        usage: { inputTokens: 100, outputTokens: 20 },
        totalTokens: 120,
        errorCode: "upstream_error",
      })],
    }));

    expect(incident?.severity).toBe("warning");
    expect(incident?.attempts).toEqual([{
      ordinal: 1,
      provider: "openai",
      model: "gpt-test",
      status: 503,
      durationMs: 80,
      recoveryKinds: ["transient-5xx"],
      errorCode: "upstream_error",
    }]);
    expect(incident?.attempts?.[0]).not.toHaveProperty("adapter");
    expect(incident?.attempts?.[0]).not.toHaveProperty("sendCount");
    expect(incident?.attempts?.[0]).not.toHaveProperty("usage");
    expect(incident?.attempts?.[0]).not.toHaveProperty("totalTokens");
  });
});

describe("GET /api/incidents", () => {
  test("reads legacy usage.jsonl data, defaults to 30, and filters exact sanitized roots", async () => {
    const legacy = Array.from({ length: 35 }, (_, index) => JSON.stringify(baseEntry({
      requestId: `legacy-${index}`,
      timestamp: 1_000 + index,
      status: 500,
      rootSessionId: index % 2 === 0 ? " root-a " : "root-b",
    })));
    writeFileSync(join(testDir, "usage.jsonl"), `${legacy.join("\n")}\n`, { mode: 0o600 });

    const all = await readApi("/api/incidents");
    expect(all.response.status).toBe(200);
    expect(all.body).toHaveLength(30);

    const filtered = await readApi("/api/incidents?limit=2&rootSessionId=%20root-a%20");
    expect(filtered.response.status).toBe(200);
    expect((filtered.body as Incident[]).map(incident => incident.requestId)).toEqual(["legacy-34", "legacy-32"]);
    expect((filtered.body as Incident[]).every(incident => incident.rootSessionId === "root-a")).toBe(true);
  });

  test("returns stable 400 errors for malformed queries", async () => {
    const invalidLimit = await readApi("/api/incidents?limit=1.5");
    expect(invalidLimit.response.status).toBe(400);
    expect(invalidLimit.body).toEqual({ error: "invalid_limit" });

    const invalidRoot = await readApi("/api/incidents?rootSessionId=%00");
    expect(invalidRoot.response.status).toBe(400);
    expect(invalidRoot.body).toEqual({ error: "invalid_root_session_id" });
  });

  test("returns 500 without exposing a reader failure", async () => {
    const failed = await readApi("/api/incidents", {
      readUsageEntries: () => {
        throw new Error("private storage path");
      },
    });

    expect(failed.response.status).toBe(500);
    expect(failed.body).toEqual({ error: "incident_history_unavailable" });
  });
});
