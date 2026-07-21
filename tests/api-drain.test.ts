// Goal: verify the read-only graceful-drain snapshot API across idle, active, and ready states.
// The tests call the management handler directly and reset lifecycle globals after every case.

import { afterEach, describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import {
  getActiveTurnCount,
  isDraining,
  registerTurn,
  setDraining,
  snapshotDrainState,
  unregisterTurn,
} from "../src/server/lifecycle";
import type { OcxConfig } from "../src/types";

const config: OcxConfig = {
  port: 10100,
  defaultProvider: "openai",
  providers: {},
};

const testControllers = new Set<AbortController>();

function registerTestTurn(): AbortController {
  const controller = new AbortController();
  testControllers.add(controller);
  registerTurn(controller);
  return controller;
}

function resetLifecycle(): void {
  for (const controller of testControllers) unregisterTurn(controller);
  testControllers.clear();
  setDraining(false);
}

async function requestDrain(method = "GET"): Promise<Response | null> {
  const request = new Request("http://127.0.0.1/api/drain", { method });
  return handleManagementAPI(request, new URL(request.url), config);
}

afterEach(resetLifecycle);

describe("GET /api/drain", () => {
  test("reports an idle pre-drain process as accepting but not ready", async () => {
    const response = await requestDrain();

    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      activeRequests: 0,
      acceptingRequests: true,
      ready: false,
      mode: "graceful",
    });
  });

  test("reports a draining process with an active controller as not ready", async () => {
    registerTestTurn();
    setDraining(true);

    const response = await requestDrain();

    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      activeRequests: 1,
      acceptingRequests: false,
      ready: false,
      mode: "graceful",
    });
  });

  test("reports ready after draining starts and the active controller unregisters", async () => {
    const controller = registerTestTurn();
    setDraining(true);
    unregisterTurn(controller);

    const response = await requestDrain();

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      activeRequests: 0,
      acceptingRequests: false,
      ready: true,
      mode: "graceful",
    });
  });

  test("repeated GETs do not change lifecycle state", async () => {
    const controller = registerTestTurn();
    setDraining(true);
    const before = snapshotDrainState();
    const activeBefore = getActiveTurnCount();

    const first = await requestDrain();
    const second = await requestDrain();

    expect(await first?.json()).toEqual(before);
    expect(await second?.json()).toEqual(before);
    expect(snapshotDrainState()).toEqual(before);
    expect(getActiveTurnCount()).toBe(activeBefore);
    expect(isDraining()).toBe(true);
    expect(controller.signal.aborted).toBe(false);
  });

  test("unsupported methods do not invoke the GET contract", async () => {
    setDraining(true);
    const before = snapshotDrainState();

    const response = await requestDrain("POST");

    expect(response).toBeNull();
    expect(snapshotDrainState()).toEqual(before);
  });
});
