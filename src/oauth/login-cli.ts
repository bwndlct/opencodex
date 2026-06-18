import * as readline from "node:readline";
import { exec } from "node:child_process";
import { loadConfig, readPid, saveConfig } from "../config";
import { OAUTH_PROVIDERS, runLogin } from "./index";
import { KEY_LOGIN_PROVIDERS, isKeyLoginProvider, validateApiKey } from "./key-providers";

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? 'start ""' : "xdg-open";
  exec(`${cmd} "${url}"`, () => {});
}

/** Push the new provider into a running proxy's live config so it routes without a restart. */
async function notifyRunningProxy(name: string, provider: unknown): Promise<void> {
  if (!readPid()) return;
  const cfg = loadConfig();
  try {
    await fetch(`http://localhost:${cfg.port}/api/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, provider }),
    });
  } catch {
    /* proxy unreachable; disk config loads on next start */
  }
}

export async function handleLogin(provider?: string): Promise<void> {
  const name = (provider ?? "").trim().toLowerCase();
  if (OAUTH_PROVIDERS[name]) return handleOAuthLogin(name);
  if (isKeyLoginProvider(name)) return handleKeyLogin(name);
  console.error(
    `Usage: ocx login <provider>\n` +
      `  OAuth login:   ${Object.keys(OAUTH_PROVIDERS).join(", ")}\n` +
      `  API-key login: ${Object.keys(KEY_LOGIN_PROVIDERS).join(", ")}`,
  );
  process.exit(1);
}

async function handleOAuthLogin(name: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runLogin(name, {
      onAuth: ({ url, instructions }) => {
        console.log(`\n🔐 Opening browser for ${name} login...\n${url}\n`);
        if (instructions) console.log(instructions);
        openBrowser(url);
      },
      onProgress: (m) => console.log(`   ${m}`),
      onManualCodeInput: () =>
        new Promise((res) => rl.question("Paste redirect URL or code (or wait for browser): ", res)),
    });
  } finally {
    rl.close();
  }
  await notifyRunningProxy(name, OAUTH_PROVIDERS[name].providerConfig);
  console.log(`\n✅ Logged in to ${name}. Try: ocx sync`);
}

async function handleKeyLogin(name: string): Promise<void> {
  const def = KEY_LOGIN_PROVIDERS[name];
  console.log(`\n🔑 ${def.label} — opening ${def.dashboardUrl} so you can create/copy an API key...`);
  openBrowser(def.dashboardUrl);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const key = (await new Promise<string>((res) => rl.question(`Paste your ${def.label} API key: `, res))).trim();
  rl.close();
  if (!key) {
    console.error("No key entered.");
    process.exit(1);
  }
  process.stdout.write("   validating… ");
  const valid = await validateApiKey(def.baseUrl, key);
  console.log(valid === true ? "valid ✅" : valid === false ? "INVALID ❌" : "couldn't validate (may still work)");
  if (valid === false) {
    console.error("Provider rejected the key. Not saved.");
    process.exit(1);
  }
  const provider = {
    adapter: def.adapter,
    baseUrl: def.baseUrl,
    apiKey: key,
    ...(def.defaultModel ? { defaultModel: def.defaultModel } : {}),
    ...(def.models ? { models: def.models } : {}),
  };
  const config = loadConfig();
  config.providers[name] = provider;
  saveConfig(config);
  await notifyRunningProxy(name, provider);
  console.log(`✅ ${def.label} added. Try: ocx sync`);
}
