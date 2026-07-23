export const OPTIONAL_NAV_PAGES = ["combos", "logs", "debug", "api", "claude"] as const;

export type OptionalNavPage = typeof OPTIONAL_NAV_PAGES[number];
export type NavigationVisibility = Record<OptionalNavPage, boolean>;

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = "ocx-navigation-visibility-v1";

export const DEFAULT_NAVIGATION_VISIBILITY: NavigationVisibility = {
  combos: false,
  logs: false,
  debug: false,
  api: false,
  claude: false,
};

function browserStorage(): PreferenceStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function parseNavigationVisibility(value: unknown): NavigationVisibility {
  const parsed = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return Object.fromEntries(OPTIONAL_NAV_PAGES.map(page => [
    page,
    typeof parsed[page] === "boolean" ? parsed[page] : DEFAULT_NAVIGATION_VISIBILITY[page],
  ])) as NavigationVisibility;
}

export function readNavigationVisibility(storage = browserStorage()): NavigationVisibility {
  if (!storage) return { ...DEFAULT_NAVIGATION_VISIBILITY };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return raw ? parseNavigationVisibility(JSON.parse(raw)) : { ...DEFAULT_NAVIGATION_VISIBILITY };
  } catch {
    return { ...DEFAULT_NAVIGATION_VISIBILITY };
  }
}

export function writeNavigationVisibility(
  visibility: NavigationVisibility,
  storage = browserStorage(),
): void {
  if (!storage) return;
  try { storage.setItem(STORAGE_KEY, JSON.stringify(visibility)); } catch { /* local storage may be disabled */ }
}

export function isOptionalNavPage(page: string): page is OptionalNavPage {
  return (OPTIONAL_NAV_PAGES as readonly string[]).includes(page);
}
