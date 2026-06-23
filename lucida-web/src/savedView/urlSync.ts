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
//     Three recognized payload shapes:
//       * `#view=<inline base64+gzip>` — inline payload
//       * `#b=<saved-view-id>` — fetched via the configured resolver then
//         handed to the applier; the URL is then collapsed to its live
//         `#view=…` form so further pans don't drift the recipient
//         back to a stale snapshot.
//       * `#a=<annotation-id>` — a workspace-scoped annotation DEEP-LINK
//         (annotation-views slice 3). UrlSync only RECOGNIZES it here so it
//         never mistakes it for a bare workspace open (and so doesn't apply the
//         default/last view over it). The actual resolve+restore+focus is the
//         host's job (App.tsx) and is deliberately deferred until AFTER the
//         workspace document — and thus its annotations — has loaded: an
//         annotation exists only after the doc snapshot lands, so resolving at
//         scene-bootstrap time would focus an unloaded pin (the #802 class).
//         Like `#b=`, the host collapses the hash to the live `#view=…` form
//         after applying via {@link UrlSync.collapseToLiveView}.
//
// The debounce timing is configurable via the constructor for tests.

import { encode, decode } from "./encoder.ts";
import type { SavedView } from "./types.ts";
import { SavedViewApplier } from "./applier.ts";
import { getBookmark } from "./bookmarksApi.ts";
import {
  getRestoreLastViewEnabled,
  resolveInitialViewSource,
} from "../lastViewPreference.ts";

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
  /** Resolve the caller's own remembered last view for a bare workspace URL
   *  (#700). Returns null when there is none (or the user isn't a member). */
  fetchLastView?: () => Promise<ResolvedSavedView | null>;
  /** Whether the per-user "restore my last view" toggle is on. Defaults to
   *  the localStorage-backed preference; injectable for tests. */
  restoreLastViewEnabled?: () => boolean;
}

export type CaptureBuilder = () => SavedView | null;

