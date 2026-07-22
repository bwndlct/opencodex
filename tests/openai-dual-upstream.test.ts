/**
 * Test goal: verify the public OpenAI dual-upstream coordinator and its integration boundary.
 * The unit cases use an in-memory Fake attempt runner and tracked streams to assert route order,
 * account-by-account retries, fallback status policy, first-byte failures, lifecycle ownership,
 * and the inherited-policy persistence boundary. The integration case runs handleResponses through
 * a local Bun upstream and forces the first pool account's token refresh to fail, proving the
 * onCodexAccountAttempted handoff reaches the next personal account before company fallback.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, saveConfig } from "../src/config";
import { clearAccountNeedsReauth, clearAccountQuota } from "../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../src/codex/routing";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import {
  effectiveOpenAiRoutePolicy,
  isBareOpenAiModel,
  runOpenAiDualUpstream,
  type OpenAiDualAttempt,
  type OpenAiDualAttemptResult,
  type OpenAiDualUpstream,
} from "../src/server/openai-dual-upstream";
import { resetSessionRoutePolicyStoreForTests } from "../src/server/session-route-policy";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";

type DualRoutePolicy = "personal_first" | "company_first";

interface DualConfigOptions {
  defaultPolicy?: DualRoutePolicy;
  autoSwitchToCompany?: boolean;
  personalBaseUrl?: string;
  companyBaseUrl?: string;
}

interface AttemptLifecycle {
  commits: number;
  discards: number;
}

interface TrackedAttempt {
  lifecycle: AttemptLifecycle;
  result: OpenAiDualAttemptResult;
}

interface CancellableResponse {
  response: Response;
  wasCancelled: () => boolean;
}

const TEST_ACCOUNT_IDS = ["personal-a", "personal-b", "token-fails", "token-next"];

let testHome = "";
let previousOpenCodeHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(async () => {
  previousOpenCodeHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  testHome = await mkdtemp(join(tmpdir(), "ocx-dual-upstream-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.CODEX_HOME = join(testHome, "codex");
  resetSessionRoutePolicyStoreForTests();
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  for (const accountId of TEST_ACCOUNT_IDS) clearAccountNeedsReauth(accountId);
});

afterEach(async () => {
  resetSessionRoutePolicyStoreForTests();
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  for (const accountId of TEST_ACCOUNT_IDS) clearAccountNeedsReauth(accountId);
  if (previousOpenCodeHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodeHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  await rm(testHome, { recursive: true, force: true });
});

function dualConfig(options: DualConfigOptions = {}): OcxConfig {
  const personalBaseUrl = options.personalBaseUrl ?? "https://chatgpt.com/backend-api/codex";
  const companyBaseUrl = options.companyBaseUrl ?? "https://company.example/v1";
  return {
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: personalBaseUrl,
        authMode: "forward",
        codexAccountMode: "pool",
        ...(options.personalBaseUrl ? { allowPrivateNetwork: true } : {}),
      },
      company: {
        adapter: "openai-responses",
        baseUrl: companyBaseUrl,
        authMode: "passthrough",
        ...(options.companyBaseUrl ? { allowPrivateNetwork: true } : {}),
      },
    },
    openAiDualUpstream: {
      companyProvider: "company",
      defaultPolicy: options.defaultPolicy ?? "company_first",
      ...(options.autoSwitchToCompany === undefined ? {} : { autoSwitchToCompany: options.autoSwitchToCompany }),
    },
  };
}

function successResponse(body = "ok"): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
}

function emptyStreamResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  }), { status: 200 });
}

function pendingResponse(status: number): CancellableResponse {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { status }),
    wasCancelled: () => cancelled,
  };
}

function firstByteErrorResponse(cause: unknown): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(cause);
    },
  }), { status: 200 });
}

function trackedAttempt(response: Response, personalAccountId?: string): TrackedAttempt {
  const lifecycle: AttemptLifecycle = { commits: 0, discards: 0 };
  return {
    lifecycle,
    result: {
      response,
      ...(personalAccountId ? { personalAccountId } : {}),
      commit: () => { lifecycle.commits += 1; },
      discard: () => { lifecycle.discards += 1; },
    },
  };
}

class FakeOpenAiDualAttemptRunner {
  readonly calls: Array<{
    upstream: OpenAiDualUpstream;
    providerName: string;
    excludedAccountIds: string[];
  }> = [];
  private nextIndex = 0;

  constructor(private readonly fixtures: readonly TrackedAttempt[]) {}

  readonly run = async (spec: OpenAiDualAttempt): Promise<OpenAiDualAttemptResult> => {
    this.calls.push({
      upstream: spec.upstream,
      providerName: spec.providerName,
      excludedAccountIds: [...spec.excludedAccountIds],
    });
    const fixture = this.fixtures[this.nextIndex++];
    if (!fixture) throw new Error("FakeOpenAiDualAttemptRunner ran out of fixtures");
    return fixture.result;
  };
}

function exhaustedPersonalFixtures(companyResponse = new Response(null, { status: 400 })): TrackedAttempt[] {
  return [
    trackedAttempt(new Response(null, { status: 401 }), "personal-a"),
    trackedAttempt(new Response(null, { status: 401 })),
    trackedAttempt(companyResponse),
  ];
}

describe("OpenAI dual-upstream public helpers", () => {
  test("recognizes bare OpenAI models and resolves explicit policies before config defaults", () => {
    expect(isBareOpenAiModel("gpt-5.5")).toBe(true);
    expect(isBareOpenAiModel("o3-mini")).toBe(true);
    expect(isBareOpenAiModel("openai/gpt-5.5")).toBe(false);
    expect(isBareOpenAiModel("claude-sonnet-4")).toBe(false);
    expect(isBareOpenAiModel(null)).toBe(false);

    const config = dualConfig({ defaultPolicy: "company_first" });
    expect(effectiveOpenAiRoutePolicy(config, "personal_first")).toBe("personal_first");
    expect(effectiveOpenAiRoutePolicy(config, "company_first")).toBe("company_first");
    expect(effectiveOpenAiRoutePolicy(config, "inherit")).toBe("company_first");
  });

  test("requires dual-upstream configuration", async () => {
    const config = dualConfig();
    delete config.openAiDualUpstream;

    await expect(runOpenAiDualUpstream(config, "inherit", async () => {
      throw new Error("attempt should not run");
    })).rejects.toThrow("OpenAI dual-upstream routing is not configured");
  });
});

describe("runOpenAiDualUpstream route order", () => {
  const routeCases: Array<{ policy: DualRoutePolicy; expected: OpenAiDualUpstream }> = [
    { policy: "personal_first", expected: "personal" },
    { policy: "company_first", expected: "company" },
  ];

  for (const routeCase of routeCases) {
    test(`${routeCase.policy} tries ${routeCase.expected} first`, async () => {
      const first = trackedAttempt(successResponse(routeCase.expected));
      const runner = new FakeOpenAiDualAttemptRunner([first]);

      const result = await runOpenAiDualUpstream(
        dualConfig({ defaultPolicy: routeCase.policy }),
        "inherit",
        runner.run,
      );

      expect(runner.calls).toEqual([{
        upstream: routeCase.expected,
        providerName: routeCase.expected === "company" ? "company" : "openai",
        excludedAccountIds: [],
      }]);
      expect(result.upstream).toBe(routeCase.expected);
      expect(result.fallbackReason).toBeUndefined();
      expect(result.autoSwitched).toBe(false);
      expect(await result.response.text()).toBe(routeCase.expected);
      expect(first.lifecycle).toEqual({ commits: 1, discards: 0 });
    });
  }

  test("treats an empty 200 response as a preflight failure and falls back", async () => {
    const company = trackedAttempt(emptyStreamResponse());
    const personal = trackedAttempt(successResponse("personal-after-empty"));
    const runner = new FakeOpenAiDualAttemptRunner([company, personal]);

    const result = await runOpenAiDualUpstream(dualConfig({ defaultPolicy: "company_first" }), "inherit", runner.run);

    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toBe("personal-after-empty");
    expect(result.upstream).toBe("personal");
    expect(result.fallbackReason).toBe("company_upstream_unavailable");
    expect(company.lifecycle).toEqual({ commits: 0, discards: 1 });
    expect(personal.lifecycle).toEqual({ commits: 1, discards: 0 });
  });
});

describe("runOpenAiDualUpstream personal account retries", () => {
  test("retries personal accounts one by one and carries the excluded set forward", async () => {
    const firstResponse = pendingResponse(401);
    const secondResponse = pendingResponse(429);
    const first = trackedAttempt(firstResponse.response, "personal-a");
    const second = trackedAttempt(secondResponse.response, "personal-b");
    const success = trackedAttempt(successResponse("personal-success"));
    const runner = new FakeOpenAiDualAttemptRunner([first, second, success]);

    const result = await runOpenAiDualUpstream(dualConfig({ defaultPolicy: "personal_first" }), "inherit", runner.run);

    expect(result.upstream).toBe("personal");
    expect(result.fallbackReason).toBeUndefined();
    expect(runner.calls).toEqual([
      { upstream: "personal", providerName: "openai", excludedAccountIds: [] },
      { upstream: "personal", providerName: "openai", excludedAccountIds: ["personal-a"] },
      { upstream: "personal", providerName: "openai", excludedAccountIds: ["personal-a", "personal-b"] },
    ]);
    expect(firstResponse.wasCancelled()).toBe(true);
    expect(secondResponse.wasCancelled()).toBe(true);
    expect(first.lifecycle).toEqual({ commits: 0, discards: 1 });
    expect(second.lifecycle).toEqual({ commits: 0, discards: 1 });
    expect(success.lifecycle).toEqual({ commits: 1, discards: 0 });
    expect(await result.response.text()).toBe("personal-success");
  });
});

describe("runOpenAiDualUpstream fallback status policy", () => {
  test("hops on retryable statuses and stops on non-retryable statuses for both upstreams", async () => {
    const retryableStatuses = [401, 403, 404, 408, 429, 500, 503];
    const nonRetryableStatuses = [400, 409, 422, 499];

    for (const status of retryableStatuses) {
      const personalFailure = pendingResponse(status);
      const personal = trackedAttempt(personalFailure.response);
      const company = trackedAttempt(successResponse("company-after-personal"));
      const personalRunner = new FakeOpenAiDualAttemptRunner([personal, company]);
      const personalResult = await runOpenAiDualUpstream(dualConfig({ defaultPolicy: "personal_first" }), "inherit", personalRunner.run);

      expect(personalResult.upstream).toBe("company");
      expect(personalResult.fallbackReason).toBe("all_personal_accounts_unavailable");
      expect(personalFailure.wasCancelled()).toBe(true);
      expect(personal.lifecycle).toEqual({ commits: 0, discards: 1 });
      expect(company.lifecycle).toEqual({ commits: 1, discards: 0 });

      const companyFailure = pendingResponse(status);
      const companyFirst = trackedAttempt(companyFailure.response);
      const personalAfterCompany = trackedAttempt(successResponse("personal-after-company"));
      const companyRunner = new FakeOpenAiDualAttemptRunner([companyFirst, personalAfterCompany]);
      const companyResult = await runOpenAiDualUpstream(dualConfig({ defaultPolicy: "company_first" }), "inherit", companyRunner.run);

      expect(companyResult.upstream).toBe("personal");
      expect(companyResult.fallbackReason).toBe("company_upstream_unavailable");
      expect(companyFailure.wasCancelled()).toBe(true);
      expect(companyFirst.lifecycle).toEqual({ commits: 0, discards: 1 });
      expect(personalAfterCompany.lifecycle).toEqual({ commits: 1, discards: 0 });
    }

    for (const status of nonRetryableStatuses) {
      const personalFailure = pendingResponse(status);
      const personal = trackedAttempt(personalFailure.response);
      const personalRunner = new FakeOpenAiDualAttemptRunner([personal]);
      const personalResult = await runOpenAiDualUpstream(dualConfig({ defaultPolicy: "personal_first" }), "inherit", personalRunner.run);

      expect(personalResult.upstream).toBe("personal");
      expect(personalResult.fallbackReason).toBeUndefined();
      expect(personalFailure.wasCancelled()).toBe(false);
      expect(personal.lifecycle).toEqual({ commits: 1, discards: 0 });

      const companyFailure = pendingResponse(status);
      const company = trackedAttempt(companyFailure.response);
      const companyRunner = new FakeOpenAiDualAttemptRunner([company]);
      const companyResult = await runOpenAiDualUpstream(dualConfig({ defaultPolicy: "company_first" }), "inherit", companyRunner.run);

      expect(companyResult.upstream).toBe("company");
      expect(companyResult.fallbackReason).toBeUndefined();
      expect(companyFailure.wasCancelled()).toBe(false);
      expect(company.lifecycle).toEqual({ commits: 1, discards: 0 });
    }
  });

  test("makes commit and discard mutually exclusive across first-byte fallback", async () => {
    const company = trackedAttempt(firstByteErrorResponse(new DOMException("stalled", "TimeoutError")));
    const personal = trackedAttempt(successResponse("personal-after-stall"));
    const runner = new FakeOpenAiDualAttemptRunner([company, personal]);

    const result = await runOpenAiDualUpstream(dualConfig({ defaultPolicy: "company_first" }), "inherit", runner.run);

    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toBe("personal-after-stall");
    expect(result.upstream).toBe("personal");
    expect(result.fallbackReason).toBe("company_upstream_unavailable");
    expect(company.lifecycle).toEqual({ commits: 0, discards: 1 });
    expect(personal.lifecycle).toEqual({ commits: 1, discards: 0 });
  });
});

describe("runOpenAiDualUpstream automatic switching", () => {
  test("persists company_first only after an inherited personal_first policy is exhausted", async () => {
    const config = dualConfig({ defaultPolicy: "personal_first" });
    const runner = new FakeOpenAiDualAttemptRunner(exhaustedPersonalFixtures(successResponse("company-success")));

    const result = await runOpenAiDualUpstream(config, "inherit", runner.run);

    expect(result.upstream).toBe("company");
    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toBe("company-success");
    expect(result.fallbackReason).toBe("all_personal_accounts_unavailable");
    expect(result.autoSwitched).toBe(true);
    expect(config.openAiDualUpstream?.defaultPolicy).toBe("company_first");
    expect(await readFile(getConfigPath(), "utf8")).toContain('"defaultPolicy": "company_first"');
  });

  test("does not persist an explicit personal_first session override", async () => {
    const config = dualConfig({ defaultPolicy: "personal_first" });
    const runner = new FakeOpenAiDualAttemptRunner(exhaustedPersonalFixtures(successResponse("company-success")));

    const result = await runOpenAiDualUpstream(config, "personal_first", runner.run);

    expect(result.upstream).toBe("company");
    expect(result.response.status).toBe(200);
    expect(result.autoSwitched).toBe(false);
    expect(config.openAiDualUpstream?.defaultPolicy).toBe("personal_first");
    await expect(readFile(getConfigPath(), "utf8")).rejects.toThrow();
  });

  test("does not persist when automatic switching is disabled", async () => {
    const config = dualConfig({ defaultPolicy: "personal_first", autoSwitchToCompany: false });
    const runner = new FakeOpenAiDualAttemptRunner(exhaustedPersonalFixtures(successResponse("company-success")));

    const result = await runOpenAiDualUpstream(config, "inherit", runner.run);

    expect(result.upstream).toBe("company");
    expect(result.response.status).toBe(200);
    expect(result.autoSwitched).toBe(false);
    expect(config.openAiDualUpstream?.defaultPolicy).toBe("personal_first");
    await expect(readFile(getConfigPath(), "utf8")).rejects.toThrow();
  });

  test("keeps personal_first and autoSwitched false when company fallback fails", async () => {
    const config = dualConfig({ defaultPolicy: "personal_first" });
    const runner = new FakeOpenAiDualAttemptRunner(exhaustedPersonalFixtures());

    const result = await runOpenAiDualUpstream(config, "inherit", runner.run);

    expect(result.upstream).toBe("company");
    expect(result.response.status).toBe(400);
    expect(result.autoSwitched).toBe(false);
    expect(config.openAiDualUpstream?.defaultPolicy).toBe("personal_first");
    await expect(readFile(getConfigPath(), "utf8")).rejects.toThrow();
  });

  const hotReloadChanges: Array<"companyProvider" | "defaultPolicy" | "autoSwitchToCompany"> = [
    "companyProvider",
    "defaultPolicy",
    "autoSwitchToCompany",
  ];
  for (const change of hotReloadChanges) {
    test(`does not overwrite a hot-reloaded ${change} during personal_first fallback`, async () => {
      const config = dualConfig({ defaultPolicy: "personal_first" });
      const updatedConfig = dualConfig({ defaultPolicy: "personal_first" });
      if (!updatedConfig.openAiDualUpstream) throw new Error("test config must enable dual upstream");
      if (change === "companyProvider") {
        updatedConfig.providers.alternateCompany = { ...updatedConfig.providers.company };
        updatedConfig.openAiDualUpstream.companyProvider = "alternateCompany";
      } else if (change === "defaultPolicy") {
        updatedConfig.openAiDualUpstream.defaultPolicy = "company_first";
      } else {
        updatedConfig.openAiDualUpstream.autoSwitchToCompany = false;
      }
      const expectedUpdatedDual = updatedConfig.openAiDualUpstream;

      saveConfig(config);
      const runner = new FakeOpenAiDualAttemptRunner(exhaustedPersonalFixtures(successResponse("company-after-reload")));
      const attempt = async (spec: OpenAiDualAttempt): Promise<OpenAiDualAttemptResult> => {
        if (spec.upstream === "company") saveConfig(updatedConfig);
        return runner.run(spec);
      };

      const result = await runOpenAiDualUpstream(config, "inherit", attempt);

      expect(result.upstream).toBe("company");
      expect(result.response.status).toBe(200);
      expect(await result.response.text()).toBe("company-after-reload");
      expect(result.autoSwitched).toBe(false);
      expect(config.openAiDualUpstream).toMatchObject({
        companyProvider: "company",
        defaultPolicy: "personal_first",
      });
      expect(JSON.parse(await readFile(getConfigPath(), "utf8")).openAiDualUpstream).toMatchObject(expectedUpdatedDual);
    });
  }
});

describe("handleResponses dual-upstream account handoff", () => {
  test("continues to the next personal account when the first token fetch fails", async () => {
    const personalRequests: Array<{ authorization: string | null; accountId: string | null }> = [];
    const companyRequests: Array<{ authorization: string | null; accountId: string | null }> = [];
    const personalUpstream = Bun.serve({
      port: 0,
      async fetch(request) {
        personalRequests.push({
          authorization: request.headers.get("authorization"),
          accountId: request.headers.get("chatgpt-account-id"),
        });
        return Response.json({
          id: "personal-response",
          object: "response",
          status: "completed",
          model: "gpt-5.5",
          output: [],
        });
      },
    });
    const companyUpstream = Bun.serve({
      port: 0,
      fetch(request) {
        companyRequests.push({
          authorization: request.headers.get("authorization"),
          accountId: request.headers.get("chatgpt-account-id"),
        });
        return Response.json({ id: "company-should-not-run", output: [] });
      },
    });
    const originalFetch = globalThis.fetch;

    saveCodexAccountCredential("token-fails", {
      accessToken: "expired-access",
      refreshToken: "revoked-refresh",
      expiresAt: 0,
      chatgptAccountId: "chatgpt-token-fails",
    });
    saveCodexAccountCredential("token-next", {
      accessToken: "next-access",
      refreshToken: "next-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "chatgpt-token-next",
    });
    const config = dualConfig({
      defaultPolicy: "personal_first",
      companyBaseUrl: `${companyUpstream.url.toString().replace(/\/$/, "")}/v1`,
    });
    config.codexAccounts = [
      { id: "token-fails", email: "first@example.test", isMain: false, chatgptAccountId: "chatgpt-token-fails" },
      { id: "token-next", email: "next@example.test", isMain: false, chatgptAccountId: "chatgpt-token-next" },
    ];
    config.activeCodexAccountId = "token-fails";
    config.autoSwitchThreshold = 0;

    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://auth.openai.com/oauth/token") {
        return Response.json({ error: "invalid_grant" }, { status: 401 });
      }
      if (url === "https://chatgpt.com/backend-api/codex/responses") {
        return originalFetch(`${personalUpstream.url.toString().replace(/\/$/, "")}/v1/responses`, init);
      }
      return originalFetch(input, init);
    };

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-session-id": "token-retry-root" },
        body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: false }),
      }), config, { model: "", provider: "" });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: "personal-response", model: "gpt-5.5" });
      expect(personalRequests).toEqual([{
        authorization: "Bearer next-access",
        accountId: "chatgpt-token-next",
      }]);
      expect(companyRequests).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      personalUpstream.stop();
      companyUpstream.stop();
    }
  });
});
