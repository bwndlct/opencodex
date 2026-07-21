import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir, hardenConfigDir } from "../config";
import { sanitizeIdentityValue } from "./request-identity";

export type SessionRoutePolicy = "inherit" | "personal_first";

export interface SessionRoutePolicyRecord {
  rootSessionId: string;
  routePolicy: SessionRoutePolicy;
  updatedAt: string;
}

interface SessionRoutePolicyStoreDeps {
  exists?: (path: string) => boolean;
  read?: (path: string) => string;
  write?: (path: string, content: string) => void;
  warn?: (message: string) => void;
}

export interface SetSessionRoutePolicyResult {
  record: SessionRoutePolicyRecord;
  changed: boolean;
}

export class SessionRoutePolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionRoutePolicyValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isSessionRoutePolicy(value: unknown): value is SessionRoutePolicy {
  return value === "inherit" || value === "personal_first";
}

export function normalizeRootSessionId(value: unknown): string | undefined {
  return sanitizeIdentityValue(value);
}

function parsePolicyRecord(value: unknown): SessionRoutePolicyRecord | undefined {
  if (!isRecord(value)) return undefined;
  const rootSessionId = normalizeRootSessionId(value.rootSessionId);
  if (!rootSessionId || !isSessionRoutePolicy(value.routePolicy)) return undefined;
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) return undefined;
  return { rootSessionId, routePolicy: value.routePolicy, updatedAt: value.updatedAt };
}

function sortedRecords(policies: ReadonlyMap<string, SessionRoutePolicyRecord>): SessionRoutePolicyRecord[] {
  return [...policies.values()].sort((left, right) => (
    left.rootSessionId < right.rootSessionId ? -1 : left.rootSessionId > right.rootSessionId ? 1 : 0
  ));
}

function defaultPolicyWriter(path: string, content: string): void {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true, mode: 0o700 });
  hardenConfigDir();
  atomicWriteFile(path, content);
}

export class SessionRoutePolicyStore {
  private policies = new Map<string, SessionRoutePolicyRecord>();
  private readonly exists: (path: string) => boolean;
  private readonly read: (path: string) => string;
  private readonly write: (path: string, content: string) => void;
  private readonly warn: (message: string) => void;

  constructor(readonly path: string, deps: SessionRoutePolicyStoreDeps = {}) {
    this.exists = deps.exists ?? existsSync;
    this.read = deps.read ?? (target => readFileSync(target, "utf8"));
    this.write = deps.write ?? defaultPolicyWriter;
    this.warn = deps.warn ?? (message => console.warn(message));
    this.load();
  }

  private load(): void {
    if (!this.exists(this.path)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.read(this.path));
    } catch (error) {
      this.warn(`[session-route-policy] failed to load ${this.path}; starting empty: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!Array.isArray(parsed)) {
      this.warn(`[session-route-policy] invalid store shape in ${this.path}; starting empty`);
      return;
    }
    const loaded = new Map<string, SessionRoutePolicyRecord>();
    for (const value of parsed) {
      const record = parsePolicyRecord(value);
      if (record) loaded.set(record.rootSessionId, record);
    }
    this.policies = loaded;
  }

  get(rootSessionId: unknown): SessionRoutePolicy {
    const normalized = normalizeRootSessionId(rootSessionId);
    if (!normalized) return "inherit";
    return this.policies.get(normalized)?.routePolicy ?? "inherit";
  }

  has(rootSessionId: unknown): boolean {
    const normalized = normalizeRootSessionId(rootSessionId);
    return normalized ? this.policies.has(normalized) : false;
  }

  set(rootSessionId: unknown, routePolicy: unknown, now = Date.now()): SetSessionRoutePolicyResult {
    const normalized = normalizeRootSessionId(rootSessionId);
    if (!normalized) throw new SessionRoutePolicyValidationError("invalid root session id");
    if (!isSessionRoutePolicy(routePolicy)) throw new SessionRoutePolicyValidationError("invalid route policy");
    const existing = this.policies.get(normalized);
    if (existing?.routePolicy === routePolicy) return { record: existing, changed: false };

    if (!Number.isFinite(now)) throw new SessionRoutePolicyValidationError("invalid update timestamp");
    const updatedAt = new Date(now).toISOString();
    const record: SessionRoutePolicyRecord = { rootSessionId: normalized, routePolicy, updatedAt };
    const next = new Map(this.policies);
    next.set(normalized, record);
    this.write(this.path, `${JSON.stringify(sortedRecords(next), null, 2)}\n`);
    this.policies = next;
    return { record, changed: true };
  }

  snapshot(): SessionRoutePolicyRecord[] {
    return sortedRecords(this.policies).map(record => ({ ...record }));
  }
}

let productionStore: { path: string; store: SessionRoutePolicyStore } | undefined;

export function getSessionRoutePolicyPath(): string {
  return join(getConfigDir(), "session-route-policies.json");
}

function currentSessionRoutePolicyStore(): SessionRoutePolicyStore {
  const path = getSessionRoutePolicyPath();
  if (!productionStore || productionStore.path !== path) {
    productionStore = { path, store: new SessionRoutePolicyStore(path) };
  }
  return productionStore.store;
}

export function getSessionRoutePolicy(rootSessionId: unknown): SessionRoutePolicy {
  return currentSessionRoutePolicyStore().get(rootSessionId);
}

export function hasSessionRoutePolicy(rootSessionId: unknown): boolean {
  return currentSessionRoutePolicyStore().has(rootSessionId);
}

export function setSessionRoutePolicy(
  rootSessionId: unknown,
  routePolicy: unknown,
  now = Date.now(),
): SetSessionRoutePolicyResult {
  return currentSessionRoutePolicyStore().set(rootSessionId, routePolicy, now);
}

export function resetSessionRoutePolicyStoreForTests(): void {
  productionStore = undefined;
}
