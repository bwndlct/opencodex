import { useEffect, useMemo, useRef, useState } from "react";

export interface ProviderConfig {
  adapter: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
  authMode?: "key" | "forward";
}

interface Preset {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  defaultModel?: string;
  auth: "oauth" | "key";
  note?: string;
}

// Known providers offered in the picker. `oauth` presets forward the caller's Codex login
// (no API key); `key` presets need an API key.
const PRESETS: Preset[] = [
  { id: "openai", label: "OpenAI (ChatGPT login)", adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", auth: "oauth", note: "Uses your codex login — no API key needed" },
  { id: "openai-apikey", label: "OpenAI (API key)", adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-5.5", auth: "key" },
  { id: "opencode-go", label: "opencode zen", adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", defaultModel: "kimi-k2.6", auth: "key", note: "GLM, DeepSeek, Kimi, Qwen, MiMo…" },
  { id: "anthropic", label: "Anthropic Claude", adapter: "anthropic", baseUrl: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-20250514", auth: "key" },
  { id: "openrouter", label: "OpenRouter", adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", auth: "key" },
  { id: "groq", label: "Groq", adapter: "openai-chat", baseUrl: "https://api.groq.com/openai/v1", auth: "key" },
  { id: "google", label: "Google Gemini", adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", defaultModel: "gemini-3-pro", auth: "key" },
  { id: "azure-openai", label: "Azure OpenAI", adapter: "azure-openai", baseUrl: "https://{resource}.openai.azure.com/openai/deployments/{deployment}", auth: "key" },
  { id: "ollama", label: "Ollama (local)", adapter: "openai-chat", baseUrl: "http://localhost:11434/v1", auth: "key", note: "Local — key usually blank" },
  { id: "custom", label: "Custom provider", adapter: "openai-chat", baseUrl: "", auth: "key" },
];

interface FormState {
  name: string;
  adapter: string;
  baseUrl: string;
  authMode: "key" | "forward";
  apiKey: string;
  defaultModel: string;
}

export default function AddProviderModal({
  apiBase, existingNames, onClose, onAdded,
}: {
  apiBase: string;
  existingNames: string[];
  onClose: () => void;
  onAdded: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [preset, setPreset] = useState<Preset | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { searchRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PRESETS;
    // Match by provider name/id — not adapter, since most share "openai-chat" and would all match.
    return PRESETS.filter(p =>
      p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  }, [query]);

  const choosePreset = (p: Preset) => {
    setPreset(p);
    setForm({
      name: p.id === "custom" ? "" : p.id,
      adapter: p.adapter,
      baseUrl: p.baseUrl,
      authMode: p.auth === "oauth" ? "forward" : "key",
      apiKey: "",
      defaultModel: p.defaultModel ?? "",
    });
    setError("");
  };

  const submit = async () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) { setError("Provider name is required"); return; }
    if (!form.baseUrl.trim()) { setError("Base URL is required"); return; }
    const provider: ProviderConfig = { adapter: form.adapter.trim(), baseUrl: form.baseUrl.trim() };
    if (form.authMode === "forward") provider.authMode = "forward";
    else if (form.apiKey.trim()) provider.apiKey = form.apiKey.trim();
    if (form.defaultModel.trim()) provider.defaultModel = form.defaultModel.trim();

    setSaving(true);
    setError("");
    try {
      const res = await fetch(`${apiBase}/api/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, provider }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || `Failed (${res.status})`);
        return;
      }
      onAdded(name);
    } catch {
      setError("Network error — is the proxy running?");
    } finally {
      setSaving(false);
    }
  };

  const dup = form ? existingNames.includes(form.name.trim()) && form.name.trim() !== "" : false;

  return (
    <div role="dialog" aria-modal="true" aria-label="Add provider" onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, margin: 0 }}>{preset ? `Add: ${preset.label}` : "Add provider"}</h3>
          <button onClick={onClose} aria-label="Close" style={iconBtn}>×</button>
        </div>

        {!preset ? (
          <>
            <input
              ref={searchRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search providers…"
              style={input}
            />
            <div style={{ marginTop: 12, maxHeight: 360, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
              {filtered.map(p => (
                <button key={p.id} onClick={() => choosePreset(p)} style={presetRow}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{p.label}</div>
                    <div style={{ fontSize: 12, color: "#888" }}>
                      <code>{p.adapter}</code>{p.note ? ` · ${p.note}` : ""}
                    </div>
                  </div>
                  {p.auth === "oauth"
                    ? <span style={badge("#16a34a", "#dcfce7")}>OAuth</span>
                    : <span style={badge("#6b7280", "#f3f4f6")}>API key</span>}
                </button>
              ))}
              {filtered.length === 0 && <div style={{ fontSize: 13, color: "#888", padding: 8 }}>No match.</div>}
            </div>
          </>
        ) : form && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Field label="Provider name">
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. openrouter" style={input} />
            </Field>
            {dup && <div style={{ fontSize: 12, color: "#d97706" }}>A provider named “{form.name.trim()}” exists — it will be overwritten.</div>}
            <Field label="Adapter">
              <select value={form.adapter} onChange={e => setForm({ ...form, adapter: e.target.value })} style={input}>
                {["openai-responses", "openai-chat", "anthropic", "google", "azure-openai"].map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </Field>
            <Field label="Base URL">
              <input value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://…" style={input} />
            </Field>
            <Field label="Auth">
              <div style={{ display: "flex", gap: 8 }}>
                <Radio checked={form.authMode === "key"} onChange={() => setForm({ ...form, authMode: "key" })} label="API key" />
                <Radio checked={form.authMode === "forward"} onChange={() => setForm({ ...form, authMode: "forward" })} label="Forward Codex login (OAuth)" />
              </div>
            </Field>
            {form.authMode === "key" ? (
              <Field label="API key">
                <input type="password" value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-… (or $ENV_VAR)" style={input} />
              </Field>
            ) : (
              <div style={{ fontSize: 12, color: "#16a34a", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, padding: "8px 10px" }}>
                No key needed — the proxy forwards your <code>codex login</code> credentials to this provider.
              </div>
            )}
            <Field label="Default model (optional)">
              <input value={form.defaultModel} onChange={e => setForm({ ...form, defaultModel: e.target.value })} placeholder="e.g. gpt-5.5" style={input} />
            </Field>
            {error && <div role="alert" style={{ fontSize: 13, color: "#ef4444" }}>{error}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button onClick={submit} disabled={saving} style={{ ...btn("#3b82f6"), opacity: saving ? 0.6 : 1 }}>{saving ? "Adding…" : "Add provider"}</button>
              <button onClick={() => { setPreset(null); setForm(null); setError(""); }} style={btn("#9ca3af")}>Back</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: "#555", fontWeight: 500 }}>{label}</span>
      {children}
    </label>
  );
}

function Radio({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button onClick={onChange} style={{
      flex: 1, padding: "8px 10px", borderRadius: 6, fontSize: 13, cursor: "pointer",
      border: checked ? "1.5px solid #3b82f6" : "1px solid #e5e7eb",
      background: checked ? "#eff6ff" : "#fff", color: checked ? "#1d4ed8" : "#444", textAlign: "left",
    }}>{label}</button>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
  display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "8vh 16px", zIndex: 50,
};
const card: React.CSSProperties = {
  background: "#fff", borderRadius: 12, padding: 20, width: "100%", maxWidth: 520,
  boxShadow: "0 12px 40px rgba(0,0,0,0.18)", maxHeight: "84vh", overflowY: "auto",
};
const input: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #e5e7eb",
  fontSize: 13, fontFamily: "inherit", boxSizing: "border-box",
};
const presetRow: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
  padding: "10px 12px", borderRadius: 8, border: "1px solid #eee", background: "#fafafa",
  cursor: "pointer", textAlign: "left", width: "100%",
};
const iconBtn: React.CSSProperties = {
  border: "none", background: "none", fontSize: 22, lineHeight: 1, cursor: "pointer", color: "#888", padding: 0,
};
const btn = (bg: string): React.CSSProperties => ({
  padding: "8px 16px", borderRadius: 6, border: "none", background: bg, color: "#fff", fontSize: 13, cursor: "pointer",
});
const badge = (color: string, bg: string): React.CSSProperties => ({
  fontSize: 11, fontWeight: 600, color, background: bg, padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap",
});
