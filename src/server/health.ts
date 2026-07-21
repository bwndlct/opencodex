import type { OcxConfig } from "../types";
import { readUsageEntries, type PersistedUsageEntry } from "../usage/log";
import { IncidentHistory, type Incident } from "./incidents";

export type HealthStatus = "healthy" | "degraded";

export interface HealthComponent {
  name: "relay" | "default_provider" | "incident_history";
  status: HealthStatus;
  detail: string;
  checkedAt: string;
}

export interface HealthReport {
  status: HealthStatus;
  components: HealthComponent[];
}

export interface HealthReportOptions {
  now?: number;
  recentErrorWindowMs?: number;
  readEntries?: () => PersistedUsageEntry[];
}

export const RECENT_HEALTH_ERROR_WINDOW_MS = 5 * 60_000;

function component(
  name: HealthComponent["name"],
  status: HealthStatus,
  detail: string,
  checkedAt: string,
): HealthComponent {
  return { name, status, detail, checkedAt };
}

function recentError(incidents: readonly Incident[], cutoff: number): boolean {
  return incidents.some(incident => incident.severity === "error" && incident.timestamp >= cutoff);
}

/** Build a local, non-probing health classification with no credential or path fields. */
export function buildHealthReport(config: OcxConfig, options: HealthReportOptions = {}): HealthReport {
  const now = options.now ?? Date.now();
  const checkedAt = new Date(now).toISOString();
  const errorWindowMs = options.recentErrorWindowMs ?? RECENT_HEALTH_ERROR_WINDOW_MS;
  const readEntries = options.readEntries ?? readUsageEntries;
  const components: HealthComponent[] = [];

  try {
    const incidents = new IncidentHistory(readEntries).list({ limit: 200 });
    components.push(recentError(incidents, now - errorWindowMs)
      ? component("relay", "degraded", "recent request error; inspect incident history", checkedAt)
      : component("relay", "healthy", "HTTP handler is running", checkedAt));
    components.push(component("incident_history", "healthy", "persistent incident history is readable", checkedAt));
  } catch {
    components.push(component("relay", "healthy", "HTTP handler is running; recent incident state is unavailable", checkedAt));
    components.push(component("incident_history", "degraded", "persistent incident history is unavailable", checkedAt));
  }

  const defaultProvider = config.defaultProvider?.trim();
  const provider = defaultProvider ? config.providers[defaultProvider] : undefined;
  if (!defaultProvider || !provider) {
    components.push(component("default_provider", "degraded", "default provider is not configured", checkedAt));
  } else if (provider.disabled) {
    components.push(component("default_provider", "degraded", "default provider is disabled", checkedAt));
  } else {
    components.push(component("default_provider", "healthy", "configured; active upstream probe is disabled", checkedAt));
  }

  return {
    status: components.some(item => item.status === "degraded") ? "degraded" : "healthy",
    components,
  };
}
