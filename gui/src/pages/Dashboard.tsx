import { useEffect, useMemo, useState } from "react";
import { IconAlert } from "../icons";

interface HealthData { status: string; version: string; uptime: number }
interface ProviderInfo { name: string; adapter: string; baseUrl: string; defaultModel?: string; hasApiKey: boolean }
interface ModelInfo { id: string; provider: string; owned_by?: string }

export default function Dashboard({ apiBase }: { apiBase: string }) {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [hRes, pRes] = await Promise.all([
          fetch(`${apiBase}/healthz`),
          fetch(`${apiBase}/api/providers`),
        ]);
        setHealth(await hRes.json());
        setProviders(await pRes.json());
        setError("");
      } catch {
        setError("Cannot connect to proxy. Is it running?");
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [apiBase]);

  useEffect(() => {
    if (error) return;
    setModelsLoading(true);
    fetch(`${apiBase}/api/models`)
      .then(r => r.json())
      .then((data: ModelInfo[]) => { setModels(data); setModelsLoading(false); })
      .catch(() => setModelsLoading(false));
  }, [apiBase, error]);

  // Group models by provider so the list reads as provider → its models, not one flat wall of cards.
  const grouped = useMemo(() => {
    const g: Record<string, ModelInfo[]> = {};
    for (const m of models) (g[m.provider] ??= []).push(m);
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [models]);

  if (error) {
    return (
      <div className="empty" style={{ marginTop: 40 }}>
        <IconAlert />
        <div className="title" style={{ color: "var(--red)" }}>{error}</div>
        <div style={{ fontSize: 13 }}>Run <code className="chip">ocx start</code> to start the proxy.</div>
      </div>
    );
  }

  const online = health?.status === "ok";

  return (
    <>
      <div className="page-head"><h2>Dashboard</h2></div>
      <p className="page-sub">Live status of the local opencodex proxy, its providers, and the models routed into Codex.</p>

      <div className="stat-row">
        <div className="stat">
          <div className="label">Status</div>
          <div className="value" style={{ display: "flex", alignItems: "center", gap: 9, color: online ? "var(--green)" : "var(--red)" }}>
            <span className={`dot ${online ? "dot-green" : "dot-red"}`} />{online ? "Online" : "Offline"}
          </div>
        </div>
        <div className="stat"><div className="label">Version</div><div className="value mono">{health?.version ?? "—"}</div></div>
        <div className="stat"><div className="label">Uptime</div><div className="value mono">{health ? `${Math.floor(health.uptime)}s` : "—"}</div></div>
        <div className="stat"><div className="label">Providers</div><div className="value">{providers.length}</div></div>
      </div>

      <div className="h-section">Active providers <span className="count">{providers.length}</span></div>
      {providers.length === 0 ? (
        <div className="empty">No providers configured. Run <code className="chip">ocx init</code>.</div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Name</th><th>Adapter</th><th>Base URL</th><th>Model</th></tr></thead>
            <tbody>
              {providers.map(p => (
                <tr key={p.name}>
                  <td style={{ fontWeight: 600 }}>{p.name}</td>
                  <td><span className="chip">{p.adapter}</span></td>
                  <td className="muted mono" style={{ fontSize: 12 }}>{p.baseUrl}</td>
                  <td className="muted">{p.defaultModel ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="h-section">
        Available models <span className="count">{models.length}</span>
        {modelsLoading && <span className="spin" style={{ marginLeft: 4 }} />}
      </div>
      {models.length === 0 && !modelsLoading ? (
        <div className="empty">No models found. Check provider API keys.</div>
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          {grouped.map(([provider, rows]) => (
            <div key={provider} className="model-group">
              <div className="model-group-head">{provider}<span className="count">{rows.length}</span></div>
              <div className="model-grid">
                {rows.map(m => (
                  <div key={`${m.provider}/${m.id}`} className="model-card">
                    <div className="id">{m.id}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
