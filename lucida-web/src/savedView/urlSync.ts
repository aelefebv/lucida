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
//       * `#view=<inline base64+gzip>` — inline payload
//       * `#b=<saved-view-id>` — fetched via the configured resolver then
//         handed to the applier; the URL is then collapsed to its live
//         `#view=…` form so further pans don't drift the recipient
//         back to a stale snapshot.
//
// The debounce timing is configurable via the constructor for tests.

import { encode, decode } from "./encoder.ts";
import type { SavedView } from "./types.ts";
import { SavedViewApplier } from "./applier.ts";
import { getBookmark } from "./bookmarksApi.ts";

export interface ResolvedSavedView {
  id: string;
  view: SavedView;
}

export interface UrlSyncOptions {
  /** ms of idle to wait before writing the URL. Default 350 (mid-range
   * of the 250-500 ms target). */
  debounceMs?: number;
  /** Override `window` for testing. */
  window?: Window;
  /** Resolve `#b=<id>` to a saved view. Defaults to the production REST
   *  helper; tests inject a stub so they don't need a fetch mock. */
  fetchBookmark?: (id: string) => Promise<ResolvedSavedView | null>;
  fetchSavedViewById?: (id: string) => Promise<ResolvedSavedView | null>;
  /** Resolve the workspace default saved view for bare workspace URLs. */
  fetchDefaultSavedView?: () => Promise<ResolvedSavedView | null>;
  /** Resolve `?viewer_profile=<name>` to a private viewer profile. */
  fetchViewerProfile?: (profile: string) => Promise<ResolvedSavedView | null>;
}

export type CaptureBuilder = () => SavedView | null;

export type FetchSavedViewById = (id: string) => Promise<ResolvedSavedView | null>;
export type FetchDefaultSavedView = () => Promise<ResolvedSavedView | null>;
export type FetchViewerProfile = (profile: string) => Promise<ResolvedSavedView | null>;

/** Default `#b=<id>` resolver — the REST helper. Tests inject their
 *  own to avoid the production fetch path. */
const defaultFetchSavedViewById: FetchSavedViewById = (id) => getBookmark(id);

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
  private readonly fetchSavedViewById: FetchSavedViewById;
  private readonly fetchDefaultSavedView: FetchDefaultSavedView | null;
  private readonly fetchViewerProfile: FetchViewerProfile | null;
  private suppressNextEmptyHashFlush = false;

  constructor(
    captureBuilder: CaptureBuilder,
    applier: SavedViewApplier,
    options: UrlSyncOptions = {},
  ) {
    this.captureBuilder = captureBuilder;
    this.applier = applier;
    this.debounceMs = options.debounceMs ?? 350;
    this.win = options.window ?? window;
    this.fetchSavedViewById =
      options.fetchSavedViewById ?? options.fetchBookmark ?? defaultFetchSavedViewById;
    this.fetchDefaultSavedView = options.fetchDefaultSavedView ?? null;
    this.fetchViewerProfile = options.fetchViewerProfile ?? null;
  }

  /** Hook the popstate listener. Idempotent + re-armable after `destroy()`
   *  so React 18 Strict-Mode's mount→unmount→mount effect cycle (which
   *  double-invokes the cleanup before the second mount) doesn't leave the
   *  sync permanently destroyed. */
  start(): void {
    this.destroyed = false;
    if (this.popstateHandler !== null) return;
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
   * For `#b=<id>`: fetches the saved view via the configured resolver,
   * applies its `view`, then `replaceState`s the URL to the inline `#view=…`
   * form so further pans don't drift the recipient back to a stale
   * snapshot every time the URL is re-applied.
   */
  async bootstrap(): Promise<void> {
    if (this.applier.isInProgress()) return;

    const hash = this.win.location.hash;
    const bookmarkId = parseBookmarkHash(hash);
    if (bookmarkId !== null) {
      let savedView: ResolvedSavedView | null;
      try {
        savedView = await this.fetchSavedViewById(bookmarkId);
      } catch (e) {
        console.warn("[UrlSync] failed to fetch saved view:", e);
        return;
      }
      if (savedView === null) {
        console.warn(`[UrlSync] saved view ${bookmarkId} not found`);
        return;
      }
      await this.applier.apply(savedView.view);
      // Collapse `#b=<id>` to the live `#view=…` form so the URL reflects
      // the current scene, not the saved view's frozen snapshot. Skip if
      // the apply was a no-op (no scene yet); the next bootstrap will
      // rewrite when the scene is ready.
      await this.flushAfterSavedViewApply();
      return;
    }

    const payload = parseViewHash(hash);
    if (payload === null) {
      const viewerProfile = parseViewerProfileSearch(this.win.location.search);
      if (viewerProfile !== null && this.fetchViewerProfile) {
        await this.applyViewerProfile(viewerProfile);
        return;
      }
      if (isEmptyHash(hash) && this.fetchDefaultSavedView) {
        await this.applyDefaultSavedView();
      }
      return;
    }
    let view: SavedView;
    try {
      view = await decode(payload);
    } catch (e) {
      console.warn("[UrlSync] invalid #view= payload:", e);
      return;
    }
    await this.applier.apply(view);
  }

  private async applyViewerProfile(profile: string): Promise<void> {
    let savedView: ResolvedSavedView | null;
    try {
      savedView = await this.fetchViewerProfile?.(profile) ?? null;
    } catch (e) {
      console.warn("[UrlSync] failed to fetch viewer profile:", e);
      return;
    }
    if (savedView === null) return;
    this.suppressNextEmptyHashFlush = true;
    await this.applier.apply(savedView.view);
  }

  private async applyDefaultSavedView(): Promise<void> {
    let savedView: ResolvedSavedView | null;
    try {
      savedView = await this.fetchDefaultSavedView?.() ?? null;
    } catch (e) {
      console.warn("[UrlSync] failed to fetch default saved view:", e);
      return;
    }
    if (savedView === null) return;
    this.suppressNextEmptyHashFlush = true;
    await this.applier.apply(savedView.view);
  }

  /** Encode and write `#view=…` immediately after a saved-view apply.
   *  Bypasses the in-progress guard because `apply` has already returned;
   *  the dedupe-against-lastWritten branch keeps this from looping. */
  private async flushAfterSavedViewApply(): Promise<void> {
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
   * and on user-explicit save events. */
  async flush(): Promise<void> {
    if (this.destroyed) return;
    if (this.applier.isInProgress()) return;
    if (this.suppressNextEmptyHashFlush && isEmptyHash(this.win.location.hash)) {
      this.suppressNextEmptyHashFlush = false;
      return;
    }
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

function isEmptyHash(hash: string): boolean {
  return !hash || hash === "#";
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

export function parseViewerProfileSearch(search: string): string | null {
  if (!search || search === "?") return null;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const raw = params.get("viewer_profile");
  if (!raw || !/^[A-Za-z0-9._-]+$/.test(raw)) return null;
  return raw;
}
