/**
 * API-key "login" providers: not OAuth — the flow opens the provider's dashboard so the user can
 * create/copy a key, then validates + stores it as the provider's `apiKey` (authMode "key").
 * All use the OpenAI-compatible chat API with `Authorization: Bearer <key>` (the openai-chat adapter).
 */
export interface KeyLoginProvider {
  label: string;
  baseUrl: string;
  adapter: string;
  /** Where the user creates/copies the API key. */
  dashboardUrl: string;
  models?: string[];
  defaultModel?: string;
}

export const KEY_LOGIN_PROVIDERS: Record<string, KeyLoginProvider> = {
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com", adapter: "openai-chat", dashboardUrl: "https://platform.deepseek.com/api_keys", models: ["deepseek-chat", "deepseek-reasoner"], defaultModel: "deepseek-chat" },
  cerebras: { label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", adapter: "openai-chat", dashboardUrl: "https://cloud.cerebras.ai/platform/apikeys", defaultModel: "llama-3.3-70b" },
  together: { label: "Together", baseUrl: "https://api.together.xyz/v1", adapter: "openai-chat", dashboardUrl: "https://api.together.xyz/settings/api-keys" },
  fireworks: { label: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", adapter: "openai-chat", dashboardUrl: "https://fireworks.ai/account/api-keys" },
  firepass: { label: "Fire Pass (Fireworks Kimi)", baseUrl: "https://api.fireworks.ai/inference/v1", adapter: "openai-chat", dashboardUrl: "https://fireworks.ai/account/api-keys" },
  moonshot: { label: "Moonshot (Kimi API)", baseUrl: "https://api.moonshot.ai/v1", adapter: "openai-chat", dashboardUrl: "https://platform.moonshot.ai/console/api-keys", defaultModel: "kimi-k2-0905-preview" },
  huggingface: { label: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", adapter: "openai-chat", dashboardUrl: "https://huggingface.co/settings/tokens" },
  nvidia: { label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", adapter: "openai-chat", dashboardUrl: "https://build.nvidia.com" },
  venice: { label: "Venice", baseUrl: "https://api.venice.ai/api/v1", adapter: "openai-chat", dashboardUrl: "https://venice.ai/settings/api" },
  zai: { label: "Z.AI (GLM Coding)", baseUrl: "https://api.z.ai/api/coding/paas/v4", adapter: "openai-chat", dashboardUrl: "https://z.ai/manage-apikey/apikey-list", defaultModel: "glm-4.6" },
  nanogpt: { label: "NanoGPT", baseUrl: "https://nano-gpt.com/api/v1", adapter: "openai-chat", dashboardUrl: "https://nano-gpt.com/api" },
  synthetic: { label: "Synthetic", baseUrl: "https://api.synthetic.new/openai/v1", adapter: "openai-chat", dashboardUrl: "https://synthetic.new" },
  "qwen-portal": { label: "Qwen Portal", baseUrl: "https://portal.qwen.ai/v1", adapter: "openai-chat", dashboardUrl: "https://portal.qwen.ai" },
  qianfan: { label: "Qianfan (Baidu)", baseUrl: "https://qianfan.baidubce.com/v2", adapter: "openai-chat", dashboardUrl: "https://console.bce.baidu.com/iam/#/iam/apikey/list" },
  alibaba: { label: "Alibaba Coding Plan", baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1", adapter: "openai-chat", dashboardUrl: "https://dashscope.console.aliyun.com/apiKey" },
  parallel: { label: "Parallel", baseUrl: "https://platform.parallel.ai", adapter: "openai-chat", dashboardUrl: "https://platform.parallel.ai" },
  zenmux: { label: "ZenMux", baseUrl: "https://zenmux.ai/api/v1", adapter: "openai-chat", dashboardUrl: "https://zenmux.ai" },
  litellm: { label: "LiteLLM (self-hosted)", baseUrl: "http://localhost:4000/v1", adapter: "openai-chat", dashboardUrl: "https://docs.litellm.ai/docs/proxy/quick_start" },
};

export function isKeyLoginProvider(name: string): boolean {
  return name in KEY_LOGIN_PROVIDERS;
}

export function listKeyLoginProviders(): Array<{ id: string } & KeyLoginProvider> {
  return Object.entries(KEY_LOGIN_PROVIDERS).map(([id, p]) => ({ id, ...p }));
}

/** Best-effort key validation: GET {baseUrl}/models with the key. Returns true/false/unknown. */
export async function validateApiKey(baseUrl: string, key: string): Promise<boolean | "unknown"> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return true;
    if (res.status === 401 || res.status === 403) return false;
    return "unknown";
  } catch {
    return "unknown";
  }
}
