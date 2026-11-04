/**
 * Stable, browser-persisted author identity for annotations and comments.
 *
 * Author-only actions are gated in the UI by comparing an item's `author` to
 * this id. It is persisted in `localStorage` so ownership survives a rejoin;
 * the per-connection `bridge.myId` changes on every connect and stays the
 * presence, cursor, and follow identity. The server does no author check, so
 * this gate is UI-only.
 */

/** localStorage key for the author id. Persisted, so it must stay stable
 * across releases. */
export const ANNOTATION_AUTHOR_KEY = "lucida.annotation.author";

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
 * Reuses a stored id verbatim, else mints and persists one. Broken storage
 * degrades to an in-memory id rather than throwing.
 */
export function annotationAuthorId(): string {
  if (cachedAuthorId !== null) return cachedAuthorId;

  // The rejoin path.
  const existing = readStoredAuthorId();
  if (existing) {
    cachedAuthorId = existing;
    return existing;
  }

  const fresh = generateAuthorId();
  writeStoredAuthorId(fresh);
  cachedAuthorId = fresh;
  return fresh;
}

/** Read the persisted id, or null when absent/empty/unavailable. Never throws. */
function readStoredAuthorId(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(ANNOTATION_AUTHOR_KEY);
    // An empty string counts as absent, since an empty author matches nothing.
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Persist the id. Failures are swallowed; `cachedAuthorId` keeps the session
 * consistent. */
function writeStoredAuthorId(id: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(ANNOTATION_AUTHOR_KEY, id);
  } catch {
    // Best effort.
  }
}

/**
 * Test-only: drop the in-memory cache so the next call re-reads storage. Does
 * not touch storage itself.
 */
export function __resetAnnotationIdentityForTesting(): void {
  cachedAuthorId = null;
}
