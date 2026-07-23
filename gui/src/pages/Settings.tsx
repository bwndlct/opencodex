import { useCallback, useEffect, useMemo, useState } from "react";
import { IconCheck, IconInfo, IconRefresh } from "../icons";
import { Notice, Select, Switch } from "../ui";
import { useT } from "../i18n/shared";
import NavigationVisibilitySettings from "../components/NavigationVisibilitySettings";
import type { NavigationVisibility, OptionalNavPage } from "../navigation-preferences";

type RoutePolicy = "personal_first" | "company_first";

interface RoutingSettings {
  openAiDualUpstream: {
    companyProvider: string;
    defaultPolicy: RoutePolicy;
    autoSwitchToCompany: boolean;
  } | null;
  companyProviders: string[];
  canEnableDualUpstream: boolean;
  lunaReasoningMaxModels: string[];
  glmReasoningMaxModels: string[];
  appliesTo: "future_requests";
}

const DEFAULT_LUNA_MODELS = ["gpt-5.6-luna"];
const DEFAULT_GLM_MODELS = ["zai-anthropic/glm-5.2"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRoutePolicy(value: unknown): value is RoutePolicy {
  return value === "personal_first" || value === "company_first";
}

function readModelList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const models = value.filter((model): model is string => typeof model === "string" && model.trim().length > 0)
    .map(model => model.trim());
  return models.length > 0 ? [...new Set(models)] : [];
}

function readRoutingSettings(value: unknown): RoutingSettings | null {
  if (!isRecord(value) || !Array.isArray(value.companyProviders)) return null;
  const rawDual = value.openAiDualUpstream;
  let dual: RoutingSettings["openAiDualUpstream"] = null;
  if (rawDual !== null && rawDual !== undefined) {
    if (!isRecord(rawDual) || typeof rawDual.companyProvider !== "string" || !isRoutePolicy(rawDual.defaultPolicy)) return null;
    dual = {
      companyProvider: rawDual.companyProvider,
      defaultPolicy: rawDual.defaultPolicy,
      autoSwitchToCompany: rawDual.autoSwitchToCompany !== false,
    };
  }
  if (typeof value.canEnableDualUpstream !== "boolean") return null;
  if (value.appliesTo !== "future_requests") return null;
  return {
    openAiDualUpstream: dual,
    companyProviders: value.companyProviders.filter((provider): provider is string => typeof provider === "string"),
    canEnableDualUpstream: value.canEnableDualUpstream,
    lunaReasoningMaxModels: readModelList(value.lunaReasoningMaxModels, DEFAULT_LUNA_MODELS),
    glmReasoningMaxModels: readModelList(value.glmReasoningMaxModels, DEFAULT_GLM_MODELS),
    appliesTo: "future_requests",
  };
}

function parseModelText(value: string): string[] {
  return [...new Set(value.split(",").map(model => model.trim()).filter(Boolean))];
}

