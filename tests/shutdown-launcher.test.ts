/**
 * Regression: launcher signals must preserve the intended proxy lifecycle.
 *
 * This black-box integration test sends signals only to the real Node launcher and
 * verifies that SIGINT/SIGTERM gracefully stop the Bun proxy, while SIGHUP reloads
 * configuration and keeps both processes healthy until a later SIGTERM.
 *
 * POSIX-only (Windows has no real signal forwarding semantics) and requires `node`
 * on PATH to exercise the real launcher.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN_OCX = join(import.meta.dir, "..", "bin", "ocx.mjs");
const nodeAvailable = !spawnSync("node", ["--version"], { stdio: "ignore" }).error;
const runnable = process.platform !== "win32" && nodeAvailable;

const spawned: ChildProcess[] = [];
const tmpHomes: string[] = [];

type LauncherRun = {
  home: string;
  port: number;
  codexConfig: string;
  child: ChildProcess;
  proxyPid: number;
  hasExited: () => boolean;
};

afterAll(() => {
  for (const c of spawned) {
    try { c.kill("SIGKILL"); } catch { /* already gone */ }
  }
  for (const dir of tmpHomes) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntil(fn: () => Promise<boolean>, deadlineMs: number): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await Bun.sleep(250);
  }
  return false;
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startLauncher(): Promise<LauncherRun> {
  const home = mkdtempSync(join(tmpdir(), "ocx-shutdown-"));
  tmpHomes.push(home);
  const port = await freePort();

  // Seed a native Codex config so the proxy actually injects on start (injectCodexConfig
  // no-ops when no config.toml exists) — this lets us prove the config is RESTORED.
  const codexConfig = join(home, "config.toml");
  writeFileSync(codexConfig, 'model = "gpt-5.1"\n');

  const child = spawn("node", [BIN_OCX, "start", "--port", String(port)], {
    stdio: "ignore",
    env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: home },
  });
  spawned.push(child);

  let exited = false;
  child.on("exit", () => { exited = true; });

  // Proxy comes up + injected the Codex config (Design B root override on loopback).
  const up = await waitUntil(() => healthy(port), 20_000);
  expect(up).toBe(true);
  expect(existsSync(join(home, "ocx.pid"))).toBe(true);
  const injected = readFileSync(codexConfig, "utf8");
  expect(injected).toContain("# Auto-injected by opencodex");
  expect(injected).toContain(`openai_base_url = "http://127.0.0.1:${port}/v1"`);
  expect(injected).not.toContain("model_providers.opencodex");

  const proxyPid = Number.parseInt(readFileSync(join(home, "ocx.pid"), "utf8"), 10);
  expect(Number.isInteger(proxyPid)).toBe(true);
  expect(proxyPid).toBeGreaterThan(0);

  return { home, port, codexConfig, child, proxyPid, hasExited: () => exited };
}

async function expectCleanShutdown(run: LauncherRun, signal: "SIGINT" | "SIGTERM"): Promise<void> {
  // Signal ONLY the launcher PID (the exact orphan trigger).
  run.child.kill(signal);

  // Launcher exits...
  const launcherGone = await waitUntil(async () => run.hasExited(), 15_000);
  expect(launcherGone).toBe(true);

  // ...and the Bun proxy is gone (port freed) — the regression guard.
  const portFreed = await waitUntil(async () => !(await healthy(run.port)), 10_000);
  expect(portFreed).toBe(true);

  // Graceful cleanup ran: pid + runtime-port removed, Codex config restored.
  expect(existsSync(join(run.home, "ocx.pid"))).toBe(false);
  expect(existsSync(join(run.home, "runtime-port.json"))).toBe(false);
  expect(readFileSync(run.codexConfig, "utf8")).not.toContain("opencodex");
}

describe.skipIf(!runnable)("ocx launcher graceful shutdown", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(
      `${signal} to the launcher tears down the Bun proxy and restores Codex config (no orphan)`,
      async () => {
        const run = await startLauncher();
        await expectCleanShutdown(run, signal);
      },
      45_000,
    );
  }

  test(
    "SIGHUP to the launcher reloads config while launcher and Bun proxy stay alive, then SIGTERM cleans up",
    async () => {
      const run = await startLauncher();

      // Signal ONLY the launcher PID; SIGHUP must reload instead of shutting down.
      run.child.kill("SIGHUP");
      await Bun.sleep(1_000);

      expect(run.hasExited()).toBe(false);
      expect(isProcessAlive(run.child.pid)).toBe(true);
      expect(isProcessAlive(run.proxyPid)).toBe(true);
      expect(await healthy(run.port)).toBe(true);
      expect(existsSync(join(run.home, "ocx.pid"))).toBe(true);
      expect(existsSync(join(run.home, "runtime-port.json"))).toBe(true);
      expect(readFileSync(run.codexConfig, "utf8")).toContain("opencodex");

      await expectCleanShutdown(run, "SIGTERM");
    },
    45_000,
  );
});
