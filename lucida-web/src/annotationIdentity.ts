/**
 * Stable, browser-persisted author identity for annotations and comments.
 *
 * Author-only actions are gated in the UI by comparing an item's `author` to
 * this id. It is a preference, so ownership survives a rejoin, and the capture
 * surface neither reads nor persists one; the per-connection `bridge.myId` changes
 * on every connect and stays the presence, cursor, and follow identity. The
 * server does no author check, so this gate is UI-only.
 */

import {
  definePreference,
  getPreference,
  migrateLegacyKeys,
  setPreference,
} from "./theme/preferences.ts";

/** Empty until this browser mints one; an empty author matches nothing. */
export const annotationAuthorPreference = definePreference<string>("annotation.author", "", (raw) =>
  typeof raw === "string" ? raw : undefined,
);

migrateLegacyKeys(
  (key) => key === "lucida.annotation.author",
  (old) => {
    for (const raw of old.values()) if (raw.length > 0) setPreference(annotationAuthorPreference, raw);
  },
);

/**
 * Held for the page's lifetime so the id stays stable within a session even
 * when storage writes fail; re-reading would otherwise mint a new id per call
 * and break ownership mid-session.
 */
let cachedAuthorId: string | null = null;

/** A fresh identity: `crypto.randomUUID()` where available, else a
 * timestamp-plus-random string, so generation never throws. */
function generateAuthorId(): string {
  try {
    if (globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // Some environments expose `crypto` but throw on `randomUUID` (e.g. an
    // insecure context). Fall through to the non-crypto path rather than throw.
  }
  return `author-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * This browser's annotation-author id: non-empty and stable within a session.
 * Reuses the stored id, else mints and stores one. Broken storage degrades to
 * an in-memory id rather than throwing.
 */
export function annotationAuthorId(): string {
  if (cachedAuthorId !== null) return cachedAuthorId;
  const existing = getPreference(annotationAuthorPreference);
  if (existing.length > 0) {
    cachedAuthorId = existing;
    return existing;
  }
  const fresh = generateAuthorId();
  setPreference(annotationAuthorPreference, fresh);
  cachedAuthorId = fresh;
  return fresh;
}

/**
 * Test-only: drop the in-memory cache so the next call re-reads the
 * preference. Does not touch storage itself.
 */
export function __resetAnnotationIdentityForTesting(): void {
  cachedAuthorId = null;
}
