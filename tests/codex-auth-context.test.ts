import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCodexAuthContextToProvider,
  assertCodexAuthContextNotCooled,
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexDirectAuthenticationError,
  CodexThreadAffinityExpiredError,
  headersForCodexAuthContext,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
  shouldMarkAccountNeedsReauthForCodexAuthFailure,
  stripCodexRuntimeProviderFields,
} from "../src/codex/auth-context";
import {
  CodexCredentialGenerationConflictError,
  CodexCredentialRefreshLockTimeoutError,
  getCodexAccountCredential,
  removeCodexAccountCredential,
  saveCodexAccountCredential,
} from "../src/codex/account-store";
import { clearAccountNeedsReauth, isAccountNeedsReauth } from "../src/codex/auth-api";
import {
  CODEX_THREAD_AFFINITY_IDLE_TTL_MS,
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  recordCodexUpstreamOutcome,
} from "../src/codex/routing";
import { handleResponsesCompact } from "../src/server/responses";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

let testDir: string;
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-auth-ctx-"));
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = testDir;
  // Isolate the main-account credential source: testDir has no auth.json, so the main
  // account is deterministically absent (these cases test pool-only fail-closed behavior).
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = testDir;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountNeedsReauth("pool-a");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountNeedsReauth("pool-a");
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
});

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "routed",
    activeCodexAccountId: "pool-a",
    providers: {
      routed: { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "routed-key" },
      chatgpt: { adapter: "openai-responses", baseUrl: "https://chatgpt.test/backend-api/codex", authMode: "forward" },
    },
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "pool_acc" },
    ],
  };
}

const forwardProvider: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/backend-api/codex",
  authMode: "forward",
};

