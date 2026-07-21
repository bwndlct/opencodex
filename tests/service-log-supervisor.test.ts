import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRotatingServiceLogWriter, runServiceLogSupervisor, type ServiceSignalSource } from "../src/lib/service-log-supervisor";

const roots: string[] = [];

function fixture(): { root: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "ocx-service-log-"));
  roots.push(root);
  return { root, log: join(root, "nested", "service.log") };
}

function managedFiles(log: string): string[] {
  const dir = join(log, "..");
  return readdirSync(dir)
    .filter(name => /^service\.log(?:\.\d+)?$/.test(name))
    .sort((left, right) => left.localeCompare(right));
}

function chronologicalContent(log: string, backupCount: number): string {
  const paths: string[] = [];
  for (let index = backupCount; index >= 1; index--) paths.push(`${log}.${index}`);
  paths.push(log);
  return paths.map(path => {
    try { return readFileSync(path, "utf8"); } catch { return ""; }
  }).join("");
}

class TestSignalSource implements ServiceSignalSource {
  private readonly listeners = new Map<string, Set<() => void>>();

  on(signal: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  off(signal: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: "SIGINT" | "SIGTERM" | "SIGHUP"): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }

  count(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }
}

async function waitForText(path: string, text: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if (readFileSync(path, "utf8").includes(text)) return;
    } catch {
      // The supervisor may not have opened the file yet.
    }
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${text}`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("rotating service log writer", () => {
  test("rotates during one writer lifetime and retains the newest capacity in order", async () => {
    const { log } = fixture();
    const writer = await createRotatingServiceLogWriter(log, { maxBytes: 5, backupCount: 2 });

    await writer.write("01234");
    await writer.write("56789");
    await writer.write("abcde");
    await writer.write("FG");
    await writer.close();

    expect(managedFiles(log)).toEqual(["service.log", "service.log.1", "service.log.2"]);
    for (const name of managedFiles(log)) expect(statSync(join(log, "..", name)).size).toBeLessThanOrEqual(5);
    expect(chronologicalContent(log, 2)).toBe("56789abcdeFG");
  });

  test("splits one oversized chunk and supports zero backups", async () => {
    const { log } = fixture();
    const writer = await createRotatingServiceLogWriter(log, { maxBytes: 4, backupCount: 1 });
    await writer.write("abcdefghijkl");
    await writer.close();

    expect(readFileSync(`${log}.1`, "utf8")).toBe("efgh");
    expect(readFileSync(log, "utf8")).toBe("ijkl");

    const zero = await createRotatingServiceLogWriter(log, { maxBytes: 3, backupCount: 0 });
    await zero.write("XYZW");
    await zero.close();
    expect(readFileSync(log, "utf8")).toBe("W");
  });

  test("serializes concurrent writes without corrupting chunks", async () => {
    const { log } = fixture();
    const writer = await createRotatingServiceLogWriter(log, { maxBytes: 64, backupCount: 1 });
    const writes = ["alpha\n", "beta\n", "gamma\n", "delta\n"].map(chunk => writer.write(chunk));
    await Promise.all(writes);
    await writer.close();

    expect(readFileSync(log, "utf8")).toBe("alpha\nbeta\ngamma\ndelta\n");
  });

  test("normalizes oversized managed files without touching unknown siblings", async () => {
    const { root, log } = fixture();
    const dir = join(root, "nested");
    mkdirSync(dir, { recursive: true });
    writeFileSync(log, "0123456789");
    writeFileSync(`${log}.1`, "abcdefghij");
    writeFileSync(`${log}.9`, "leave-me-alone");
    writeFileSync(join(dir, "notes.txt"), "untouched");

    const writer = await createRotatingServiceLogWriter(log, { maxBytes: 4, backupCount: 1 });
    await writer.close();

    expect(readFileSync(log, "utf8")).toBe("6789");
    expect(readFileSync(`${log}.1`, "utf8")).toBe("ghij");
    expect(readFileSync(`${log}.9`, "utf8")).toBe("leave-me-alone");
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("untouched");
  });

  test("hardens POSIX modes, closes idempotently, and rejects later writes", async () => {
    const { root, log } = fixture();
    const dir = join(root, "nested");
    mkdirSync(dir, { recursive: true, mode: 0o777 });
    chmodSync(dir, 0o777);
    writeFileSync(log, "old", { mode: 0o666 });
    chmodSync(log, 0o666);

    const writer = await createRotatingServiceLogWriter(log, { maxBytes: 3, backupCount: 1 });
    await writer.write("new");
    await Promise.all([writer.close(), writer.close()]);

    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      for (const name of managedFiles(log)) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
    await expect(writer.write("late")).rejects.toThrow("closed");
  });
});

describe("service log supervisor", () => {
  test("captures both streams, supplies service env, and preserves the child exit code", async () => {
    const { root, log } = fixture();
    const cli = join(root, "child.js");
    writeFileSync(cli, `
if (process.argv[2] !== "start") process.exit(91);
process.stdout.write("stdout-line\\n");
process.stderr.write("stderr-line\\n");
process.stdout.write("service=" + process.env.OCX_SERVICE + " tokenFile=" + Boolean(process.env.OCX_API_TOKEN_FILE) + "\\n");
setTimeout(() => process.exit(Number(process.env.TEST_EXIT_CODE)), 10);
`);

    const code = await runServiceLogSupervisor({
      runtime: process.execPath,
      cli,
      logPath: log,
      env: { ...process.env, TEST_EXIT_CODE: "7", OPENCODEX_API_AUTH_TOKEN: "do-not-log-this-secret" },
    });

    expect(code).toBe(7);
    const content = readFileSync(log, "utf8");
    expect(content).toContain("service child started");
    expect(content).toContain("stdout-line");
    expect(content).toContain("stderr-line");
    expect(content).toContain("service=1 tokenFile=true");
    expect(content).toContain("service child exited code=7");
    expect(content).not.toContain("do-not-log-this-secret");
  });

  test("forwards termination and removes all signal listeners after the child exits", async () => {
    const { root, log } = fixture();
    const cli = join(root, "signal-child.js");
    const signals = new TestSignalSource();
    writeFileSync(cli, `
if (process.argv[2] !== "start") process.exit(91);
process.on("SIGTERM", () => {
  process.stdout.write("got-term\\n");
  setTimeout(() => process.exit(23), 10);
});
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`);

    const running = runServiceLogSupervisor({
      runtime: process.execPath,
      cli,
      logPath: log,
      signalSource: signals,
      env: { ...process.env },
    });
    await waitForText(log, "ready");
    expect(signals.count()).toBe(3);
    signals.emit("SIGTERM");

    expect(await running).toBe(23);
    expect(signals.count()).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("got-term");
  });

  test("keeps supervising when log initialization fails", async () => {
    const { root, log } = fixture();
    const cli = join(root, "quiet-child.js");
    writeFileSync(cli, `setTimeout(() => process.exit(9), 5);`);

    const code = await runServiceLogSupervisor({
      runtime: process.execPath,
      cli,
      logPath: log,
      createWriter: async () => { throw new Error("disk unavailable"); },
    });

    expect(code).toBe(9);
  });
});
