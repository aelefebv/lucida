// URL and scene synchronization.
//
// Outbound: a debounced `history.replaceState` writes the current view as
// `#view=…`, suppressed while the applier runs so we don't fight a recipient
// apply. Inbound: initial load and `popstate` route `#view=` and `#b=` through
// the applier, then collapse `#b=` to the live `#view=` form so later pans don't
// snap back to a stale snapshot. `#a=` annotation links are only recognized
// here; the host resolves them after the workspace document loads, because the
// pin doesn't exist at scene bootstrap.

import { encode, decode } from "./encoder.ts";
import type { SavedView } from "./types.ts";
import { SavedViewApplier } from "./applier.ts";
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
  /** Resolve `#b=<id>` to a saved view. Without one, a `#b=` link applies
   *  nothing. */
  fetchSavedViewById?: (id: string) => Promise<ResolvedSavedView | null>;
  /** A `#b=<id>` link named a saved view that couldn't be fetched, so the
   *  host can say so rather than leave the recipient on an unexplained
   *  view. */
  onSavedViewMissing?: (id: string) => void;
  /** Resolve the workspace default saved view for bare workspace URLs. */
  fetchDefaultSavedView?: () => Promise<ResolvedSavedView | null>;
  /** Resolve `?viewer_profile=<name>` to a private viewer profile. */
  fetchViewerProfile?: (profile: string) => Promise<ResolvedSavedView | null>;
  /** Resolve the caller's own remembered last view for a bare workspace URL.
   *  Returns null when there is none (or the user isn't a member). */
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

export class UrlSync {
  private debounceMs: number;
  private win: Window;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private popstateHandler: ((e: PopStateEvent) => void) | null = null;
  /** Last URL we wrote, to skip no-op writes and to suppress our
   * own popstate echoes. */
  private lastWritten: string | null = null;

  private readonly captureBuilder: CaptureBuilder;
  private readonly applier: SavedViewApplier;
  private readonly fetchSavedViewById: FetchSavedViewById | null;
  private readonly onSavedViewMissing: ((id: string) => void) | null;
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
    this.fetchSavedViewById = options.fetchSavedViewById ?? null;
    this.onSavedViewMissing = options.onSavedViewMissing ?? null;
    this.fetchDefaultSavedView = options.fetchDefaultSavedView ?? null;
    this.fetchViewerProfile = options.fetchViewerProfile ?? null;
    this.fetchLastView = options.fetchLastView ?? null;
    this.restoreLastViewEnabled =
      options.restoreLastViewEnabled ?? getRestoreLastViewEnabled;
  }

  /** Hook the popstate listener. Idempotent and re-armable after `destroy()`,
   *  so Strict Mode's mount, unmount, mount cycle doesn't leave the sync
   *  permanently destroyed. */
  start(): void {
    this.destroyed = false;
    if (this.popstateHandler !== null) return;
    this.popstateHandler = () => {
      // Back/forward: re-apply the URL, unless an apply is already running.
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
   * Apply whatever the URL names. Safe to call repeatedly: the applier's
   * in-progress check keeps it from re-entering mid-apply.
   */
  async bootstrap(): Promise<void> {
    if (this.applier.isInProgress()) return;

    const hash = this.win.location.hash;

    // The host resolves `#a=` once annotations load. Recognize it here only so
    // we don't apply the default or last view over the link's target.
    if (parseAnnotationHash(hash) !== null) return;

    const savedViewId = parseSavedViewHash(hash);
    if (savedViewId !== null) {
      let savedView: ResolvedSavedView | null = null;
      try {
        savedView = (await this.fetchSavedViewById?.(savedViewId)) ?? null;
      } catch (e) {
        console.warn("[UrlSync] failed to fetch saved view:", e);
      }
      if (savedView === null) {
        console.warn(`[UrlSync] saved view ${savedViewId} not found`);
        this.onSavedViewMissing?.(savedViewId);
        // Land where a bare workspace open would, not on an unframed scene.
        await this.applyInitialViewForEmptyHash();
        return;
      }
      await this.applier.apply(savedView.view);
      // Collapse to the live `#view=` form so the URL tracks the scene, not
      // the saved snapshot.
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
   * Bare workspace open: {@link resolveInitialViewSource} picks the user's
   * last view or the workspace default. The last view is fetched only when the
   * toggle is on and a fetcher is wired, so auth-off and non-member callers
   * never send the request. This never writes the workspace default.
   */
  private async applyInitialViewForEmptyHash(): Promise<void> {
    const restoreEnabled = this.restoreLastViewEnabled();

    // Fetch first so `hasLastView` is truthful. A fetch error falls through
    // to the default.
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
      // Any hash was handled above.
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
   * Collapse a resolved `#a=` hash to the live `#view=` form, as `#b=` does
   * after its apply. Leaving the annotation id in the URL would re-run the
   * restore on every popstate and snap the recipient back after they pan.
   * A no-op when there's no capturable scene yet. */
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
      console.warn("[UrlSync] post-apply encode failed:", e);
      return;
    }
    const newHash = `#view=${payload}`;
    const url = `${this.win.location.pathname}${this.win.location.search}${newHash}`;
    if (url === this.lastWritten) return;
    this.lastWritten = url;
    this.win.history.replaceState(this.win.history.state, "", url);
  }

  /**
   * Schedule a debounced URL write. Skipped if an apply is running at fire
   * time, since the URL already names the apply target.
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

/** The encoded `#view=` payload, or null if the hash has none. */
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

/** The `#b=<id>` saved-view id, or null. The conservative character class
 *  (`[A-Za-z0-9._-]+`) admits UUIDs and keeps `#b=<%-encoded-junk>` from
 *  sending wild GETs to the saved-views API. */
export function parseSavedViewHash(hash: string): string | null {
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

/** The `#a=<annotation-id>` id, or null. Uses {@link parseSavedViewHash}'s
 *  character class so a junk link never drives a lookup against an
 *  attacker-chosen string. */
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
      // Malformed percent-encoding: reject rather than throw.
      return null;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(raw)) return null;
    return raw;
  }
  return null;
}

/**
 * The current workspace URL with the hash replaced by `#a=<annotationId>`.
 *
 * A deep link, not an access grant: it carries no token. The recipient still
 * passes the workspace gate, and a recipient without access sees the same
 * not-found UX as a missing annotation, so the link never confirms the
 * annotation exists. `loc` is injectable for tests.
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
