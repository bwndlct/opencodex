import { useEffect, useMemo, useRef, useState } from "react";
import { Switch, Notice } from "../ui";
import { IconChevron, IconBoxes } from "../icons";

interface ModelRow { provider: string; id: string; namespaced: string; disabled: boolean }

export default function Models({ apiBase }: { apiBase: string }) {
  const [models, setModels] = useState<ModelRow[]>([]);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const load = async () => {
    try {
      const data = (await fetch(`${apiBase}/api/models`).then(r => r.json())) as ModelRow[];
      setModels(data);
      setDisabled(new Set(data.filter(m => m.disabled).map(m => m.namespaced)));
    } catch {
      setOk(false); setStatus("Failed to load models — is the proxy running?");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
    // Provider models resolve lazily (live /models + OAuth tokens), so a provider that wasn't ready
    // on first load (e.g. anthropic right after login) would otherwise stay missing until a manual
    // remove/re-add. Re-poll to pick it up; skip while a toggle PUT is in flight to avoid clobbering.
    const t = setInterval(() => { if (!busyRef.current) load(); }, 10000);
    return () => clearInterval(t);
  }, [apiBase]);

  const groups = useMemo(() => {
    const g: Record<string, ModelRow[]> = {};
    for (const m of models) (g[m.provider] ??= []).push(m);
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [models]);

  const apply = async (next: Set<string>) => {
    setBusy(true);
    busyRef.current = true;
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/disabled-models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: [...next] }),
      });
      if (r.ok) { setDisabled(next); setOk(true); setStatus("Applied — takes effect on the next Codex turn."); }
      else { setOk(false); setStatus("Save failed"); }
    } catch {
      setOk(false); setStatus("Network error — is the proxy running?");
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  const toggle = (ns: string) => {
    const next = new Set(disabled);
    if (next.has(ns)) next.delete(ns); else next.add(ns);
    apply(next);
  };
  const toggleProvider = (rows: ModelRow[], enable: boolean) => {
    const next = new Set(disabled);
    for (const m of rows) { if (enable) next.delete(m.namespaced); else next.add(m.namespaced); }
    apply(next);
  };
  const toggleCollapse = (p: string) => {
    setCollapsed(prev => { const n = new Set(prev); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  };

  if (loading) return <div className="row muted"><span className="spin" /> Loading…</div>;


  return (
    <>
      <div className="page-head">
        <h2>Models</h2>
        <span className="muted mono" style={{ fontSize: 12 }}>{models.length - disabled.size}/{models.length} active</span>
      </div>
      <p className="page-sub">
        Toggle which routed models Codex sees, grouped by provider (click a header to collapse). Disabled
        models are hidden from the catalog + model picker. Changes apply on the <b>next Codex turn</b> —
        opencodex invalidates Codex's 5-min model cache so no restart is needed.
      </p>
      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}

      {groups.map(([provider, rows]) => {
        const isCollapsed = collapsed.has(provider);
        const activeCount = rows.filter(m => !disabled.has(m.namespaced)).length;
        return (
          <div key={provider} className="card" style={{ marginBottom: 8, overflow: "hidden" }}>
            <div onClick={() => toggleCollapse(provider)}
              className="row" style={{ padding: "10px 12px", background: "var(--raised)", cursor: "pointer" }}>
              <IconChevron style={{ width: 14, height: 14, color: "var(--muted)", transform: isCollapsed ? "none" : "rotate(90deg)", transition: "transform .12s" }} />
              <span style={{ fontWeight: 600, fontSize: 14 }}>{provider}</span>
              <span className="muted mono" style={{ fontSize: 12 }}>{activeCount}/{rows.length} active</span>
              <div style={{ flex: 1 }} />
              <button onClick={e => { e.stopPropagation(); toggleProvider(rows, true); }} disabled={busy} className="btn btn-ghost btn-sm">All on</button>
              <button onClick={e => { e.stopPropagation(); toggleProvider(rows, false); }} disabled={busy} className="btn btn-ghost btn-sm">All off</button>
            </div>
            {!isCollapsed && (
              <div style={{ padding: "6px 12px" }}>
                {rows.map(m => {
                  const off = disabled.has(m.namespaced);
                  return (
                    <div key={m.namespaced} className="row" style={{ padding: "5px 0" }}>
                      <Switch on={!off} onClick={() => toggle(m.namespaced)} disabled={busy} label={m.id} />
                      <code className="mono" style={{ fontSize: 13, color: off ? "var(--faint)" : "var(--text)", textDecoration: off ? "line-through" : "none" }}>{m.id}</code>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {groups.length === 0 && (
        <div className="empty">
          <IconBoxes />
          <div className="title">No routed models</div>
          <div style={{ fontSize: 13 }}>Log into a provider or add one first.</div>
        </div>
      )}
    </>
  );
}
