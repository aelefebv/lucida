/**
 * Stable, browser-persisted author identity for annotations and comments.
 *
 * Why this exists (issue #777): annotation/comment author-only actions
 * (move/delete a pin, edit/remove your own comment) are gated in the UI by
 * comparing the item's `author` against "my" identity. That identity used to be
 * the per-connection client id (`bridge.myId`, a `ClientId` the server assigns
 * on every WS connect), so leaving and rejoining a workspace handed you a *new*
 * id — and your own previous pins/comments stopped being recognized as yours.
 *
 * The fix is to source the *annotation author* from an id that outlives a single
 * connection: one generated once and persisted in `localStorage`, so a returning
 * browser keeps ownership across rejoin (and tab close/reopen). The per-connection
 * `bridge.myId` stays the presence/cursor/follow identity — only authorship moves
 * here. This is frontend-only: author-only is UI-enforced; the server applies
 * commands without an author check, so no wire/Rust change is involved.
 *
 * Two different browsers (different `localStorage`) get different persisted ids,
 * so one user's pins stay not-yours to everyone else — exactly as before, but now
 * stable for the author across reconnects.
 */

/** The localStorage key under which the persisted author identity lives. The
 * exact string is part of the contract: a returning browser reuses whatever is
 * stored here, so this key must stay stable across releases. */
export const ANNOTATION_AUTHOR_KEY = "lucida.annotation.author";

/**
 * Once resolved (read from storage or freshly generated) we keep the id in
 * memory for the lifetime of the page. This makes `annotationAuthorId()` stable
 * across calls within a session even if `localStorage` is unavailable or its
 * writes throw (private-browsing / quota), where re-reading would otherwise
 * regenerate a different id every call and silently break ownership mid-session.
 * A persisted value still wins on the next visit; this only protects the
 * in-session invariant the callers rely on.
 */
let cachedAuthorId: string | null = null;

/** Generate a fresh identity. Prefers `crypto.randomUUID()`; falls back to a
 * timestamp+random string where it's unavailable (older/locked-down runtimes),
 * mirroring the id-minting fallback already used elsewhere in the app
 * (`bridge.ts`, `ThreadPopover.tsx`) so identity generation never throws. */
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
 * Returns this browser's stable annotation-author identity.
 *
 * Contract:
 *  - returns a **non-empty** string, **stable** across calls within a session;
 *  - if `localStorage["lucida.annotation.author"]` already holds a (non-empty)
 *    value, returns it **verbatim** — a returning browser keeps its id and so
 *    keeps ownership of what it created;
 *  - otherwise generates one, persists it under that key, and returns it, so the
 *    next visit reuses it.
 *
 * Fail-safe: every storage access is guarded so a missing/throwing
 * `localStorage` (SSR, private browsing, quota) degrades to an in-memory id that
 * is still stable for the session rather than crashing the overlays.
 */
export function annotationAuthorId(): string {
  // Stable within the session regardless of storage health.
  if (cachedAuthorId !== null) return cachedAuthorId;

  // Reuse a previously persisted id verbatim — this is the rejoin path.
  const existing = readStoredAuthorId();
  if (existing) {
    cachedAuthorId = existing;
    return existing;
  }

  // First visit (or unreadable storage): mint one, persist it, and remember it.
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
    // Treat an empty string as "absent" so we mint+persist a usable id rather
    // than handing callers an empty author that matches nothing.
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Persist the id. Swallows failures (quota / private browsing): an in-memory
 * id that doesn't survive a reload still beats throwing out of the overlays. */
function writeStoredAuthorId(id: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(ANNOTATION_AUTHOR_KEY, id);
  } catch {
    // ignore — `cachedAuthorId` keeps the session consistent regardless.
  }
}

/**
 * Test-only escape hatch: drop the in-memory cache so the next
 * `annotationAuthorId()` re-resolves from `localStorage`. Production code never
 * calls this — in a real page the cache is exactly the desired session
 * stability. Mirrors `configStore.__resetForTesting`. Does NOT touch storage;
 * a test that wants a clean slate clears the key itself.
 */
export function __resetAnnotationIdentityForTesting(): void {
  cachedAuthorId = null;
}
