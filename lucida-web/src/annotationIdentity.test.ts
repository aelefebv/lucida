// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  annotationAuthorId,
  annotationAuthorPreference,
  __resetAnnotationIdentityForTesting,
} from "./annotationIdentity.ts";
import {
  PREFERENCES_STORAGE_KEY,
  __resetPreferencesForTesting,
  getPreference,
  setPreference,
} from "./theme/preferences.ts";

const LEGACY_KEY = "lucida.annotation.author";

/** A new page load in the same browser: storage stays, memory goes. */
function reload(): void {
  __resetPreferencesForTesting();
  __resetAnnotationIdentityForTesting();
}

// Each test starts from a clean slate: no persisted id and no in-memory cache,
// so a call exercises the real read-or-generate path rather than a leftover.
beforeEach(() => {
  localStorage.clear();
  reload();
});

afterEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  reload();
  vi.restoreAllMocks();
});

describe("annotationAuthorId", () => {
  it("returns a non-empty string, equal across two calls", () => {
    const a = annotationAuthorId();
    const b = annotationAuthorId();
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
    expect(a).toBe(b);
  });

  it("rejoin: returns the id already stored, unchanged", () => {
    const persisted = "existing-author-id-1234";
    setPreference(annotationAuthorPreference, persisted);
    reload();

    // Returned verbatim, so ownership of prior pins and comments is preserved.
    expect(annotationAuthorId()).toBe(persisted);
    expect(getPreference(annotationAuthorPreference)).toBe(persisted);
  });

  it("generates AND persists an id when none is stored", () => {
    const id = annotationAuthorId();
    expect(id.length).toBeGreaterThan(0);
    expect(localStorage.getItem(PREFERENCES_STORAGE_KEY)).toContain(id);
    reload();
    expect(annotationAuthorId()).toBe(id);
  });

  it("two browsers (separate storage) get distinct ids", () => {
    const browserA = annotationAuthorId();
    localStorage.clear();
    reload();
    const browserB = annotationAuthorId();
    expect(browserB).not.toBe(browserA);
  });

  it("falls back to a non-crypto id (still stable) when randomUUID is unavailable", () => {
    // Some locked-down/insecure contexts lack crypto.randomUUID. Identity
    // generation must degrade rather than throw, and stay stable in-session.
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      throw new Error("randomUUID unavailable");
    });
    const a = annotationAuthorId();
    expect(a.length).toBeGreaterThan(0);
    expect(annotationAuthorId()).toBe(a);
    expect(getPreference(annotationAuthorPreference)).toBe(a);
  });

  it("stays stable in-session even when storage writes throw (private browsing)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const a = annotationAuthorId();
    expect(a.length).toBeGreaterThan(0);
    expect(annotationAuthorId()).toBe(a);
  });

  it("neither reads nor persists an id on the capture surface", () => {
    setPreference(annotationAuthorPreference, "a-person's-id");
    const before = localStorage.getItem(PREFERENCES_STORAGE_KEY);
    window.history.replaceState({}, "", "/?render=1");
    reload();

    const id = annotationAuthorId();
    expect(id).not.toBe("a-person's-id");
    expect(localStorage.getItem(PREFERENCES_STORAGE_KEY)).toBe(before);
  });
});

describe("the old storage key", () => {
  it("moves a stored id into the preference once and removes the key", () => {
    localStorage.setItem(LEGACY_KEY, "existing-author-id-1234");
    reload();
    expect(annotationAuthorId()).toBe("existing-author-id-1234");
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("treats an empty old value as absent", () => {
    localStorage.setItem(LEGACY_KEY, "");
    reload();
    const id = annotationAuthorId();
    expect(id.length).toBeGreaterThan(0);
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });
});
