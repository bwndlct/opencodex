import { useCallback, useEffect, useState } from "react";
import ComboWorkspace from "../components/ComboWorkspace";
import ModelRouteOverrides from "../components/ModelRouteOverrides";
import type { ModelOption } from "../model-route-data";
import {
  type ComboItem,
  parseComboList,
  toPutBody,
} from "../combo-workspace-data";
import { hideRedundantChatGptForwardProviders } from "../provider-workspace/catalog";
import { Notice } from "../ui";
import { useT } from "../i18n";

type ProviderOption = {
  name: string;
  disabled?: boolean;
  hiddenFromPicker?: boolean;
  authMode?: string;
  adapter?: string;
  baseUrl?: string;
};
type ProviderDto = {
  adapter: string;
  baseUrl: string;
  disabled?: boolean;
  defaultModel?: string;
  authMode?: string;
};
type ConfigDto = { providers?: Record<string, ProviderDto> };

function responseError(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const error = (data as { error?: unknown }).error;
  return typeof error === "string" && error.trim() ? error : undefined;
}

function responseSucceeded(data: unknown): boolean {
  return !!data && typeof data === "object" && !Array.isArray(data)
    && (data as { success?: unknown }).success === true;
}

type RoutingTab = "overrides" | "combos";

export default function ModelRouting({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [tab, setTab] = useState<RoutingTab>("overrides");
  const [combos, setCombos] = useState<ComboItem[]>([]);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [comboList, setComboList] = useState<{ id: string; model: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [statusOk, setStatusOk] = useState(false);
  const [adding, setAdding] = useState(false);

  const notify = (msg: string, ok: boolean) => {
    setStatus(msg);
    setStatusOk(ok);
  };

  useEffect(() => {
    if (!status || !statusOk) return;
    const timer = window.setTimeout(() => {
      setStatus("");
      setStatusOk(false);
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [status, statusOk]);

  const fetchAll = useCallback(async () => {
    try {
      const [combosRes, configRes, modelsRes] = await Promise.all([
        fetch(`${apiBase}/api/combos`),
        fetch(`${apiBase}/api/config`),
        fetch(`${apiBase}/api/models`),
      ]);
      if (!combosRes.ok || !configRes.ok || !modelsRes.ok) {
        throw new Error("model routing workspace load failed");
      }
      const combosJson = await combosRes.json();
      const configJson = await configRes.json() as ConfigDto;
      const modelsRaw = await modelsRes.json() as unknown;
      const modelRows = Array.isArray(modelsRaw)
        ? modelsRaw
        : Array.isArray((modelsRaw as { models?: unknown })?.models)
          ? (modelsRaw as { models: unknown[] }).models
          : [];

      setCombos(parseComboList(combosJson));
      setComboList(parseComboList(combosJson).map((c) => ({ id: c.id, model: c.model })));

      const allProviders = configJson.providers ?? {};
      const visibleProviders = hideRedundantChatGptForwardProviders(allProviders);
      setProviders(
        Object.entries(allProviders).map(([name, p]) => ({
          name,
          disabled: !!p.disabled,
          hiddenFromPicker: !Object.hasOwn(visibleProviders, name),
          authMode: p.authMode,
          adapter: p.adapter,
          baseUrl: p.baseUrl,
        })),
      );

      const fromApi: ModelOption[] = [];
      for (const row of modelRows) {
        if (!row || typeof row !== "object") continue;
        const m = row as {
          provider?: unknown;
          id?: unknown;
          namespaced?: unknown;
          native?: unknown;
          disabled?: unknown;
        };
        if (typeof m.provider !== "string" || typeof m.id !== "string") continue;
        const provider = m.provider.trim();
        const id = m.id.trim();
        if (!provider || !id || provider === "combo") continue;
        if (m.disabled === true) continue;
        fromApi.push({
          provider,
          id,
          namespaced: typeof m.namespaced === "string" ? m.namespaced : undefined,
          native: m.native === true,
        });
      }

      for (const [name, p] of Object.entries(configJson.providers ?? {})) {
        const dm = typeof p.defaultModel === "string" ? p.defaultModel.trim() : "";
        if (!dm || p.disabled) continue;
        if (!fromApi.some((m) => m.provider === name && m.id === dm)) {
          fromApi.push({ provider: name, id: dm, namespaced: `${name}/${dm}` });
        }
      }

      setModels(fromApi);
    } catch {
      notify(t("cws.loadFailed"), false);
    } finally {
      setLoading(false);
    }
  }, [apiBase, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchAll();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchAll]);

  const saveCombo = async (item: ComboItem, isCreate: boolean) => {
    try {
      const res = await fetch(`${apiBase}/api/combos`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toPutBody(item)),
      });
      const data = await res.json() as unknown;
      const serverError = responseError(data);
      if (!res.ok || serverError || !responseSucceeded(data)) {
        const err = serverError || t("cws.saveFailed");
        notify(err, false);
        return { ok: false as const, error: err };
      }
      await fetchAll();
      notify(isCreate ? t("cws.created", { model: item.model }) : t("cws.saved"), true);
      return { ok: true as const };
    } catch {
      const err = t("cws.saveFailed");
      notify(err, false);
      return { ok: false as const, error: err };
    }
  };

  const removeCombo = async (id: string) => {
    try {
      const res = await fetch(`${apiBase}/api/combos?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json() as unknown;
      const serverError = responseError(data);
      if (!res.ok || serverError || !responseSucceeded(data)) {
        const err = serverError || t("cws.removeFailed");
        notify(err, false);
        return { ok: false as const, error: err };
      }
      await fetchAll();
      notify(t("cws.removed", { id }), true);
      return { ok: true as const };
    } catch {
      const err = t("cws.removeFailed");
      notify(err, false);
      return { ok: false as const, error: err };
    }
  };

  return (
    <div className="model-routing-shell">
      <div className="model-routing-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "overrides"}
          className={`model-routing-tab${tab === "overrides" ? " model-routing-tab--active" : ""}`}
          onClick={() => setTab("overrides")}
        >
          {t("mro.tab.overrides")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "combos"}
          className={`model-routing-tab${tab === "combos" ? " model-routing-tab--active" : ""}`}
          onClick={() => setTab("combos")}
        >
          {t("mro.tab.combos")}
        </button>
      </div>

      {status && (
        <div className="model-routing-banner">
          <Notice tone={statusOk ? "ok" : "err"}>{status}</Notice>
        </div>
      )}

      {tab === "overrides" ? (
        <ModelRouteOverrides
          apiBase={apiBase}
          models={models}
          combos={comboList}
        />
      ) : (
        <div className="model-routing-combos-body">
          <ComboWorkspace
            combos={combos}
            providers={providers}
            models={models}
            loading={loading}
            onRefresh={() => { void fetchAll(); }}
            onSave={saveCombo}
            onRemove={removeCombo}
            onAdd={() => setAdding(true)}
            adding={adding}
            onCloseAdd={() => setAdding(false)}
            onCreated={() => { void fetchAll(); }}
          />
        </div>
      )}
    </div>
  );
}