export default function Settings({
  apiBase,
  navigationVisibility,
  onNavigationVisibilityChange,
}: {
  apiBase: string;
  navigationVisibility: NavigationVisibility;
  onNavigationVisibilityChange: (page: OptionalNavPage, visible: boolean) => void;
}) {
  const t = useT();
  const [settings, setSettings] = useState<RoutingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<"saved" | "error" | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [dualEnabled, setDualEnabled] = useState(false);
  const [companyProvider, setCompanyProvider] = useState("");
  const [defaultPolicy, setDefaultPolicy] = useState<RoutePolicy>("company_first");
  const [autoSwitchToCompany, setAutoSwitchToCompany] = useState(true);
  const [lunaEnabled, setLunaEnabled] = useState(true);
  const [glmEnabled, setGlmEnabled] = useState(true);
  const [lunaText, setLunaText] = useState(DEFAULT_LUNA_MODELS.join(", "));
  const [glmText, setGlmText] = useState(DEFAULT_GLM_MODELS.join(", "));

  const applySettings = useCallback((next: RoutingSettings) => {
    setSettings(next);
    setDualEnabled(next.openAiDualUpstream !== null);
    setCompanyProvider(next.openAiDualUpstream?.companyProvider ?? next.companyProviders[0] ?? "");
    setDefaultPolicy(next.openAiDualUpstream?.defaultPolicy ?? "company_first");
    setAutoSwitchToCompany(next.openAiDualUpstream?.autoSwitchToCompany ?? true);
    setLunaEnabled(next.lunaReasoningMaxModels.length > 0);
    setGlmEnabled(next.glmReasoningMaxModels.length > 0);
    setLunaText(next.lunaReasoningMaxModels.join(", "));
    setGlmText(next.glmReasoningMaxModels.join(", "));
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch(`${apiBase}/api/routing-settings`);
      const parsed: unknown = await response.json();
      const next = readRoutingSettings(parsed);
      if (!response.ok || !next) throw new Error(isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : t("settings.routing.loadError"));
      applySettings(next);
      setNotice(null);
      setErrorMessage("");
    } catch (error) {
      setNotice("error");
      setErrorMessage(error instanceof Error ? error.message : t("settings.routing.loadError"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [apiBase, applySettings, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const companyOptions = useMemo(() => {
    const options = settings?.companyProviders ?? [];
    return options.length > 0
      ? options.map(provider => ({ value: provider, label: provider }))
      : [{ value: "", label: t("settings.routing.noCompanyProvider") }];
  }, [settings?.companyProviders, t]);
  const hasCompanyProviders = (settings?.companyProviders.length ?? 0) > 0;
  const dualControlsEnabled = Boolean(dualEnabled && settings?.canEnableDualUpstream && hasCompanyProviders);

  const toggleLuna = () => {
    if (!lunaEnabled && parseModelText(lunaText).length === 0) setLunaText(DEFAULT_LUNA_MODELS.join(", "));
    setLunaEnabled(value => !value);
  };

  const toggleGlm = () => {
    if (!glmEnabled && parseModelText(glmText).length === 0) setGlmText(DEFAULT_GLM_MODELS.join(", "));
    setGlmEnabled(value => !value);
  };

  const save = async () => {
    if (!settings || saving) return;
    const lunaModels = lunaEnabled ? parseModelText(lunaText) : [];
    const glmModels = glmEnabled ? parseModelText(glmText) : [];
    if (lunaEnabled && lunaModels.length === 0) {
      setNotice("error");
      setErrorMessage(t("settings.routing.modelListRequired"));
      return;
    }
    if (glmEnabled && glmModels.length === 0) {
      setNotice("error");
      setErrorMessage(t("settings.routing.modelListRequired"));
      return;
    }
    if (dualEnabled && (!settings.canEnableDualUpstream || !companyProvider)) {
      setNotice("error");
      setErrorMessage(t("settings.routing.dualUnavailable"));
      return;
    }
    setSaving(true);
    setNotice(null);
    setErrorMessage("");
    try {
      const response = await fetch(`${apiBase}/api/routing-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          openAiDualUpstream: dualEnabled ? { companyProvider, defaultPolicy, autoSwitchToCompany } : null,
          lunaReasoningMaxModels: lunaModels,
          glmReasoningMaxModels: glmModels,
        }),
      });
      const parsed: unknown = await response.json();
      const next = readRoutingSettings(parsed);
      if (!response.ok || !next) throw new Error(isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : t("settings.routing.saveError"));
      applySettings(next);
      setNotice("saved");
    } catch (error) {
      setNotice("error");
      setErrorMessage(error instanceof Error ? error.message : t("settings.routing.saveError"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="settings-page settings-loading muted">{t("settings.routing.loading")}</div>;

  if (!settings) {
    return (
      <div className="settings-page">
        <header className="settings-header page-header">
          <div>
            <div className="settings-eyebrow">{t("settings.routing.eyebrow")}</div>
            <h1>{t("settings.routing.title")}</h1>
            <p className="muted">{t("settings.routing.subtitle")}</p>
          </div>
        </header>
        <div className="settings-load-failure">
          <Notice tone="err"><span>{errorMessage || t("settings.routing.loadError")}</span></Notice>
          <button type="button" className="btn" onClick={() => void load()} disabled={refreshing}>
            <IconRefresh /> {t("settings.routing.retry")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-page">
      <header className="settings-header page-header">
        <div>
          <div className="settings-eyebrow">{t("settings.routing.eyebrow")}</div>
          <h1>{t("settings.routing.title")}</h1>
          <p className="muted">{t("settings.routing.subtitle")}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-icon" onClick={() => void load()} disabled={refreshing || saving}
          aria-label={t("settings.routing.refresh")} title={t("settings.routing.refresh")}>
          <IconRefresh />
        </button>
      </header>

      {notice === "saved" && <Notice tone="ok"><span>{t("settings.routing.saved")}</span></Notice>}
      {notice === "error" && <Notice tone="err"><span>{errorMessage || t("settings.routing.saveError")}</span></Notice>}

      <NavigationVisibilitySettings visibility={navigationVisibility} onChange={onNavigationVisibilityChange} />

      <section className="settings-section" aria-labelledby="settings-openai-title">
        <div className="settings-section-heading">
          <div>
            <h2 id="settings-openai-title">{t("settings.routing.openai.title")}</h2>
            <p className="muted">{t("settings.routing.openai.subtitle")}</p>
          </div>
          <Switch on={dualEnabled} onClick={() => setDualEnabled(value => !value)} disabled={!settings.canEnableDualUpstream || !hasCompanyProviders}
            label={t("settings.routing.openai.enabled")} />
        </div>
        {(!settings.canEnableDualUpstream || !hasCompanyProviders) && <div className="settings-inline-warning"><IconInfo />{t("settings.routing.openai.unavailable")}</div>}
        <div className="settings-rows">
          <div className="settings-row">
            <div><strong>{t("settings.routing.openai.companyProvider")}</strong><span className="muted">{t("settings.routing.openai.companyProviderHint")}</span></div>
            <Select value={companyProvider} options={companyOptions} onChange={setCompanyProvider} disabled={!dualControlsEnabled}
              label={t("settings.routing.openai.companyProvider")} />
          </div>
          <div className="settings-row">
            <div><strong>{t("settings.routing.openai.defaultPolicy")}</strong><span className="muted">{t("settings.routing.openai.defaultPolicyHint")}</span></div>
            <div className="usage-segmented" role="group" aria-label={t("settings.routing.openai.defaultPolicy")}>
              <button type="button" className={`usage-segmented-btn${defaultPolicy === "personal_first" ? " active" : ""}`} aria-pressed={defaultPolicy === "personal_first"}
                disabled={!dualControlsEnabled} onClick={() => setDefaultPolicy("personal_first")}>{t("settings.routing.openai.personalFirst")}</button>
              <button type="button" className={`usage-segmented-btn${defaultPolicy === "company_first" ? " active" : ""}`} aria-pressed={defaultPolicy === "company_first"}
                disabled={!dualControlsEnabled} onClick={() => setDefaultPolicy("company_first")}>{t("settings.routing.openai.companyFirst")}</button>
            </div>
          </div>
          <div className="settings-row">
            <div><strong>{t("settings.routing.openai.autoSwitch")}</strong><span className="muted">{t("settings.routing.openai.autoSwitchHint")}</span></div>
            <Switch on={autoSwitchToCompany} onClick={() => setAutoSwitchToCompany(value => !value)} disabled={!dualControlsEnabled}
              label={t("settings.routing.openai.autoSwitch")} />
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-reasoning-title">
        <div className="settings-section-heading">
          <div>
            <h2 id="settings-reasoning-title">{t("settings.routing.reasoning.title")}</h2>
            <p className="muted">{t("settings.routing.reasoning.subtitle")}</p>
          </div>
        </div>
        <div className="settings-rows">
          <div className="settings-row settings-row-stack">
            <div className="settings-row-top"><div><strong>{t("settings.routing.reasoning.luna")}</strong><span className="muted">{t("settings.routing.reasoning.lunaHint")}</span></div><Switch on={lunaEnabled} onClick={toggleLuna} label={t("settings.routing.reasoning.luna")} /></div>
            <input className="settings-model-input" value={lunaText} onChange={event => setLunaText(event.target.value)} disabled={!lunaEnabled}
              aria-label={t("settings.routing.reasoning.lunaModels")} placeholder={DEFAULT_LUNA_MODELS.join(", ")} />
          </div>
          <div className="settings-row settings-row-stack">
            <div className="settings-row-top"><div><strong>{t("settings.routing.reasoning.glm")}</strong><span className="muted">{t("settings.routing.reasoning.glmHint")}</span></div><Switch on={glmEnabled} onClick={toggleGlm} label={t("settings.routing.reasoning.glm")} /></div>
            <input className="settings-model-input" value={glmText} onChange={event => setGlmText(event.target.value)} disabled={!glmEnabled}
              aria-label={t("settings.routing.reasoning.glmModels")} placeholder={DEFAULT_GLM_MODELS.join(", ")} />
          </div>
        </div>
      </section>

      <div className="settings-footer">
        <div className="settings-applies"><IconInfo /><span>{t("settings.routing.applies")}</span></div>
        <button type="button" className="btn btn-primary settings-save" onClick={() => void save()} disabled={saving || refreshing}>
          <IconCheck /> {saving ? t("settings.routing.saving") : t("settings.routing.save")}
        </button>
      </div>
    </div>
  );
}