describe("Codex auth context", () => {
  test("direct mode returns caller-owned main context without touching pool selection", async () => {
    const cfg = { ...config(), activeCodexAccountId: "missing-pool-account" };
    await expect(resolveCodexAuthContext(
      new Headers({ authorization: "Bearer caller", "x-codex-parent-thread-id": "legacy-thread" }),
      cfg,
      "direct",
      { rootSessionId: "explicit-root" },
    ))
      .resolves.toEqual({ kind: "main", accountId: null });
  });
  test("direct mode fails locally without a caller bearer", async () => {
    await expect(resolveCodexAuthContext(new Headers(), config(), "direct"))
      .rejects.toBeInstanceOf(CodexDirectAuthenticationError);
    await expect(resolveCodexAuthContext(new Headers({ authorization: "Bearer   " }), config(), "direct"))
      .rejects.toBeInstanceOf(CodexDirectAuthenticationError);
  });
  test("selects pool auth independently of the routed provider", async () => {
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    });

    const ctx = await resolveCodexAuthContext(new Headers({ authorization: "Bearer main_token" }), config(), "pool");

    expect(ctx).toMatchObject({
      kind: "pool",
      accountId: "pool-a",
      generation: 1,
      accessToken: "pool_token",
      chatgptAccountId: "pool_acc",
    });
  });

  test("explicit root identity wins over a conflicting legacy header and fallback stays legacy-compatible", async () => {
    const cfg = {
      ...config(),
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 0,
      codexAccounts: [
        { id: "pool-a", email: "pool-a@example.test", isMain: false, chatgptAccountId: "pool_acc_a" },
        { id: "pool-b", email: "pool-b@example.test", isMain: false, chatgptAccountId: "pool_acc_b" },
      ],
    };
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token_a",
      refreshToken: "pool_refresh_a",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc_a",
    });
    saveCodexAccountCredential("pool-b", {
      accessToken: "pool_token_b",
      refreshToken: "pool_refresh_b",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc_b",
    });

    const main = await resolveCodexAuthContext(
      new Headers({ "x-codex-session-id": "root-session" }),
      cfg,
      "pool",
      { rootSessionId: "root-session" },
    );
    expect(main).toMatchObject({ accountId: "pool-a" });

    cfg.activeCodexAccountId = "pool-b";
    const legacy = await resolveCodexAuthContext(
      new Headers({ "x-codex-parent-thread-id": "legacy-thread" }),
      cfg,
      "pool",
    );
    expect(legacy).toMatchObject({ accountId: "pool-b" });

    const explicit = await resolveCodexAuthContext(
      new Headers({
        "x-codex-session-id": "child-session",
        "x-codex-parent-thread-id": "legacy-thread",
      }),
      cfg,
      "pool",
      { rootSessionId: "root-session" },
    );
    expect(explicit).toMatchObject({ accountId: "pool-a" });

    const fallback = await resolveCodexAuthContext(
      new Headers({ "x-codex-parent-thread-id": "legacy-thread" }),
      cfg,
      "pool",
    );
    expect(fallback).toMatchObject({ accountId: "pool-b" });
  });

  test("main and child requests keep the root-bound account after active account changes", async () => {
    const cfg = {
      ...config(),
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 0,
      codexAccounts: [
        { id: "pool-a", email: "pool-a@example.test", isMain: false, chatgptAccountId: "pool_acc_a" },
        { id: "pool-b", email: "pool-b@example.test", isMain: false, chatgptAccountId: "pool_acc_b" },
      ],
    };
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token_a",
      refreshToken: "pool_refresh_a",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc_a",
    });
    saveCodexAccountCredential("pool-b", {
      accessToken: "pool_token_b",
      refreshToken: "pool_refresh_b",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc_b",
    });

    const main = await resolveCodexAuthContext(
      new Headers({ "x-codex-session-id": "root-session" }),
      cfg,
      "pool",
      { rootSessionId: "root-session" },
    );
    cfg.activeCodexAccountId = "pool-b";
    const child = await resolveCodexAuthContext(
      new Headers({
        "x-codex-session-id": "child-session",
        "x-codex-parent-thread-id": "root-session",
      }),
      cfg,
      "pool",
      { rootSessionId: "root-session" },
    );

    expect(main).toMatchObject({ accountId: "pool-a" });
    expect(child).toMatchObject({ accountId: "pool-a" });
  });

  test("native compact resolves pool auth from the explicit root identity", async () => {
    const cfg: OcxConfig = {
      ...config(),
      defaultProvider: "openai",
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 0,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.test/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
      codexAccounts: [
        { id: "pool-a", email: "pool-a@example.test", isMain: false, chatgptAccountId: "pool_acc_a" },
        { id: "pool-b", email: "pool-b@example.test", isMain: false, chatgptAccountId: "pool_acc_b" },
      ],
    };
    const credentials: Array<[string, string]> = [["pool-a", "pool_acc_a"], ["pool-b", "pool_acc_b"]];
    for (const [accountId, chatgptAccountId] of credentials) {
      saveCodexAccountCredential(accountId, {
        accessToken: `pool_token_${accountId.slice(-1)}`,
        refreshToken: `pool_refresh_${accountId.slice(-1)}`,
        expiresAt: Date.now() + 5 * 60_000,
        chatgptAccountId,
      });
    }

    const root = "root-session";
    await resolveCodexAuthContext(new Headers(), cfg, "pool", { rootSessionId: root });
    cfg.activeCodexAccountId = "pool-b";

    const originalFetch = globalThis.fetch;
    let seen: { authorization: string | null; accountId: string | null } | undefined;
    const mockFetch: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      seen = {
        authorization: headers.get("authorization"),
        accountId: headers.get("chatgpt-account-id"),
      };
      return Response.json({ output: [] });
    };
    globalThis.fetch = mockFetch;

    try {
      const response = await handleResponsesCompact(
        new Request("http://localhost/v1/responses/compact", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-codex-session-id": "child-session",
          },
          body: JSON.stringify({ model: "gpt-test", parent_thread_id: root, input: [] }),
        }),
        cfg,
        { model: "", provider: "" },
      );

      expect(response.status).toBe(200);
      expect(seen).toEqual({ authorization: "Bearer pool_token_a", accountId: "pool_acc_a" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("selected pool headers replace inbound main auth", () => {
    const headers = headersForCodexAuthContext(
      new Headers({ authorization: "Bearer main_token", "chatgpt-account-id": "main_acc", "openai-beta": "responses=experimental" }),
      { kind: "pool", accountId: "pool-a", generation: 1, accessToken: "pool_token", chatgptAccountId: "pool_acc" },
    );

    expect(headers.get("authorization")).toBe("Bearer pool_token");
    expect(headers.get("chatgpt-account-id")).toBe("pool_acc");
    expect(headers.get("openai-beta")).toBe("responses=experimental");
  });

  test("company passthrough compact keeps the caller credential and excludes ChatGPT account headers", async () => {
    const cfg: OcxConfig = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://company.example/v1",
          authMode: "passthrough",
        },
      },
    };
    const originalFetch = globalThis.fetch;
    let seenUrl = "";
    let seenHeaders = new Headers();
    let seenBody: unknown;
    globalThis.fetch = async (input, init) => {
      seenUrl = String(input);
      seenHeaders = new Headers(init?.headers);
      seenBody = JSON.parse(String(init?.body));
      return Response.json({ output: [] });
    };

    try {
      const response = await handleResponsesCompact(new Request("http://localhost/v1/responses/compact", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer company-token",
          "chatgpt-account-id": "must-not-forward",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: [], reasoning: { effort: "high" } }),
      }), cfg, { model: "", provider: "" });

      expect(response.status).toBe(200);
      expect(seenUrl).toBe("https://company.example/v1/responses/compact");
      expect(seenHeaders.get("authorization")).toBe("Bearer company-token");
      expect(seenHeaders.get("chatgpt-account-id")).toBeNull();
      expect(seenBody).toEqual({ model: "gpt-5.6-sol", input: [], reasoning: { effort: "high" } });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("pool token failure marks reauth and throws before fallback", async () => {
    await expect(resolveCodexAuthContext(new Headers({ authorization: "Bearer main_token" }), config(), "pool"))
      .rejects.toBeInstanceOf(CodexAuthContextError);
    expect(isAccountNeedsReauth("pool-a")).toBe(true);
  });

  test("pool token failure error message does not expose local account id", async () => {
    try {
      await resolveCodexAuthContext(new Headers({ authorization: "Bearer main_token" }), config(), "pool");
      throw new Error("expected auth context failure");
    } catch (err) {
      expect(err).toBeInstanceOf(CodexAuthContextError);
      expect((err as Error).message).not.toContain("pool-a");
    }
  });

  test("cooled single pool account fails closed instead of falling back to inbound main auth", async () => {
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    const now = 1_800_000_000_000;
    recordCodexUpstreamOutcome(config(), "pool-a", 429, { retryAfter: "60", now });

    await expect(resolveCodexAuthContext(new Headers({ authorization: "Bearer main_token" }), config(), "pool"))
      .rejects.toBeInstanceOf(CodexAccountCooldownError);
  });

  test("expired thread affinity fails closed instead of falling back to main auth", async () => {
    const now = 1_800_000_000_000;
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: now + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    const originalNow = Date.now;
    const headers = new Headers({
      authorization: "Bearer main_token",
      "x-codex-parent-thread-id": "expired-auth-context",
    });
    try {
      Date.now = () => now;
      await expect(resolveCodexAuthContext(headers, config(), "pool")).resolves.toMatchObject({
        kind: "pool",
        accountId: "pool-a",
      });

      Date.now = () => now + CODEX_THREAD_AFFINITY_IDLE_TTL_MS + 1;
      await expect(resolveCodexAuthContext(headers, config(), "pool"))
        .rejects.toBeInstanceOf(CodexThreadAffinityExpiredError);
    } finally {
      Date.now = originalNow;
    }
  });

  test("cached pool auth context is rejected while cooled and accepted after expiry", () => {
    const originalNow = Date.now;
    const now = 1_800_000_000_000;
    const ctx = { kind: "pool" as const, accountId: "pool-a", generation: 1, accessToken: "pool_token", chatgptAccountId: "pool_acc" };
    try {
      recordCodexUpstreamOutcome(config(), "pool-a", 429, { retryAfter: "60", now });
      Date.now = () => now + 1_000;
      expect(() => assertCodexAuthContextNotCooled(ctx)).toThrow(CodexAccountCooldownError);

      Date.now = () => now + 61_000;
      expect(() => assertCodexAuthContextNotCooled(ctx)).not.toThrow();
      expect(() => assertCodexAuthContextNotCooled({ kind: "main", accountId: null })).not.toThrow();
    } finally {
      Date.now = originalNow;
    }
  });

  test("generation conflict does not mark account as reauth-needed", async () => {
    saveCodexAccountCredential("pool-a", {
      accessToken: "old_token",
      refreshToken: "old_refresh",
      expiresAt: 0,
      chatgptAccountId: "pool_acc",
    });
    const replacement = {
      accessToken: "replacement_token",
      refreshToken: "replacement_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      saveCodexAccountCredential("pool-a", replacement);
      return new Response(JSON.stringify({ access_token: "stale_token", expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;

    try {
      await expect(resolveCodexAuthContext(new Headers({ authorization: "Bearer main_token" }), config(), "pool"))
        .rejects.toBeInstanceOf(CodexAuthContextError);
      expect(isAccountNeedsReauth("pool-a")).toBe(false);
      expect(getCodexAccountCredential("pool-a")).toEqual(replacement);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reauth marking is reserved for real token failures", () => {
    expect(shouldMarkAccountNeedsReauthForCodexAuthFailure(new CodexCredentialGenerationConflictError())).toBe(false);
    expect(shouldMarkAccountNeedsReauthForCodexAuthFailure(new CodexCredentialRefreshLockTimeoutError())).toBe(false);
    expect(shouldMarkAccountNeedsReauthForCodexAuthFailure(new Error("bad token"))).toBe(true);
  });

  test("runtime provider metadata is applied only to forward provider copies", () => {
    const ctx = { kind: "pool" as const, accountId: "pool-a", generation: 1, accessToken: "pool_token", chatgptAccountId: "pool_acc" };
    const runtimeForward = applyCodexAuthContextToProvider(forwardProvider, ctx, "pool");
    expect(runtimeForward).toMatchObject({
      _codexAccountRequired: true,
      _codexAccountOverride: { accessToken: "pool_token", chatgptAccountId: "pool_acc" },
    });
    expect(forwardProvider).not.toHaveProperty("_codexAccountOverride");

    const routed = { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "routed-key" };
    expect(applyCodexAuthContextToProvider(routed, ctx, "pool")).toBe(routed);
  });

  test("runtime provider metadata is stripped before persistence", () => {
    const runtimeProvider = {
      ...forwardProvider,
      _codexAccountRequired: true,
      _codexAccountOverride: { accessToken: "pool_token", chatgptAccountId: "pool_acc" },
    };

    const stripped = stripCodexRuntimeProviderFields(runtimeProvider);

    expect(stripped).not.toHaveProperty("_codexAccountRequired");
    expect(stripped).not.toHaveProperty("_codexAccountOverride");
    expect(stripped).toMatchObject(forwardProvider);
  });

  test("auth context usability follows account lifecycle state", () => {
    const cfg = config();
    const ctx = { kind: "pool" as const, accountId: "pool-a", generation: 1, accessToken: "pool_token", chatgptAccountId: "pool_acc" };

    expect(isCodexAuthContextUsable({ kind: "main", accountId: null }, cfg)).toBe(true);
    expect(isCodexAuthContextUsable(ctx, cfg)).toBe(false);

    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    expect(isCodexAuthContextUsable(ctx, cfg)).toBe(true);

    saveCodexAccountCredential("pool-a", {
      accessToken: "replacement_token",
      refreshToken: "replacement_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    expect(isCodexAuthContextUsable(ctx, cfg)).toBe(false);

    const replacementCtx = { ...ctx, generation: 2, accessToken: "replacement_token" };
    expect(isCodexAuthContextUsable(replacementCtx, cfg)).toBe(true);

    removeCodexAccountCredential("pool-a");
    expect(isCodexAuthContextUsable(replacementCtx, cfg)).toBe(false);

    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    cfg.codexAccounts = cfg.codexAccounts?.filter(account => account.id !== "pool-a");
    expect(isCodexAuthContextUsable({ ...ctx, generation: 4 }, cfg)).toBe(false);
  });
});
