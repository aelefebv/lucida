// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRestoreLastViewEnabled,
  setRestoreLastViewEnabled,
  resolveInitialViewSource,
} from "./lastViewPreference.ts";
import { PREFERENCES_STORAGE_KEY, __resetPreferencesForTesting } from "./theme/preferences.ts";
import { failingStorage } from "./theme/storageFixtures.ts";

const LEGACY_KEY = "lucida.restoreLastView";

beforeEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  __resetPreferencesForTesting();
});

describe("getRestoreLastViewEnabled / setRestoreLastViewEnabled", () => {
  it("defaults to true when nothing is stored", () => {
    expect(getRestoreLastViewEnabled()).toBe(true);
  });

  it("round-trips an explicit off then on, as a preference", () => {
    setRestoreLastViewEnabled(false);
    expect(getRestoreLastViewEnabled()).toBe(false);
    expect(localStorage.getItem(PREFERENCES_STORAGE_KEY)).toContain('"viewer.restoreLastView":false');

    setRestoreLastViewEnabled(true);
    expect(getRestoreLastViewEnabled()).toBe(true);
  });

  it("never throws when writing fails (quota / private browsing)", () => {
    vi.stubGlobal("localStorage", failingStorage());
    __resetPreferencesForTesting();
    expect(() => setRestoreLastViewEnabled(false)).not.toThrow();
    expect(getRestoreLastViewEnabled()).toBe(false);
  });
});

describe("the old storage key", () => {
  it.each([
    ["false", false],
    ["0", false],
    ["true", true],
    ["garbage", true],
  ])("reads %j as %s, once, and removes it", (raw, enabled) => {
    localStorage.setItem(LEGACY_KEY, raw);
    __resetPreferencesForTesting();
    expect(getRestoreLastViewEnabled()).toBe(enabled);
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });
});

describe("resolveInitialViewSource priority", () => {
  it("a URL hash always wins, even with last-view + default available", () => {
    expect(
      resolveInitialViewSource({
        hasUrlHash: true,
        restoreEnabled: true,
        hasLastView: true,
        hasDefault: true,
      }),
    ).toBe("url");
  });

  it("a URL hash wins even when the toggle is off and there is a default", () => {
    expect(
      resolveInitialViewSource({
        hasUrlHash: true,
        restoreEnabled: false,
        hasLastView: false,
        hasDefault: true,
      }),
    ).toBe("url");
  });

  it("uses the last view when enabled + available and there is no hash", () => {
    expect(
      resolveInitialViewSource({
        hasUrlHash: false,
        restoreEnabled: true,
        hasLastView: true,
        hasDefault: true,
      }),
    ).toBe("last-view");
  });

  it("falls back to the default when the toggle is off", () => {
    expect(
      resolveInitialViewSource({
        hasUrlHash: false,
        restoreEnabled: false,
        hasLastView: true,
        hasDefault: true,
      }),
    ).toBe("default");
  });

  it("falls back to the default when there is no remembered last view", () => {
    expect(
      resolveInitialViewSource({
        hasUrlHash: false,
        restoreEnabled: true,
        hasLastView: false,
        hasDefault: true,
      }),
    ).toBe("default");
  });

  it("resolves to none when nothing applies", () => {
    expect(
      resolveInitialViewSource({
        hasUrlHash: false,
        restoreEnabled: true,
        hasLastView: false,
        hasDefault: false,
      }),
    ).toBe("none");
    expect(
      resolveInitialViewSource({
        hasUrlHash: false,
        restoreEnabled: false,
        hasLastView: false,
        hasDefault: false,
      }),
    ).toBe("none");
  });

  it("last view never promotes to the shared default (no hash, enabled, no default)", () => {
    // The remembered view is applied as last-view, not as default: recording
    // a last view must never become the workspace default.
    expect(
      resolveInitialViewSource({
        hasUrlHash: false,
        restoreEnabled: true,
        hasLastView: true,
        hasDefault: false,
      }),
    ).toBe("last-view");
  });
});
