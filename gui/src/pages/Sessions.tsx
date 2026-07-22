import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n, type Locale, type TFn } from "../i18n";
import { IconActivity, IconAlert, IconRefresh } from "../icons";
import { EmptyState } from "../ui";
import {
  parseActiveSessionSnapshot,
  parseRecentSessions,
  type ActiveSession,
  type EffectiveUpstream,
  type RecentSession,
  type SessionRoutePolicy,
} from "../session-workspace-data";

interface PolicyState {
  policy: SessionRoutePolicy;
  pending: boolean;
  error: boolean;
}

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

function upstreamTone(upstream: EffectiveUpstream | undefined, fallback: boolean): string {
  if (fallback) return "badge-amber";
  if (upstream === "codex_pool") return "badge-green";
  if (upstream === "codex_direct" || upstream === "provider") return "badge-accent";
  return "badge-muted";
}

function upstreamLabel(upstream: EffectiveUpstream | undefined, t: TFn): string {
  if (upstream === "codex_pool") return t("sessions.upstream.codexPool");
  if (upstream === "codex_direct") return t("sessions.upstream.codexDirect");
  if (upstream === "provider") return t("sessions.upstream.provider");
  return t("sessions.upstream.none");
}

function modelLabel(provider: string | undefined, model: string | undefined): string | undefined {
  if (!provider || !model) return model;
  const prefix = `${provider}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

function RoutePair({
  requestedProvider,
  requestedModel,
  effectiveProvider,
  effectiveModel,
  t,
}: {
  requestedProvider?: string;
  requestedModel?: string;
  effectiveProvider?: string;
  effectiveModel?: string;
  t: TFn;
}) {
  if (!requestedModel && !effectiveModel) return <span className="muted">{t("sessions.noRoute")}</span>;
  const requestedLabel = modelLabel(requestedProvider, requestedModel);
  const effectiveLabel = modelLabel(effectiveProvider, effectiveModel);
  return (
    <div className="session-route-pair">
      <div>
        <span className="session-route-label">{t("sessions.requested")}</span>
        <code>{requestedProvider ? `${requestedProvider} / ` : ""}{requestedLabel ?? "—"}</code>
      </div>
      <span className="session-route-arrow" aria-hidden="true">→</span>
      <div>
        <span className="session-route-label">{t("sessions.effective")}</span>
        <code>{effectiveProvider ? `${effectiveProvider} / ` : ""}{effectiveLabel ?? "—"}</code>
      </div>
    </div>
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
      <div className="usage-segmented session-policy-control" role="group" aria-label={t("sessions.policy.aria")}>
        {(["inherit", "personal_first"] as const).map(policy => (
          <button
            key={policy}
            type="button"
            className={`usage-segmented-btn${state.policy === policy ? " active" : ""}`}
            aria-pressed={state.policy === policy}
            disabled={state.pending}
            onClick={() => onChange(rootSessionId, policy)}
          >
            {t(policy === "inherit" ? "sessions.policy.inherit" : "sessions.policy.personalFirst")}
          </button>
        ))}
      </div>
      {state.error && <span className="session-policy-error" role="status">{t("sessions.policy.updateError")}</span>}
    </div>
  );
}

function ActiveSessionRow({
  session,
  policy,
  now,
  onPolicy,
  t,
}: {
  session: ActiveSession;
  policy: PolicyState;
  now: number;
  onPolicy: (rootSessionId: string, policy: SessionRoutePolicy) => void;
  t: TFn;
}) {
  const fallback = session.fallbackReason === "all_personal_accounts_unavailable";
  return (
    <tr>
      <td className="session-id-cell">
        <div className="session-id-line"><span className="dot dot-green" aria-hidden="true" /><code>{session.rootSessionId}</code></div>
        <span className="session-meta">{t("sessions.started")} {formatAge(session.oldestStartedAt, now, t)}</span>
      </td>
      <td>
        <div className="session-activity-count">{t("sessions.activeRequests", { count: session.activeRequests })}</div>
        <div className="session-executions">
          {session.executionSessionIds.map(id => (
            <span key={id} className="session-execution-chip">
              <span>{id === session.rootSessionId ? t("sessions.main") : t("sessions.child")}</span>
              <code>{id}</code>
            </span>
          ))}
        </div>
      </td>
      <td>
        <RoutePair
          requestedProvider={session.requestedProvider}
          requestedModel={session.requestedModel}
          effectiveProvider={session.effectiveProvider}
          effectiveModel={session.effectiveModel}
          t={t}
        />
      </td>
      <td>
        <span className={`badge ${upstreamTone(session.effectiveUpstream, fallback)}`}>
          {upstreamLabel(session.effectiveUpstream, t)}
        </span>
        {fallback && <div className="session-fallback"><IconAlert />{t("sessions.fallback.personalUnavailable")}</div>}
      </td>
      <td><PolicyControl rootSessionId={session.rootSessionId} state={policy} onChange={onPolicy} t={t} /></td>
    </tr>
  );
}

function RecentSessionRow({
  session,
  policy,
  onPolicy,
  locale,
  t,
}: {
  session: RecentSession;
  policy: PolicyState;
  onPolicy: (rootSessionId: string, policy: SessionRoutePolicy) => void;
  locale: Locale;
  t: TFn;
}) {
  return (
    <tr>
      <td className="session-id-cell">
        <div className="session-id-line"><span className="dot session-dot-idle" aria-hidden="true" /><code>{session.rootSessionId}</code></div>
        <span className="session-meta">{t("sessions.lastSeen")} {formatTime(session.lastSeenAt, locale)}</span>
      </td>
      <td>
        {session.executionSessionId
          ? <span className="session-execution-chip"><span>{session.executionSessionId === session.rootSessionId ? t("sessions.main") : t("sessions.child")}</span><code>{session.executionSessionId}</code></span>
          : <span className="muted">—</span>}
      </td>
      <td>
        <RoutePair
          requestedProvider={session.requestedProvider}
          requestedModel={session.requestedModel}
          effectiveProvider={session.effectiveProvider}
          effectiveModel={session.effectiveModel}
          t={t}
        />
      </td>
      <td><span className="badge badge-muted">{t("sessions.status.recent")}</span></td>
      <td><PolicyControl rootSessionId={session.rootSessionId} state={policy} onChange={onPolicy} t={t} /></td>
    </tr>
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
      if (policy !== "inherit" && policy !== "personal_first") return;
      updatePolicies(current => current[rootSessionId]
        ? current
        : { ...current, [rootSessionId]: { policy, pending: false, error: false } });
    } catch {
      // The row remains usable with the fail-safe inherit default.
    }
  }, [apiBase, updatePolicies]);

  const loadSessions = useCallback(async (signal?: AbortSignal) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const [activeResponse, logsResponse] = await Promise.all([
        fetch(`${apiBase}/api/sessions/active`, { signal }),
        fetch(`${apiBase}/api/logs?tail=200`, { signal }),
      ]);
      if (!activeResponse.ok || !logsResponse.ok) throw new Error("session fetch failed");
      const activeSnapshot = parseActiveSessionSnapshot(await activeResponse.json());
      const recentSessions = parseRecentSessions(await logsResponse.json());
      if (signal?.aborted) return;
      setActive(activeSnapshot.sessions);
      setRecent(recentSessions);
      setUnattributedActiveRequests(activeSnapshot.unattributedActiveRequests);
      setLoadError(false);
      setNow(Date.now());

      const roots = new Set([
        ...activeSnapshot.sessions.map(session => session.rootSessionId),
        ...recentSessions.map(session => session.rootSessionId),
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
    const timeout = window.setTimeout(() => void loadSessions(controller.signal), 0);
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
  const policyFor = (rootSessionId: string, routePolicy?: SessionRoutePolicy): PolicyState => (
    policies[rootSessionId] ?? { policy: routePolicy ?? "inherit", pending: false, error: false }
  );

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
          onClick={() => void loadSessions()}
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
        <div><span>{t("sessions.active")}</span><strong>{active.length.toLocaleString(locale)}</strong></div>
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
              <span>{active.length.toLocaleString(locale)}</span>
            </div>
            {active.length === 0 ? (
              <EmptyState icon={<IconActivity />} title={t("sessions.emptyActive")} />
            ) : (
              <div className="tbl-wrap sessions-table-wrap">
                <table className="tbl sessions-table">
                  <thead><tr>
                    <th>{t("sessions.col.session")}</th>
                    <th>{t("sessions.col.activity")}</th>
                    <th>{t("sessions.col.route")}</th>
                    <th>{t("sessions.col.upstream")}</th>
                    <th>{t("sessions.col.policy")}</th>
                  </tr></thead>
                  <tbody>{active.map(session => (
                    <ActiveSessionRow
                      key={session.rootSessionId}
                      session={session}
                      policy={policyFor(session.rootSessionId, session.routePolicy)}
                      now={now}
                      onPolicy={changePolicy}
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
                    <th>{t("sessions.col.route")}</th>
                    <th>{t("sessions.col.status")}</th>
                    <th>{t("sessions.col.policy")}</th>
                  </tr></thead>
                  <tbody>{recentIdle.map(session => (
                    <RecentSessionRow
                      key={session.rootSessionId}
                      session={session}
                      policy={policyFor(session.rootSessionId)}
                      onPolicy={changePolicy}
                      locale={locale}
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