export type FetchSavedViewById = (id: string) => Promise<ResolvedSavedView | null>;
export type FetchDefaultSavedView = () => Promise<ResolvedSavedView | null>;
export type FetchViewerProfile = (profile: string) => Promise<ResolvedSavedView | null>;
export type FetchLastView = () => Promise<ResolvedSavedView | null>;

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
  private readonly fetchLastView: FetchLastView | null;
  private readonly restoreLastViewEnabled: () => boolean;
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
    this.fetchLastView = options.fetchLastView ?? null;
    this.restoreLastViewEnabled =
      options.restoreLastViewEnabled ?? getRestoreLastViewEnabled;
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

    // `#a=<annotation-id>` is a workspace-scoped annotation deep-link
    // (annotation-views slice 3). It is resolved by the HOST (App.tsx) AFTER
    // the workspace document's annotations have loaded — not here — because the
    // pin doesn't exist at scene-bootstrap time. We only RECOGNIZE it so the
    // bootstrap doesn't fall through to `applyInitialViewForEmptyHash` and apply
    // the default/last view over the link's target. No fetch, no apply here.
    if (parseAnnotationHash(hash) !== null) return;

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
      if (isEmptyHash(hash)) {
        await this.applyInitialViewForEmptyHash();
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

  /**
   * Bare workspace open (no `#view=`/`#b=` hash, no `?viewer_profile=`):
   * choose what to apply via the pure {@link resolveInitialViewSource}
   * priority — the per-user remembered last view (#700) slots BETWEEN the
   * URL-hash branch (handled above; a hash always wins) and the shared
   * workspace default.
   *
   * We fetch the user's last view ONLY when the toggle is on and a fetcher is
   * wired (so auth-off / non-member callers — which pass no `fetchLastView` —
   * never issue the request); a fetch failure degrades silently to the
   * default. We NEVER write the workspace default here.
   */
  private async applyInitialViewForEmptyHash(): Promise<void> {
    const restoreEnabled = this.restoreLastViewEnabled();

    // Resolve the remembered last view first (only when eligible), so the
    // priority function has a truthful `hasLastView`. A fetch error is
    // swallowed — the verdict simply falls through to the default.
    let lastView: ResolvedSavedView | null = null;
    if (restoreEnabled && this.fetchLastView) {
      try {
        lastView = await this.fetchLastView();
      } catch (e) {
        console.warn("[UrlSync] failed to fetch last view:", e);
        lastView = null;
      }
    }

    const source = resolveInitialViewSource({
      // A hash would have been handled by the branches above; at this point
      // the workspace URL is bare.
      hasUrlHash: false,
      restoreEnabled,
      hasLastView: lastView !== null,
      hasDefault: this.fetchDefaultSavedView !== null,
    });

    if (source === "last-view" && lastView !== null) {
      this.suppressNextEmptyHashFlush = true;
      await this.applier.apply(lastView.view);
      return;
    }
    if (source === "default") {
      await this.applyDefaultSavedView();
    }
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

  /**
   * Collapse a resolved `#a=<annotation-id>` (or `#b=`) hash to the live
   * `#view=…` form — the SAME tail `#b=` runs after its apply, exposed
   * publicly so the host (App.tsx) can call it after the slice-2 LIGHT restore
   * of an annotation deep-link. Keeping the URL on the annotation id would
   * re-trigger the restore on every popstate / re-bootstrap and drift the
   * recipient back to the author's frozen snapshot after they pan; collapsing
   * to the live `#view=` makes the URL track the recipient's own scene from
   * here on. A no-op when there's no capturable scene yet (the link's restore
   * already positioned the live view; the next change tick will write it). */
  async collapseToLiveView(): Promise<void> {
    await this.flushAfterSavedViewApply();
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

/** Parse a `#a=<annotation-id>` URL hash and return the annotation id, or null
 *  when the hash isn't of that shape (annotation-views slice 3). Mirrors
 *  {@link parseBookmarkHash}'s conservative character class
 *  (`[A-Za-z0-9._-]+`) — annotation ids are client-minted UUID-v4s, which
 *  qualify — so a `#a=<%-encoded-junk>` link never drives a lookup against an
 *  attacker-chosen string. The link is the workspace URL + this hash; the
 *  workspace path itself still governs access (see the never-leak note in
 *  {@link buildAnnotationLink}). */
export function parseAnnotationHash(hash: string): string | null {
  if (!hash || hash === "#") return null;
  const stripped = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const part of stripped.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    if (key !== "a") continue;
    let raw: string;
    try {
      raw = decodeURIComponent(part.slice(eq + 1));
    } catch {
      // Malformed percent-encoding — reject rather than throw.
      return null;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(raw)) return null;
    return raw;
  }
  return null;
}

/**
 * Build a shareable annotation deep-link: the CURRENT workspace URL (origin +
 * pathname + search) with the hash replaced by `#a=<annotationId>`
 * (annotation-views slice 3).
 *
 * This is a deep-link, NOT an access grant: it carries no capability token and
 * widens nothing. The recipient still loads the workspace through the existing
 * gate (membership or the workspace's anyone-with-link), and annotation access
 * == workspace access because the annotation lives in the workspace document. A
 * recipient without access sees the SAME not-found UX as a missing annotation —
 * the link never confirms the annotation (or workspace) exists.
 *
 * `loc` defaults to `window.location`; injectable for tests. The annotation id
 * is `encodeURIComponent`-escaped for safety even though minted ids are already
 * URL-safe. The existing path+search are preserved so a workspace route like
 * `/w/ws-1` stays intact.
 */
export function buildAnnotationLink(
  annotationId: string,
  loc: { origin: string; pathname: string; search: string } = window.location,
): string {
  return `${loc.origin}${loc.pathname}${loc.search}#a=${encodeURIComponent(annotationId)}`;
}

export function parseViewerProfileSearch(search: string): string | null {
  if (!search || search === "?") return null;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const raw = params.get("viewer_profile");
  if (!raw || !/^[A-Za-z0-9._-]+$/.test(raw)) return null;
  return raw;
}
