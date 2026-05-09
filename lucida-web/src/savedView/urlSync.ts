// URL ↔ scene synchronization. Deep module.
//
// Two flows:
//
//   - **Outbound** (scene → URL): on every viewport-change tick, debounce
//     250-500 ms, encode the current SavedView, write `#view=…` via
//     `history.replaceState`. Suppressed while applier is in progress so
//     we don't fight ourselves during a recipient apply.
//
//   - **Inbound** (URL → scene): on initial load, parse `window.location.hash`;
//     on `popstate`, re-parse and re-apply. Both routed through the
//     SavedViewApplier so the same step-ordered logic runs in both cases.
//     Two recognized payload shapes:
//       * `#view=<inline base64+gzip>` — slice 1
//       * `#b=<bookmark-id>` — slice 3, fetched via `/api/bookmarks/:id`
//         then handed to the applier; the URL is then collapsed to its
//         live `#view=…` form so further pans don't drift the recipient
//         back to a stale snapshot.
//
// The debounce timing is configurable via the constructor for tests
// (PRD acceptance criterion §"debounce timing configurable for tests").

import { encode, decode } from "./encoder.ts";
import type { SavedView } from "./types.ts";
import { SavedViewApplier } from "./applier.ts";
import { getBookmark, type Bookmark } from "./bookmarksApi.ts";

export interface UrlSyncOptions {
  /** ms of idle to wait before writing the URL. Default 350 (mid-range
   * of PRD's 250-500 ms target). */
  debounceMs?: number;
  /** Override `window` for testing. */
  window?: Window;
  /** Resolve `#b=<id>` to a bookmark. Defaults to the production REST
   *  helper; tests inject a stub so they don't need a fetch mock. */
  fetchBookmark?: (id: string) => Promise<Bookmark | null>;
}

export type CaptureBuilder = () => SavedView | null;

export type FetchBookmark = (id: string) => Promise<Bookmark | null>;

/** Default `#b=<id>` resolver — the slice-2 REST helper.
 *  Tests inject their own to avoid the production fetch path. */
const defaultFetchBookmark: FetchBookmark = (id) => getBookmark(id);

export class UrlSync {
  private debounceMs: number;
  private win: Window;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private popstateHandler: ((e: PopStateEvent) => void) | null = null;
  /** Last URL we wrote — used to skip no-op writes and to suppress our
   * own popstate echoes. */
  private lastWritten: string | null = null;

  private readonly captureBuilder: CaptureBuilder;
  private readonly applier: SavedViewApplier;
  private readonly fetchBookmark: FetchBookmark;

  constructor(
    captureBuilder: CaptureBuilder,
    applier: SavedViewApplier,
    options: UrlSyncOptions = {},
  ) {
    this.captureBuilder = captureBuilder;
    this.applier = applier;
    this.debounceMs = options.debounceMs ?? 350;
    this.win = options.window ?? window;
    this.fetchBookmark = options.fetchBookmark ?? defaultFetchBookmark;
  }

