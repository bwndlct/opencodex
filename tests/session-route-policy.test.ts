import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSessionRoutePolicy,
  getSessionRoutePolicyPath,
  resetSessionRoutePolicyStoreForTests,
  SessionRoutePolicyStore,
  SessionRoutePolicyValidationError,
  setSessionRoutePolicy,
} from "../src/server/session-route-policy";
import { beginRequestActivity, resetRequestActivityForTests } from "../src/server/request-activity";
import { addRequestLog, clearRequestLogsForTests } from "../src/server/request-log";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { handleResponses, handleResponsesCompact, resolveRequestCodexAuth } from "../src/server/responses";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { CodexDirectAuthenticationError, CodexPoolAuthenticationError } from "../src/codex/auth-context";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../src/codex/routing";

let testDir: string;
let previousHome: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-session-policy-"));
  previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = testDir;
  resetSessionRoutePolicyStoreForTests();
  resetRequestActivityForTests();
  clearRequestLogsForTests();
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
});

afterEach(() => {
  resetSessionRoutePolicyStoreForTests();
  resetRequestActivityForTests();
  clearRequestLogsForTests();
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(testDir, { recursive: true, force: true });
});

const managementConfig: OcxConfig = {
  port: 0,
  defaultProvider: "none",
  providers: {},
};

function directAuthConfig(accountIds: string[] = ["pool-a", "pool-b"]): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
    codexAccounts: accountIds.map(id => ({
      id,
      email: `${id}@example.test`,
      isMain: false,
      chatgptAccountId: `chatgpt-${id}`,
    })),
    activeCodexAccountId: accountIds[0],
    autoSwitchThreshold: 0,
  };
}

function savePoolCredential(accountId: string): void {
  saveCodexAccountCredential(accountId, {
    accessToken: `access-${accountId}`,
    refreshToken: `refresh-${accountId}`,
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: `chatgpt-${accountId}`,
  });
}

