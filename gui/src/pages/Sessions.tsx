import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n, type Locale, type TFn } from "../i18n";
import { IconActivity, IconAlert, IconRefresh } from "../icons";
import { EmptyState } from "../ui";
import { formatTokens } from "../format-tokens";
import { SessionLogPanel } from "../components/SessionLogPanel";
import {
  parseActiveSessionSnapshot,
  parseSessionHistory,
  type ActiveSession,
  type ActiveSourceCounts,
  type SessionHistoryEntry,
  type RecentSession,
  type SessionRoutePolicy,
} from "../session-workspace-data";

interface PolicyState {
  policy: SessionRoutePolicy;
  pending: boolean;
  error: boolean;
}

const SESSION_HISTORY_REFRESH_MS = 30_000;
const SESSION_HISTORY_DISPLAY_LIMIT = 500;

function formatTime(value: number, locale: Locale): string {
  return new Date(value).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatAge(startedAt: number, now: number, t: TFn): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return t("sessions.age.seconds", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("sessions.age.minutes", { count: minutes });
  return t("sessions.age.hours", { count: Math.floor(minutes / 60) });
}

function modelLabel(provider: string | undefined, model: string | undefined): string | undefined {
  if (!provider || !model) return model;
  const prefix = `${provider}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}
interface TokenDisplay {
  text: string;
  title?: string;
}
/**
 * Token column rendering rules: normal exact totals; prefix "~" when any estimated
 * requests exist; title for partial unmetered; em dash when no measured/total data.
 */
function tokenDisplay(
  totalTokens: number | undefined,
  estimatedRequests: number | undefined,
  unmeteredRequests: number | undefined,
  measuredRequests: number | undefined,
  locale: Locale,
  t: TFn,
): TokenDisplay | undefined {
  const hasMeasured = measuredRequests !== undefined && measuredRequests > 0;
  if (totalTokens === undefined && !hasMeasured) return undefined;
  if (totalTokens === undefined) return { text: "\u2014" };
  const prefix = (estimatedRequests ?? 0) > 0 ? "~" : "";
  const title = (unmeteredRequests ?? 0) > 0
    ? t("sessions.tokens.partial", { count: unmeteredRequests ?? 0 })
    : undefined;
  return { text: `${prefix}${formatTokens(totalTokens, locale)}`, title };
}

function activeSourceSummary(
  counts: ActiveSourceCounts | undefined,
  total: number,
  t: TFn,
): string {
  const gpt = counts?.gpt ?? 0;
  const glm = counts?.glm ?? 0;
  const other = (counts?.other ?? 0) + Math.max(0, total - gpt - glm - (counts?.other ?? 0));
  const parts = [
    ...(gpt > 0 ? [t("sessions.source.gpt", { count: gpt })] : []),
    ...(glm > 0 ? [t("sessions.source.glm", { count: glm })] : []),
    ...(other > 0 ? [t("sessions.source.other", { count: other })] : []),
  ];
  return parts.join(" ") || "0";
}

function RoutePair({
  requestedProvider,
  requestedModel,
  requestedEffort,
  effectiveProvider,
  effectiveModel,
  t,
}: {
  requestedProvider?: string;
  requestedModel?: string;
  requestedEffort?: string;
  effectiveProvider?: string;
  effectiveModel?: string;
  t: TFn;
}) {
  if (!requestedModel && !effectiveModel) return <span className="muted">{t("sessions.noRoute")}</span>;
  const displayModel = modelLabel(requestedProvider, requestedModel) ?? modelLabel(effectiveProvider, effectiveModel) ?? "—";
  return (
    <code className="session-model-display">{displayModel}{requestedEffort ? ` · ${requestedEffort}` : ""}</code>
  );
}

function PolicyControl({
  rootSessionId,
  state,
  onChange,
  t,
}: {
  rootSessionId: string;
  state: PolicyState;
  onChange: (rootSessionId: string, policy: SessionRoutePolicy) => void;
  t: TFn;
}) {
  return (
    <div className="session-policy-cell">
      <div
        className="usage-segmented session-policy-control"
        role="group"
        aria-label={t("sessions.policy.aria")}
        onClick={e => e.stopPropagation()}
      >
        {(["inherit", "personal_first", "company_first"] as const).map(policy => (
          <button
            key={policy}
            type="button"
            className={`usage-segmented-btn${state.policy === policy ? " active" : ""}`}
            aria-pressed={state.policy === policy}
            disabled={state.pending}
            onClick={() => onChange(rootSessionId, policy)}
          >
            {t(policy === "inherit"
              ? "sessions.policy.inherit"
              : policy === "personal_first"
                ? "sessions.policy.personalFirst"
                : "sessions.policy.companyFirst")}
          </button>
        ))}
      </div>
      {state.error && <span className="session-policy-error" role="status">{t("sessions.policy.updateError")}</span>}
    </div>
  );
}

function ActiveSessionRow({
  session,
  totalTokens,
  estimatedRequests,
  unmeteredRequests,
  measuredRequests,
  locale,
  policy,
  now,
  onPolicy,
  expanded,
  onToggle,
  apiBase,
  t,
}: {
  session: ActiveSession;
  totalTokens?: number;
  estimatedRequests?: number;
  unmeteredRequests?: number;
  measuredRequests?: number;
  locale: Locale;
  policy: PolicyState;
  now: number;
  onPolicy: (rootSessionId: string, policy: SessionRoutePolicy) => void;
  expanded: boolean;
  onToggle: (rootSessionId: string) => void;
  apiBase: string;
  t: TFn;
}) {
  const tokens = tokenDisplay(totalTokens, estimatedRequests, unmeteredRequests, measuredRequests, locale, t);
  return (
    <Fragment>
      <tr
        className="session-clickable"
        onClick={() => onToggle(session.rootSessionId)}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(session.rootSessionId); } }}
        tabIndex={0}
        role="button"
        aria-expanded={expanded}
      >
      <td className="session-id-cell">
        <div className="session-id-line">
          <span className="dot dot-green" aria-hidden="true" />
          <span className="session-name-toggle">
            {session.threadName ?? session.rootSessionId}
          </span>
        </div>
        <span className="session-meta">{t("sessions.started")} {formatAge(session.oldestStartedAt, now, t)}</span>
      </td>
      <td>
        <div className="session-activity-count">
          {activeSourceSummary(session.activeSourceCounts, session.activeRequests, t)}
        </div>
      </td>
      <td>
        <RoutePair
          requestedProvider={session.requestedProvider}
          requestedModel={session.requestedModel}
          requestedEffort={session.requestedEffort}
          effectiveProvider={session.effectiveProvider}
          effectiveModel={session.effectiveModel}
          t={t}
        />
      </td>
      <td className="num mono">
        {tokens ? <span title={tokens.title}>{tokens.text}</span> : <span className="muted">{"\u2014"}</span>}
      </td>
      <td><PolicyControl rootSessionId={session.rootSessionId} state={policy} onChange={onPolicy} t={t} /></td>
      </tr>
      {expanded && (
        <tr className="session-detail-row">
          <td colSpan={5}>
            <SessionLogPanel key={session.rootSessionId} apiBase={apiBase} rootSessionId={session.rootSessionId} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function RecentSessionRow({
  session,
  policy,
  onPolicy,
  locale,
  expanded,
  onToggle,
  apiBase,
  t,
}: {
  session: RecentSession;
  policy: PolicyState;
  onPolicy: (rootSessionId: string, policy: SessionRoutePolicy) => void;
  locale: Locale;
  expanded: boolean;
  onToggle: (rootSessionId: string) => void;
  apiBase: string;
  t: TFn;
}) {
  const tokens = tokenDisplay(
    session.totalTokens,
    session.estimatedRequests,
    session.unmeteredRequests,
    session.measuredRequests,
    locale,
    t,
  );
  return (
    <Fragment>
      <tr
        className="session-clickable"
        onClick={() => onToggle(session.rootSessionId)}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(session.rootSessionId); } }}
        tabIndex={0}
        role="button"
        aria-expanded={expanded}
      >
      <td className="session-id-cell">
        <div className="session-id-line">
          <span className="dot session-dot-idle" aria-hidden="true" />
          <span className="session-name-toggle">
            {session.threadName ?? session.rootSessionId}
          </span>
        </div>
        <span className="session-meta">{t("sessions.lastSeen")} {formatTime(session.lastSeenAt, locale)}</span>
      </td>
      <td>
        <span className="muted">—</span>
      </td>
      <td>
        <RoutePair
          requestedProvider={session.requestedProvider}
          requestedModel={session.requestedModel}
          requestedEffort={session.requestedEffort}
          effectiveProvider={session.effectiveProvider}
          effectiveModel={session.effectiveModel}
          t={t}
        />
      </td>
      <td className="num mono">
        {tokens ? <span title={tokens.title}>{tokens.text}</span> : <span className="muted">{"\u2014"}</span>}
      </td>
     <td><PolicyControl rootSessionId={session.rootSessionId} state={policy} onChange={onPolicy} t={t} /></td>
     </tr>
     {expanded && (
       <tr className="session-detail-row">
         <td colSpan={5}>
             <SessionLogPanel key={session.rootSessionId} apiBase={apiBase} rootSessionId={session.rootSessionId} />
         </td>
       </tr>
     )}
    </Fragment>
  );
}

export default function Sessions({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const [active, setActive] = useState<ActiveSession[]>([]);
  const [recent, setRecent] = useState<RecentSession[]>([]);
  const [unattributedActiveRequests, setUnattributedActiveRequests] = useState(0);
  const [policies, setPolicies] = useState<Record<string, PolicyState>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [now, setNow] = useState(0);
  const policyRef = useRef<Record<string, PolicyState>>({});
  const refreshInFlight = useRef(false);
  const [historyByRoot, setHistoryByRoot] = useState<Map<string, SessionHistoryEntry>>(new Map());
  const historyRef = useRef<SessionHistoryEntry[]>([]);
  const historyLoadedAtRef = useRef(0);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);

  const updatePolicies = useCallback((update: (current: Record<string, PolicyState>) => Record<string, PolicyState>) => {
    const next = update(policyRef.current);
    policyRef.current = next;
    setPolicies(next);
  }, []);

  const loadPolicy = useCallback(async (rootSessionId: string, signal?: AbortSignal) => {
    if (policyRef.current[rootSessionId]) return;
    try {
      const response = await fetch(`${apiBase}/api/sessions/${encodeURIComponent(rootSessionId)}/route-policy`, { signal });
      if (!response.ok) return;
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("routePolicy" in body)) return;
      const policy = body.routePolicy;
      if (policy !== "inherit" && policy !== "personal_first" && policy !== "company_first") return;
      updatePolicies(current => current[rootSessionId]
        ? current
        : { ...current, [rootSessionId]: { policy, pending: false, error: false } });
    } catch {
      // The row remains usable with the fail-safe inherit default.
    }
  }, [apiBase, updatePolicies]);

  const loadSessions = useCallback(async (signal?: AbortSignal, forceHistory = false) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const shouldRefreshHistory = forceHistory
        || historyLoadedAtRef.current === 0
        || Date.now() - historyLoadedAtRef.current >= SESSION_HISTORY_REFRESH_MS;
      const [activeResponse, historyResponse] = await Promise.all([
        fetch(`${apiBase}/api/sessions/active`, { signal }),
        shouldRefreshHistory
          ? fetch(`${apiBase}/api/sessions/history?limit=${SESSION_HISTORY_DISPLAY_LIMIT}`, { signal })
          : Promise.resolve(null),
      ]);
      if (!activeResponse.ok || (historyResponse && !historyResponse.ok)) {
        throw new Error("session fetch failed");
      }
      const activeSnapshot = parseActiveSessionSnapshot(await activeResponse.json());
      let historyEntries = historyRef.current;
      let refreshedHistory: SessionHistoryEntry[] | undefined;
      if (historyResponse) {
        const historySnapshot = parseSessionHistory(await historyResponse.json());
        historyEntries = historySnapshot.sessions;
        refreshedHistory = historyEntries;
      }
      if (signal?.aborted) return;
      if (refreshedHistory) {
        historyRef.current = refreshedHistory;
        historyLoadedAtRef.current = Date.now();
        setHistoryByRoot(new Map(refreshedHistory.map(entry => [entry.rootSessionId, entry])));
      }
      setActive(activeSnapshot.sessions);
      const recentHistories = historyEntries
        .filter(entry => !activeSnapshot.sessions.some(s => s.rootSessionId === entry.rootSessionId))
        .slice(0, 20);
      setRecent(recentHistories);
      setUnattributedActiveRequests(activeSnapshot.unattributedActiveRequests);
      setLoadError(false);
      setNow(Date.now());

      const roots = new Set([
        ...activeSnapshot.sessions.map(session => session.rootSessionId),
        ...recentHistories.map(session => session.rootSessionId),
      ]);
      updatePolicies(current => {
        const retained = Object.entries(current).filter(([rootSessionId, state]) => (
          roots.has(rootSessionId) || state.pending
        ));
        return retained.length === Object.keys(current).length ? current : Object.fromEntries(retained);
      });
      await Promise.all([...roots].map(rootSessionId => loadPolicy(rootSessionId, signal)));
    } catch {
      if (!signal?.aborted) setLoadError(true);
    } finally {
      if (!signal?.aborted) setLoading(false);
      refreshInFlight.current = false;
    }
  }, [apiBase, loadPolicy, updatePolicies]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => void loadSessions(controller.signal, true), 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadSessions(controller.signal);
    }, 2000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      controller.abort();
    };
  }, [loadSessions]);

  const changePolicy = useCallback(async (rootSessionId: string, policy: SessionRoutePolicy) => {
    const previous = policyRef.current[rootSessionId]?.policy ?? "inherit";
    if (previous === policy || policyRef.current[rootSessionId]?.pending) return;
    updatePolicies(current => ({ ...current, [rootSessionId]: { policy, pending: true, error: false } }));
    try {
      const response = await fetch(`${apiBase}/api/sessions/${encodeURIComponent(rootSessionId)}/route-policy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routePolicy: policy }),
      });
      if (!response.ok) throw new Error("policy update failed");
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("routePolicy" in body) || body.routePolicy !== policy) {
        throw new Error("invalid policy response");
      }
      updatePolicies(current => ({ ...current, [rootSessionId]: { policy, pending: false, error: false } }));
    } catch {
      updatePolicies(current => ({ ...current, [rootSessionId]: { policy: previous, pending: false, error: true } }));
    }
  }, [apiBase, updatePolicies]);

  const activeIds = useMemo(() => new Set(active.map(session => session.rootSessionId)), [active]);
  const recentIdle = useMemo(() => recent.filter(session => !activeIds.has(session.rootSessionId)), [activeIds, recent]);
  const fallbackCount = active.filter(session => session.fallbackReason !== undefined).length;
  const activeRequestCount = active.reduce((total, session) => total + session.activeRequests, 0);
  const activeSourceCounts = useMemo(() => active.reduce<ActiveSourceCounts>((total, session) => ({
    gpt: total.gpt + (session.activeSourceCounts?.gpt ?? 0),
    glm: total.glm + (session.activeSourceCounts?.glm ?? 0),
    other: total.other + (session.activeSourceCounts?.other ?? 0),
  }), { gpt: 0, glm: 0, other: 0 }), [active]);
  const activeSummary = activeSourceSummary(activeSourceCounts, activeRequestCount, t);
 const policyFor = (rootSessionId: string, routePolicy?: SessionRoutePolicy): PolicyState => (
   policies[rootSessionId] ?? { policy: routePolicy ?? "inherit", pending: false, error: false }
 );
  const toggleSession = useCallback((rootSessionId: string) => {
    setExpandedSession(current => (current === rootSessionId ? null : rootSessionId));
  }, []);

  return (
    <div className="sessions-page">
      <div className="page-head">
        <h2>{t("sessions.title")}</h2>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label={t("sessions.refresh")}
          title={t("sessions.refresh")}
          disabled={loading}
          onClick={() => void loadSessions(undefined, true)}
        >
          <IconRefresh />
        </button>
      </div>

      {loadError && <div className="sessions-load-error" role="status"><IconAlert />{t("sessions.loadError")}</div>}
      {unattributedActiveRequests > 0 && (
        <div className="sessions-load-error" role="status">
          <IconAlert />{t("sessions.unattributedHint", { count: unattributedActiveRequests })}
        </div>
      )}

      <div className="sessions-summary" aria-label={t("sessions.summaryAria")}>
        <div><span>{t("sessions.active")}</span><strong>{activeSummary}</strong></div>
        <div><span>{t("sessions.recent")}</span><strong>{recentIdle.length.toLocaleString(locale)}</strong></div>
        <div className={unattributedActiveRequests > 0 ? "has-unattributed" : ""}><span>{t("sessions.unattributed")}</span><strong>{unattributedActiveRequests.toLocaleString(locale)}</strong></div>
        <div className={fallbackCount > 0 ? "has-fallback" : ""}><span>{t("sessions.fallbacks")}</span><strong>{fallbackCount.toLocaleString(locale)}</strong></div>
      </div>

      {loading && active.length === 0 && recent.length === 0 ? (
        <EmptyState icon={<IconActivity />} title={t("sessions.loading")} />
      ) : (
        <>
          <section className="sessions-section" aria-labelledby="sessions-active-title">
            <div className="sessions-section-head">
              <h3 id="sessions-active-title">{t("sessions.active")}</h3>
              <span>{activeSummary}</span>
            </div>
            {active.length === 0 ? (
              <EmptyState icon={<IconActivity />} title={t("sessions.emptyActive")} />
            ) : (
            <div className="tbl-wrap sessions-table-wrap">
              <table className="tbl sessions-table">
                <thead><tr>
                  <th>{t("sessions.col.session")}</th>
                  <th>{t("sessions.col.activity")}</th>
                  <th>{t("sessions.col.model")}</th>
                  <th className="session-token-heading">{t("sessions.col.tokens")}</th>
                  <th>{t("sessions.col.policy")}</th>
                </tr></thead>
                 <tbody>{active.map(session => (
                   <ActiveSessionRow
                     key={session.rootSessionId}
                     session={session}
                      totalTokens={historyByRoot.get(session.rootSessionId)?.totalTokens}
                      estimatedRequests={historyByRoot.get(session.rootSessionId)?.estimatedRequests}
                      unmeteredRequests={historyByRoot.get(session.rootSessionId)?.unmeteredRequests}
                      measuredRequests={historyByRoot.get(session.rootSessionId)?.measuredRequests}
                      locale={locale}
                     policy={policyFor(session.rootSessionId, session.routePolicy)}
                     now={now}
                     onPolicy={changePolicy}
                      expanded={expandedSession === session.rootSessionId}
                      onToggle={toggleSession}
                      apiBase={apiBase}
                     t={t}
                   />
                 ))}</tbody>
               </table>
             </div>
            )}
          </section>

          <section className="sessions-section" aria-labelledby="sessions-recent-title">
            <div className="sessions-section-head">
              <h3 id="sessions-recent-title">{t("sessions.recent")}</h3>
              <span>{recentIdle.length.toLocaleString(locale)}</span>
            </div>
            {recentIdle.length === 0 ? (
              <EmptyState title={t("sessions.emptyRecent")} />
            ) : (
            <div className="tbl-wrap sessions-table-wrap">
              <table className="tbl sessions-table">
                <thead><tr>
                  <th>{t("sessions.col.session")}</th>
                  <th>{t("sessions.col.execution")}</th>
                  <th>{t("sessions.col.model")}</th>
                  <th className="session-token-heading">{t("sessions.col.tokens")}</th>
                  <th>{t("sessions.col.policy")}</th>
                </tr></thead>
                 <tbody>{recentIdle.map(session => (
                   <RecentSessionRow
                     key={session.rootSessionId}
                     session={session}
                     policy={policyFor(session.rootSessionId)}
                     onPolicy={changePolicy}
                     locale={locale}
                      expanded={expandedSession === session.rootSessionId}
                      onToggle={toggleSession}
                      apiBase={apiBase}
                     t={t}
                   />
                 ))}</tbody>
               </table>
             </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
