// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANNOTATION_AUTHOR_KEY,
  annotationAuthorId,
  __resetAnnotationIdentityForTesting,
} from "./annotationIdentity.ts";

// Each test starts from a clean slate: no persisted id and no in-memory cache,
// so a call exercises the real read-or-generate path rather than a leftover.
beforeEach(() => {
  localStorage.clear();
  __resetAnnotationIdentityForTesting();
});

afterEach(() => {
  localStorage.clear();
  __resetAnnotationIdentityForTesting();
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

  it("rejoin: returns the exact id already held in localStorage, unchanged", () => {
    // Simulate a returning browser: an id is already persisted (e.g. from a
    // prior session) before the module resolves anything this session.
    const persisted = "existing-author-id-1234";
    localStorage.setItem(ANNOTATION_AUTHOR_KEY, persisted);

    const id = annotationAuthorId();

    // Returned verbatim — ownership of prior pins/comments is preserved.
    expect(id).toBe(persisted);
    // And it was NOT regenerated/overwritten in storage.
    expect(localStorage.getItem(ANNOTATION_AUTHOR_KEY)).toBe(persisted);
  });

  it("generates AND persists an id when the key is absent", () => {
    expect(localStorage.getItem(ANNOTATION_AUTHOR_KEY)).toBeNull();

    const id = annotationAuthorId();

    expect(id.length).toBeGreaterThan(0);
    // Persisted under the contract key so the next visit reuses it.
    expect(localStorage.getItem(ANNOTATION_AUTHOR_KEY)).toBe(id);
  });

  it("a fresh resolve after persist reuses the same stored id (next-visit reuse)", () => {
    const first = annotationAuthorId();
    // Drop only the in-memory cache, leaving localStorage intact — this models a
    // brand-new page load (or rejoin) reading what the previous visit stored.
    __resetAnnotationIdentityForTesting();

    const second = annotationAuthorId();
    expect(second).toBe(first);
  });

  it("two browsers (separate storage) get distinct ids", () => {
    // First browser mints + persists its id.
    const browserA = annotationAuthorId();

    // A different browser = different localStorage + a cold module cache.
    localStorage.clear();
    __resetAnnotationIdentityForTesting();

    const browserB = annotationAuthorId();
    expect(browserB).not.toBe(browserA);
    // …and so a pin authored by A (author === browserA) is not-mine to B.
    expect(browserA === browserB).toBe(false);
  });

  it("treats an empty stored value as absent (mints + persists a usable id)", () => {
    localStorage.setItem(ANNOTATION_AUTHOR_KEY, "");

    const id = annotationAuthorId();

    expect(id.length).toBeGreaterThan(0);
    expect(localStorage.getItem(ANNOTATION_AUTHOR_KEY)).toBe(id);
  });

  it("falls back to a non-crypto id (still stable) when randomUUID is unavailable", () => {
    // Some locked-down/insecure contexts lack crypto.randomUUID. Identity
    // generation must degrade rather than throw, and stay stable in-session.
    const spy = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockImplementation(() => {
        throw new Error("randomUUID unavailable");
      });

    const a = annotationAuthorId();
    const b = annotationAuthorId();

    expect(a.length).toBeGreaterThan(0);
    expect(a).toBe(b);
    expect(localStorage.getItem(ANNOTATION_AUTHOR_KEY)).toBe(a);
    spy.mockRestore();
  });

  it("stays stable in-session even when localStorage writes throw (private browsing)", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

    // First call can't persist, but must still return a usable id…
    const a = annotationAuthorId();
    expect(a.length).toBeGreaterThan(0);
    // …and a second call returns the SAME id (memoized), so ownership is
    // consistent for the session despite storage being unwritable.
    const b = annotationAuthorId();
    expect(b).toBe(a);

    setItem.mockRestore();
  });
});
