import { describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import { buildHealthReport } from "../src/server/health";
import type { OcxConfig } from "../src/types";
import type { PersistedUsageEntry } from "../src/usage/log";

const now = Date.UTC(2026, 6, 21, 12, 0, 0);

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://api.example.test/v1",
        authMode: "forward",
      },
    },
    ...overrides,
  };
}

function failedEntry(timestamp: number): PersistedUsageEntry {
  return {
    requestId: "request-health",
    timestamp,
    provider: "openai",
    model: "gpt-test",
    status: 502,
    durationMs: 100,
    usageStatus: "unreported",
    terminalStatus: "failed",
  };
}

describe("health classification", () => {
  test("is healthy when the handler, incident reader, and default provider config are available", () => {
    expect(buildHealthReport(config(), { now, readEntries: () => [] })).toEqual({
      status: "healthy",
      components: [
        { name: "relay", status: "healthy", detail: "HTTP handler is running", checkedAt: "2026-07-21T12:00:00.000Z" },
        { name: "incident_history", status: "healthy", detail: "persistent incident history is readable", checkedAt: "2026-07-21T12:00:00.000Z" },
        { name: "default_provider", status: "healthy", detail: "configured; active upstream probe is disabled", checkedAt: "2026-07-21T12:00:00.000Z" },
      ],
    });
  });

  test("degrades relay only for a recent persisted error, not an old error", () => {
    const recent = buildHealthReport(config(), { now, readEntries: () => [failedEntry(now - 1_000)] });
    expect(recent.status).toBe("degraded");
    expect(recent.components.find(item => item.name === "relay")?.status).toBe("degraded");

    const old = buildHealthReport(config(), { now, readEntries: () => [failedEntry(now - 10 * 60_000)] });
    expect(old.status).toBe("healthy");
  });

  test("reports storage and provider configuration failures without exposing reader errors", () => {
    const report = buildHealthReport(config({ defaultProvider: "missing" }), {
      now,
      readEntries: () => { throw new Error("private path and secret"); },
    });

    expect(report.status).toBe("degraded");
    expect(report.components.find(item => item.name === "incident_history")).toMatchObject({
      status: "degraded",
      detail: "persistent incident history is unavailable",
    });
    expect(report.components.find(item => item.name === "default_provider")?.status).toBe("degraded");
    expect(JSON.stringify(report)).not.toContain("private path");
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  test("reports a disabled default provider as degraded", () => {
    const current = config();
    current.providers.openai!.disabled = true;
    const report = buildHealthReport(current, { now, readEntries: () => [] });
    expect(report.status).toBe("degraded");
    expect(report.components.find(item => item.name === "default_provider")?.detail).toBe("default provider is disabled");
  });
});

describe("GET /api/health", () => {
  test("returns the stable local health report without probing upstream", async () => {
    const request = new Request("http://127.0.0.1/api/health");
    const response = await handleManagementAPI(request, new URL(request.url), config(), {
      readUsageEntries: () => [],
      healthNow: () => now,
    });

    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body.status).toBe("healthy");
    expect(body.components).toHaveLength(3);
    expect(JSON.stringify(body)).not.toContain("api.example.test");
  });
});
