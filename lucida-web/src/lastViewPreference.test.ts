// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESTORE_LAST_VIEW_KEY,
  getRestoreLastViewEnabled,
  setRestoreLastViewEnabled,
  resolveInitialViewSource,
} from "./lastViewPreference.ts";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("getRestoreLastViewEnabled / setRestoreLastViewEnabled", () => {
  it("defaults to true when nothing is stored", () => {
    expect(localStorage.getItem(RESTORE_LAST_VIEW_KEY)).toBeNull();
    expect(getRestoreLastViewEnabled()).toBe(true);
  });

  it("round-trips an explicit off then on", () => {
    setRestoreLastViewEnabled(false);
    expect(localStorage.getItem(RESTORE_LAST_VIEW_KEY)).toBe("false");
    expect(getRestoreLastViewEnabled()).toBe(false);

    setRestoreLastViewEnabled(true);
    expect(localStorage.getItem(RESTORE_LAST_VIEW_KEY)).toBe("true");
    expect(getRestoreLastViewEnabled()).toBe(true);
  });

  it("treats '0' as off too", () => {
    localStorage.setItem(RESTORE_LAST_VIEW_KEY, "0");
    expect(getRestoreLastViewEnabled()).toBe(false);
  });

  it("treats an unrecognized / corrupt value as on (fail-safe default)", () => {
    localStorage.setItem(RESTORE_LAST_VIEW_KEY, "garbage");
    expect(getRestoreLastViewEnabled()).toBe(true);
  });

  it("degrades to the default-on when reading throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getRestoreLastViewEnabled()).toBe(true);
  });

  it("never throws when writing fails (quota / private browsing)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => setRestoreLastViewEnabled(false)).not.toThrow();
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
    // The remembered view is applied as last-view, not as default — recording
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