  /** Hook the popstate listener. Must be called once after construction. */
  start(): void {
    this.popstateHandler = () => {
      // popstate fires for back/forward navigation. Re-apply whatever's
      // in the URL. If applier is busy, skip to avoid race.
      if (this.applier.isInProgress()) return;
      this.bootstrap().catch((e) => {
        console.warn("[UrlSync] popstate apply failed:", e);
      });
    };
    this.win.addEventListener("popstate", this.popstateHandler);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.popstateHandler) {
      this.win.removeEventListener("popstate", this.popstateHandler);
      this.popstateHandler = null;
    }
  }

  /**
   * Read `window.location.hash`, parse `#view=…` or `#b=<id>` if present,
   * and apply. Resolves once the apply has run (or rejects on parse
   * error). Safe to call multiple times — guarded by the applier's own
   * "in progress" check so we never re-enter mid-apply.
   *
   * For `#b=<id>`: fetches the bookmark via the slice-2 REST endpoint,
   * applies its `view`, then `replaceState`s the URL to the inline
   * `#view=…` form so further pans don't drift the recipient back to
   * a stale snapshot every time the URL is re-applied (PRD §"URL
   * semantics across all states", row "Open someone's #b=<id> link").
   */
  async bootstrap(): Promise<void> {
    if (this.applier.isInProgress()) return;

    const bookmarkId = parseBookmarkHash(this.win.location.hash);
    if (bookmarkId !== null) {
      let bookmark: Bookmark | null;
      try {
        bookmark = await this.fetchBookmark(bookmarkId);
      } catch (e) {
        console.warn("[UrlSync] failed to fetch bookmark:", e);
        return;
      }
      if (bookmark === null) {
        console.warn(`[UrlSync] bookmark ${bookmarkId} not found`);
        return;
      }
      await this.applier.apply(bookmark.view);
      // Collapse `#b=<id>` to the live `#view=…` form so the URL reflects
      // the current scene, not the bookmark's frozen snapshot. Skip if
      // the apply was a no-op (no scene yet); the next bootstrap will
      // rewrite when the scene is ready.
      await this.flushAfterBookmarkApply();
      return;
    }

    const payload = parseViewHash(this.win.location.hash);
    if (payload === null) return;
    let view: SavedView;
    try {
      view = await decode(payload);
    } catch (e) {
      console.warn("[UrlSync] invalid #view= payload:", e);
      return;
    }
    await this.applier.apply(view);
  }

  /** Encode and write `#view=…` immediately after a bookmark apply.
   *  Bypasses the in-progress guard because `apply` has already returned;
   *  the dedupe-against-lastWritten branch keeps this from looping. */
  private async flushAfterBookmarkApply(): Promise<void> {
    if (this.destroyed) return;
    const view = this.captureBuilder();
    if (view === null) return;
    let payload: string;
    try {
      payload = await encode(view);
    } catch (e) {
      console.warn("[UrlSync] post-bookmark encode failed:", e);
      return;
    }
    const newHash = `#view=${payload}`;
    const url = `${this.win.location.pathname}${this.win.location.search}${newHash}`;
    if (url === this.lastWritten) return;
    this.lastWritten = url;
    this.win.history.replaceState(this.win.history.state, "", url);
  }

  /**
   * Notify the sync that the scene has changed. Schedules a debounced
   * URL update. If `applyInProgress` is true at fire time, the write
   * is skipped (the URL already reflects the apply target).
   */
  notifyChange(): void {
    if (this.destroyed) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  /** Force-write immediately, bypassing the debounce. Used by tests
   * and on user-explicit save events (none in slice 1). */
  async flush(): Promise<void> {
    if (this.destroyed) return;
    if (this.applier.isInProgress()) return;
    const view = this.captureBuilder();
    if (view === null) return;
    let payload: string;
    try {
      payload = await encode(view);
    } catch (e) {
      console.warn("[UrlSync] encode failed:", e);
      return;
    }
    const newHash = `#view=${payload}`;
    const url = `${this.win.location.pathname}${this.win.location.search}${newHash}`;
    if (url === this.lastWritten) return;
    this.lastWritten = url;
    this.win.history.replaceState(this.win.history.state, "", url);
  }
}

/** Parse a `#view=…` URL hash and return the encoded payload, or null
 * if the hash is empty or doesn't start with `#view=`. Exported for
 * test reuse. */
export function parseViewHash(hash: string): string | null {
  if (!hash || hash === "#") return null;
  const stripped = hash.startsWith("#") ? hash.slice(1) : hash;
  // Allow the `#view=…` to coexist with other params using `&`.
  for (const part of stripped.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    if (key === "view") return part.slice(eq + 1);
  }
  return null;
}

/** Parse a `#b=<id>` URL hash and return the bookmark id, or null when
 *  the hash isn't of that shape. Validates the id matches a conservative
 *  character class (`[A-Za-z0-9._-]+`) — UUID-v4s qualify, and rejecting
 *  anything else keeps the resolver from issuing wild GETs against the
 *  bookmarks API for `#b=<%-encoded-junk>`. */
export function parseBookmarkHash(hash: string): string | null {
  if (!hash || hash === "#") return null;
  const stripped = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const part of stripped.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    if (key !== "b") continue;
    const raw = decodeURIComponent(part.slice(eq + 1));
    if (!/^[A-Za-z0-9._-]+$/.test(raw)) return null;
    return raw;
  }
  return null;
}
