import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { formatTokens } from "../format-tokens";
import {
  parseSessionLogs,
  sessionLogTokenTotal,
  type SessionLog,
} from "../session-workspace-data";

type LoadState = "loading" | "ready" | "error";

function formatLogTime(value: number, localeTag?: string): string {
  return new Date(value).toLocaleTimeString(localeTag);
}

function formatDuration(ms: number): string {
  return `${Math.round(ms)}ms`;
}

/**
 * Compact per-session log table that lazily fetches scoped logs on mount.
 * Displays loading/error/empty states and a compact table: time, tokens,
 * model, provider, status, request id, duration.
 */
export function SessionLogPanel({ apiBase, rootSessionId }: { apiBase: string; rootSessionId: string }) {
  const { t, locale } = useI18n();
  const [logs, setLogs] = useState<SessionLog[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const localeTag = locale === "zh" ? "zh-CN" : locale;

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const url = `${apiBase}/api/sessions/${encodeURIComponent(rootSessionId)}/logs?limit=200`;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          if (!controller.signal.aborted) setState("error");
          return;
        }
        const parsed = parseSessionLogs(await response.json());
        if (controller.signal.aborted) return;
        setLogs(parsed.logs);
        setState("ready");
      } catch {
        if (!controller.signal.aborted) setState("error");
      }
    })();

    return () => controller.abort();
  }, [apiBase, rootSessionId]);

  if (state === "loading") {
    return <div className="session-log-panel session-log-panel--loading">{t("sessions.logs.loading")}</div>;
  }
  if (state === "error") {
    return <div className="session-log-panel session-log-panel--error">{t("sessions.logs.loadError")}</div>;
  }
  if (logs.length === 0) {
    return <div className="session-log-panel session-log-panel--empty">{t("sessions.logs.empty")}</div>;
  }

  return (
    <div className="session-log-panel">
      <div className="session-log-title">{t("sessions.logs.title")}</div>
      <table className="tbl session-log-table">
        <thead><tr>
          <th>{t("logs.col.time")}</th>
          <th className="num">{t("logs.col.tokens")}</th>
          <th>{t("logs.col.model")}</th>
          <th>{t("logs.col.provider")}</th>
          <th>{t("logs.col.status")}</th>
          <th>{t("logs.col.request")}</th>
          <th className="num">{t("logs.col.duration")}</th>
        </tr></thead>
        <tbody>
          {logs.map(log => {
            const tokenTotal = sessionLogTokenTotal(log);
            const tokenDisplay = tokenTotal !== undefined
              ? `${log.usageStatus === "estimated" ? "~" : ""}${formatTokens(tokenTotal, locale)}`
              : "\u2014";
            return (
              <tr key={log.requestId}>
                <td className="muted mono">{formatLogTime(log.timestamp, localeTag)}</td>
                <td className="num mono">{tokenDisplay}</td>
                <td className="mono">{log.resolvedModel ?? log.requestedModel ?? log.model}</td>
                <td className="mono">{log.provider}</td>
                <td className="mono">{log.status}</td>
                <td className="mono session-log-request-id" title={log.requestId}>{log.requestId}</td>
                <td className="num mono">{formatDuration(log.durationMs)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