async function policyRequest(
  method: string,
  encodedRootSessionId: string,
  body?: unknown,
  headers: HeadersInit = {},
): Promise<Response> {
  const requestHeaders = new Headers(headers);
  if (body !== undefined) requestHeaders.set("content-type", "application/json");
  const req = new Request(`http://127.0.0.1/api/sessions/${encodedRootSessionId}/route-policy`, {
    method,
    headers: requestHeaders,
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  const response = await handleManagementAPI(req, new URL(req.url), managementConfig);
  if (!response) throw new Error("policy API was not handled");
  return response;
}

describe("session route policy store", () => {
  test("missing store defaults every valid or invalid session to inherit", () => {
    const store = new SessionRoutePolicyStore(join(testDir, "missing.json"));
    expect(store.get("root-a")).toBe("inherit");
    expect(store.get("")).toBe("inherit");
    expect(store.get("x".repeat(257))).toBe("inherit");
    expect(store.snapshot()).toEqual([]);
  });

  test("corrupt top-level content starts empty, warns, and leaves the source untouched", () => {
    const path = join(testDir, "corrupt.json");
    const content = "{not-json";
    writeFileSync(path, content, { mode: 0o600 });
    const warnings: string[] = [];

    const store = new SessionRoutePolicyStore(path, { warn: message => warnings.push(message) });

    expect(store.snapshot()).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  test("drops malformed rows while preserving valid minimal records", () => {
    const path = join(testDir, "rows.json");
    writeFileSync(path, JSON.stringify([
      { rootSessionId: " root-b ", routePolicy: "personal_first", updatedAt: "2026-07-21T00:00:00.000Z" },
      { rootSessionId: "bad-policy", routePolicy: "company_only", updatedAt: "2026-07-21T00:00:00.000Z" },
      { rootSessionId: "bad-date", routePolicy: "inherit", updatedAt: "not-a-date" },
      { rootSessionId: "bad\u0000id", routePolicy: "inherit", updatedAt: "2026-07-21T00:00:00.000Z" },
      { rootSessionId: "x".repeat(257), routePolicy: "inherit", updatedAt: "2026-07-21T00:00:00.000Z" },
      null,
    ]));

    const store = new SessionRoutePolicyStore(path);

    expect(store.snapshot()).toEqual([{
      rootSessionId: "root-b",
      routePolicy: "personal_first",
      updatedAt: "2026-07-21T00:00:00.000Z",
    }]);
  });

  test("writes deterministically, reloads, and keeps owner-only permissions", () => {
    const path = getSessionRoutePolicyPath();
    setSessionRoutePolicy("root-z", "personal_first", Date.parse("2026-07-21T02:00:00.000Z"));
    setSessionRoutePolicy("root-a", "inherit", Date.parse("2026-07-21T01:00:00.000Z"));

    const persisted = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>;
    expect(persisted.map(record => record.rootSessionId)).toEqual(["root-a", "root-z"]);
    expect(Object.keys(persisted[0]!).sort()).toEqual(["rootSessionId", "routePolicy", "updatedAt"].sort());
    if (process.platform !== "win32") {
      expect(statSync(testDir).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }

    resetSessionRoutePolicyStoreForTests();
    expect(getSessionRoutePolicy("root-z")).toBe("personal_first");
    expect(getSessionRoutePolicy("root-a")).toBe("inherit");
  });

  test("same-value writes are idempotent", () => {
    let writes = 0;
    const store = new SessionRoutePolicyStore(join(testDir, "virtual.json"), {
      exists: () => false,
      write: () => { writes += 1; },
    });

    const first = store.set("root-a", "personal_first", 1_800_000_000_000);
    const second = store.set("root-a", "personal_first", 1_800_000_001_000);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.record.updatedAt).toBe(first.record.updatedAt);
    expect(writes).toBe(1);
  });

  test("failed atomic write leaves the previous in-memory policy intact", () => {
    const initial = JSON.stringify([{
      rootSessionId: "root-a",
      routePolicy: "inherit",
      updatedAt: "2026-07-21T00:00:00.000Z",
    }]);
    const store = new SessionRoutePolicyStore(join(testDir, "virtual.json"), {
      exists: () => true,
      read: () => initial,
      write: () => { throw new Error("disk unavailable"); },
    });

    expect(() => store.set("root-a", "personal_first")).toThrow("disk unavailable");
    expect(store.get("root-a")).toBe("inherit");
    expect(store.snapshot()).toHaveLength(1);
  });

  test("production singleton follows OPENCODEX_HOME without sharing policy state", () => {
    setSessionRoutePolicy("root-a", "personal_first");
    const secondHome = join(testDir, "second-home");
    mkdirSync(secondHome, { recursive: true });
    process.env.OPENCODEX_HOME = secondHome;

    expect(getSessionRoutePolicy("root-a")).toBe("inherit");
    setSessionRoutePolicy("root-b", "personal_first");

    process.env.OPENCODEX_HOME = testDir;
    expect(getSessionRoutePolicy("root-a")).toBe("personal_first");
    expect(getSessionRoutePolicy("root-b")).toBe("inherit");
  });

  test("rejects invalid writes without touching storage", () => {
    let writes = 0;
    const store = new SessionRoutePolicyStore(join(testDir, "virtual.json"), {
      exists: () => false,
      write: () => { writes += 1; },
    });

    expect(() => store.set("", "personal_first")).toThrow(SessionRoutePolicyValidationError);
    expect(() => store.set("root-a", "company_only")).toThrow(SessionRoutePolicyValidationError);
    expect(() => store.set("root-a", "inherit", Number.NaN)).toThrow(SessionRoutePolicyValidationError);
    expect(writes).toBe(0);
  });
});

describe("session route policy management API", () => {
  test("GET returns inherit for an unknown valid Session", async () => {
    const response = await policyRequest("GET", "root-unknown");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      rootSessionId: "root-unknown",
      routePolicy: "inherit",
      appliesTo: "future_requests",
    });
  });

  test("PUT rejects unobserved Sessions and accepts active Sessions idempotently", async () => {
    const unknown = await policyRequest("PUT", "root-active", { routePolicy: "personal_first" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "session_not_found" });

    beginRequestActivity("request-1", Date.now(), {
      rootSessionId: "root-active",
      executionSessionId: "child-1",
    });
    const first = await policyRequest("PUT", "root-active", { routePolicy: "personal_first" });
    const second = await policyRequest("PUT", "root-active", { routePolicy: "personal_first" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toMatchObject({ rootSessionId: "root-active", routePolicy: "personal_first" });
    expect(await second.json()).toMatchObject({ rootSessionId: "root-active", routePolicy: "personal_first" });
    expect(getSessionRoutePolicy("root-active")).toBe("personal_first");
  });

  test("recent request logs count as observed without exposing request details", async () => {
    addRequestLog({
      requestId: "request-log-1",
      timestamp: Date.now(),
      model: "model-a",
      provider: "provider-a",
      rootSessionId: "root-from-log",
      status: 200,
      durationMs: 1,
      usageStatus: "unreported",
    });

    const response = await policyRequest("PUT", "root-from-log", { routePolicy: "personal_first" });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain("request-log-1");
    expect(text).not.toContain("provider-a");
    expect(text).not.toContain("model-a");
  });

  test("supports encoded slash IDs and future inherit toggles", async () => {
    beginRequestActivity("request-2", Date.now(), { rootSessionId: "team/sub-session" });
    const enabled = await policyRequest("PUT", "team%2Fsub-session", { routePolicy: "personal_first" });
    const disabled = await policyRequest("PUT", "team%2Fsub-session", { routePolicy: "inherit" });

    expect(enabled.status).toBe(200);
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ rootSessionId: "team/sub-session", routePolicy: "inherit" });
  });

  test("rejects malformed IDs, bodies, policies, and unsupported methods", async () => {
    const cases = [
      policyRequest("GET", ""),
      policyRequest("GET", "%ZZ"),
      policyRequest("GET", encodeURIComponent("bad\u0000id")),
      policyRequest("GET", "x".repeat(257)),
      policyRequest("PUT", "root-a", "{not-json"),
      policyRequest("PUT", "root-a", { routePolicy: "company_only" }),
      policyRequest("PUT", "root-a", { routePolicy: "inherit", extra: true }),
    ];
    const responses = await Promise.all(cases);
    expect(responses.map(response => response.status)).toEqual([400, 400, 400, 400, 400, 400, 400]);
    expect((await policyRequest("POST", "root-a", {})).status).toBe(405);
  });

  test("rejects foreign origins through the existing management guard", async () => {
    const response = await policyRequest(
      "PUT",
      "root-a",
      { routePolicy: "personal_first" },
      { origin: "https://attacker.example" },
    );
    expect(response.status).toBe(403);
  });

  test("returns persist_failed without changing policy when the owner path is unwritable", async () => {
    const blockedHome = join(testDir, "blocked-home");
    writeFileSync(blockedHome, "not-a-directory", { mode: 0o600 });
    process.env.OPENCODEX_HOME = blockedHome;
    resetSessionRoutePolicyStoreForTests();
    beginRequestActivity("request-3", Date.now(), { rootSessionId: "root-fail" });

    const response = await policyRequest("PUT", "root-fail", { routePolicy: "personal_first" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "persist_failed" });
    expect(getSessionRoutePolicy("root-fail")).toBe("inherit");
  });

  test("policy responses never expose account or credential material", async () => {
    const secrets = ["access-secret", "refresh-secret", "account-secret"];
    beginRequestActivity("request-secret", Date.now(), { rootSessionId: "root-secret" });
    const response = await policyRequest("PUT", "root-secret", { routePolicy: "personal_first" });
    const text = await response.text();

    expect(response.status).toBe(200);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).not.toContain("accountId");
  });
});

describe("session route policy auth selection", () => {
  test("ordinary responses and compact apply the request-scoped Pool credential", async () => {
    const config = directAuthConfig();
    savePoolCredential("pool-a");
    setSessionRoutePolicy("root-wire", "personal_first");
    const originalFetch = globalThis.fetch;
    const seen: Array<{ authorization: string | null; accountId: string | null }> = [];
    globalThis.fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        authorization: headers.get("authorization"),
        accountId: headers.get("chatgpt-account-id"),
      });
      return Response.json({
        id: "response-test",
        object: "response",
        status: "completed",
        model: "gpt-test",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    };

    try {
      const headers = {
        "content-type": "application/json",
        authorization: "Bearer caller-token",
        "x-codex-session-id": "root-wire",
      };
      const ordinary = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "gpt-test", input: "hello", stream: false }),
      }), config, { model: "", provider: "" });
      const compact = await handleResponsesCompact(new Request("http://localhost/v1/responses/compact", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "gpt-test", input: [] }),
      }), config, { model: "", provider: "" });

      expect(ordinary.status).toBe(200);
      expect(compact.status).toBe(200);
      expect(seen).toEqual([
        { authorization: "Bearer access-pool-a", accountId: "chatgpt-pool-a" },
        { authorization: "Bearer access-pool-a", accountId: "chatgpt-pool-a" },
      ]);
      expect(config.providers.openai?.codexAccountMode).toBe("direct");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("personal_first temporarily selects Pool while preserving global Direct mode", async () => {
    const config = directAuthConfig();
    savePoolCredential("pool-a");
    savePoolCredential("pool-b");
    setSessionRoutePolicy("root-a", "personal_first");

    const selection = await resolveRequestCodexAuth(
      new Headers({ authorization: "Bearer caller-token" }),
      config,
      "direct",
      "root-a",
    );

    expect(selection).toMatchObject({
      mode: "pool",
      routePolicy: "personal_first",
      usedConfiguredFallback: false,
      context: { kind: "pool", accountId: "pool-a" },
    });
    expect(config.providers.openai?.codexAccountMode).toBe("direct");
  });

  test("main and child selections share the policy root account after the next-account pointer changes", async () => {
    const config = directAuthConfig();
    savePoolCredential("pool-a");
    savePoolCredential("pool-b");
    setSessionRoutePolicy("root-shared", "personal_first");

    const main = await resolveRequestCodexAuth(
      new Headers({ authorization: "Bearer caller-token" }),
      config,
      "direct",
      "root-shared",
    );
    config.activeCodexAccountId = "pool-b";
    const child = await resolveRequestCodexAuth(
      new Headers({ authorization: "Bearer caller-token" }),
      config,
      "direct",
      "root-shared",
    );

    expect(main.context).toMatchObject({ accountId: "pool-a" });
    expect(child.context).toMatchObject({ accountId: "pool-a" });
    expect(config.providers.openai?.codexAccountMode).toBe("direct");
  });

  test("inherit keeps Direct caller ownership even when Pool credentials exist", async () => {
    const config = directAuthConfig();
    savePoolCredential("pool-a");
    setSessionRoutePolicy("root-inherit", "inherit");

    const selection = await resolveRequestCodexAuth(
      new Headers({ authorization: "Bearer caller-token" }),
      config,
      "direct",
      "root-inherit",
    );

    expect(selection).toEqual({
      context: { kind: "main", accountId: null },
      mode: "direct",
      routePolicy: "inherit",
      usedConfiguredFallback: false,
    });
  });

  test("personal_first falls back to configured Direct only for the current request", async () => {
    const config = directAuthConfig([]);
    delete config.activeCodexAccountId;
    setSessionRoutePolicy("root-fallback", "personal_first");

    const selection = await resolveRequestCodexAuth(
      new Headers({ authorization: "Bearer caller-token" }),
      config,
      "direct",
      "root-fallback",
    );

    expect(selection).toEqual({
      context: { kind: "main", accountId: null },
      mode: "direct",
      routePolicy: "personal_first",
      usedConfiguredFallback: true,
    });
    expect(config.providers.openai?.codexAccountMode).toBe("direct");
    expect(config.activeCodexAccountId).toBeUndefined();
  });

  test("personal_first cannot bypass Direct caller authentication", async () => {
    const config = directAuthConfig([]);
    delete config.activeCodexAccountId;
    setSessionRoutePolicy("root-no-caller", "personal_first");

    await expect(resolveRequestCodexAuth(new Headers(), config, "direct", "root-no-caller"))
      .rejects.toBeInstanceOf(CodexDirectAuthenticationError);
  });

  test("personal_first does not weaken an explicitly configured Pool fail-closed mode", async () => {
    const config = directAuthConfig([]);
    delete config.activeCodexAccountId;
    config.providers.openai!.codexAccountMode = "pool";
    setSessionRoutePolicy("root-pool", "personal_first");

    await expect(resolveRequestCodexAuth(
      new Headers({ authorization: "Bearer caller-token" }),
      config,
      "pool",
      "root-pool",
    )).rejects.toBeInstanceOf(CodexPoolAuthenticationError);
  });
});
