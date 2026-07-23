import { expect, test } from "bun:test";
import {
  DEFAULT_NAVIGATION_VISIBILITY,
  OPTIONAL_NAV_PAGES,
  isOptionalNavPage,
  parseNavigationVisibility,
  readNavigationVisibility,
  writeNavigationVisibility,
  type NavigationVisibility,
} from "../gui/src/navigation-preferences";

function fakeStorage(): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => store.has(key) ? store.get(key)! : null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  };
}

test("all five optional pages default to hidden", () => {
  for (const page of OPTIONAL_NAV_PAGES) {
    expect(DEFAULT_NAVIGATION_VISIBILITY[page]).toBe(false);
  }
  expect(Object.keys(DEFAULT_NAVIGATION_VISIBILITY).sort()).toEqual([...OPTIONAL_NAV_PAGES].sort());
});

test("parseNavigationVisibility fills missing keys with defaults", () => {
  const result = parseNavigationVisibility({ combos: true });
  expect(result.combos).toBe(true);
  expect(result.logs).toBe(false);
  expect(result.debug).toBe(false);
  expect(result.api).toBe(false);
  expect(result.claude).toBe(false);
});

test("parseNavigationVisibility ignores non-boolean values and falls back to defaults", () => {
  const result = parseNavigationVisibility({ combos: "yes", logs: 1, debug: null, api: undefined, claude: true });
  expect(result.combos).toBe(false);
  expect(result.logs).toBe(false);
  expect(result.debug).toBe(false);
  expect(result.api).toBe(false);
  expect(result.claude).toBe(true);
});

test("parseNavigationVisibility returns all defaults for non-object input", () => {
  for (const bad of [null, undefined, "combos", 42, [], true] as unknown[]) {
    const result = parseNavigationVisibility(bad);
    expect(result).toEqual(DEFAULT_NAVIGATION_VISIBILITY);
  }
});

test("readNavigationVisibility returns defaults when storage is empty", () => {
  const storage = fakeStorage();
  expect(readNavigationVisibility(storage)).toEqual(DEFAULT_NAVIGATION_VISIBILITY);
});

test("readNavigationVisibility returns defaults when storage is undefined", () => {
  expect(readNavigationVisibility(undefined)).toEqual(DEFAULT_NAVIGATION_VISIBILITY);
});

test("readNavigationVisibility round-trips a persisted full visibility object", () => {
  const storage = fakeStorage();
  const visibility: NavigationVisibility = { combos: true, logs: false, debug: true, api: false, claude: true };
  writeNavigationVisibility(visibility, storage);
  expect(readNavigationVisibility(storage)).toEqual(visibility);
});

test("readNavigationVisibility handles malformed JSON gracefully", () => {
  const store = new Map<string, string>();
  store.set("ocx-navigation-visibility-v1", "{not valid json");
  const storage = {
    getItem: (key: string) => store.has(key) ? store.get(key)! : null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  };
  expect(readNavigationVisibility(storage)).toEqual(DEFAULT_NAVIGATION_VISIBILITY);
});

test("readNavigationVisibility handles partial persisted object", () => {
  const store = new Map<string, string>();
  store.set("ocx-navigation-visibility-v1", JSON.stringify({ combos: true, logs: true }));
  const storage = {
    getItem: (key: string) => store.has(key) ? store.get(key)! : null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  };
  const result = readNavigationVisibility(storage);
  expect(result.combos).toBe(true);
  expect(result.logs).toBe(true);
  expect(result.debug).toBe(false);
  expect(result.api).toBe(false);
  expect(result.claude).toBe(false);
});

test("writeNavigationVisibility is a no-op when storage is undefined", () => {
  const visibility: NavigationVisibility = { combos: true, logs: true, debug: true, api: true, claude: true };
  expect(() => writeNavigationVisibility(visibility, undefined)).not.toThrow();
});

test("isOptionalNavPage narrows only the five optional pages", () => {
  for (const page of OPTIONAL_NAV_PAGES) {
    expect(isOptionalNavPage(page)).toBe(true);
  }
  for (const page of ["dashboard", "settings", "sessions", "providers", "models", "subagents", "usage", "storage", "codex-auth"]) {
    expect(isOptionalNavPage(page)).toBe(false);
  }
});
