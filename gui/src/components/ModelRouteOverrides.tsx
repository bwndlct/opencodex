import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ModelRouteOverridesState,
  type ModelOption,
  type OverrideRuleItem,
  OVERRIDE_EFFORTS,
  emptyOverrideRule,
  nativeGptModels,
  parseModelRouteOverrides,
  stateEquals,
  targetOptions,
  toPutBody,
} from "../model-route-data";
import { IconPlus, IconTrash, IconAlert } from "../icons";
import { useT } from "../i18n";
import { Notice } from "../ui";

export type { ModelOption } from "../model-route-data";

export interface ModelRouteOverridesProps {
  apiBase: string;
  models: ModelOption[];
  combos: { id: string; model: string }[];
}

/** Native GPT models from the model catalog. The /api/models endpoint always lists
 * native GPT rows under provider "openai" with a native flag, but this also matches
 * any provider whose model id is a bare GPT/o-series slug, so it stays correct even
 * if the server-side provider id changes. */
export default function ModelRouteOverrides({
  apiBase,
  models,
  combos,
}: ModelRouteOverridesProps) {
  const t = useT();
  const [state, setState] = useState<ModelRouteOverridesState>({ enabled: false, rules: [] });
  const [baseline, setBaseline] = useState<ModelRouteOverridesState>({ enabled: false, rules: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const nativeModels = useMemo(() => nativeGptModels(models), [models]);
  const targets = useMemo(() => targetOptions(models, combos), [models, combos]);
  const dirty = !stateEquals(state, baseline);

  const fetchOverrides = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/model-route-overrides`);
      if (!res.ok) throw new Error("load failed");
      const data = await res.json();
      const parsed = parseModelRouteOverrides(data);
      setState(parsed);
      setBaseline(parsed);
    } catch {
      setStatus({ ok: false, text: t("mro.loadFailed") });
    } finally {
      setLoading(false);
    }
  }, [apiBase, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void fetchOverrides(); }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchOverrides]);

  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${apiBase}/api/model-route-overrides`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toPutBody(state)),
      });
      const data = await res.json() as { error?: string; success?: boolean; modelRouteOverrides?: unknown };
      if (!res.ok || data.error) {
        setStatus({ ok: false, text: data.error || t("mro.saveFailed") });
        return;
      }
      const parsed = parseModelRouteOverrides(data.modelRouteOverrides ?? toPutBody(state));
      setState(parsed);
      setBaseline(parsed);
      setStatus({ ok: true, text: t("mro.saved") });
    } catch {
      setStatus({ ok: false, text: t("mro.saveFailed") });
    } finally {
      setBusy(false);
    }
  };

  const updateRule = (index: number, patch: Partial<OverrideRuleItem>) => {
    setState((s) => ({
      ...s,
      rules: s.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  };

  const addRule = () => {
    setState((s) => ({
      ...s,
      rules: [...s.rules, emptyOverrideRule()],
    }));
  };

  const removeRule = (index: number) => {
    setState((s) => ({
      ...s,
      rules: s.rules.filter((_, i) => i !== index),
    }));
  };

  if (loading) {
    return <div className="muted" style={{ padding: "24px 20px" }}>{t("mro.loading")}</div>;
  }

  return (
    <div className="model-route-overrides-root">
      {status && <Notice tone={status.ok ? "ok" : "err"}>{status.text}</Notice>}

      <div className="mro-header">
        <div className="mro-header-left">
          <label className="mro-global-toggle">
            <input
              type="checkbox"
              checked={state.enabled}
              onChange={(e) => setState((s) => ({ ...s, enabled: e.target.checked }))}
            />
            <span>{t("mro.globalEnabled")}</span>
          </label>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!dirty || busy}
          onClick={() => { void save(); }}
        >
          {busy ? t("common.saving") : t("common.save")}
        </button>
      </div>

      <div className="mro-rules">
        {state.rules.length === 0 && (
          <div className="mro-empty">
            <p className="muted">{t("mro.emptyRules")}</p>
          </div>
        )}
        {state.rules.map((rule, index) => {
          const isMini = rule.source.includes("gpt-5.4-mini");
          const sourceOptions = rule.source && !nativeModels.includes(rule.source)
            ? [rule.source, ...nativeModels]
            : nativeModels;
          const targetOpts = rule.target && !targets.includes(rule.target)
            ? [rule.target, ...targets]
            : targets;
          return (
            <div key={index} className="mro-rule-row">
              <select
                className="input mro-source-select"
                value={rule.source}
                aria-label={t("mro.source")}
                onChange={(e) => updateRule(index, { source: e.target.value })}
              >
                <option value="">{t("mro.pickSource")}</option>
                {sourceOptions.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
              <span className="mro-arrow" aria-hidden="true">→</span>
              <select
                className="input mro-target-select"
                value={rule.target}
                aria-label={t("mro.target")}
                onChange={(e) => updateRule(index, { target: e.target.value })}
              >
                <option value="">{t("mro.pickTarget")}</option>
                {targetOpts.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
              <select
                className="input mro-effort-select"
                value={rule.effort}
                aria-label={t("mro.effort")}
                onChange={(e) => updateRule(index, { effort: e.target.value as OverrideRuleItem["effort"] })}
              >
                {OVERRIDE_EFFORTS.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort === "inherit" ? t("mro.effortInherit") : effort}
                  </option>
                ))}
              </select>
              <label className="mro-rule-toggle">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(e) => updateRule(index, { enabled: e.target.checked })}
                />
              </label>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => removeRule(index)}
                aria-label={t("common.remove")}
              >
                <IconTrash width={14} height={14} />
              </button>
              {isMini && (
                <div className="mro-mini-warning">
                  <IconAlert width={12} height={12} aria-hidden="true" />
                  <span>{t("mro.miniWarning")}</span>
                </div>
              )}
            </div>
          );
        })}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ alignSelf: "flex-start" }}
          onClick={addRule}
        >
          <IconPlus width={14} height={14} /> {t("mro.addRule")}
        </button>
      </div>
    </div>
  );
}
