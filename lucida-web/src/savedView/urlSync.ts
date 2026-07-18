// URL ↔ scene synchronization. Deep module.
//
// Two flows:
//
//   - **Outbound** (scene → URL): on every viewport-change tick, debounce
//     250-500 ms, encode the current SavedView, write `#view=…` via
//     `history.replaceState`. Changes emitted by a saved-view apply are tagged
//     with that apply's epoch and retired by its settlement event.
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
  /** Resolve `#b=<id>` as an id in the current workspace's saved-view store. */
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
  /** Test seam for deterministic delayed-write ordering. Production uses the
   * canonical saved-view encoder. */
  encodeView?: (view: SavedView) => Promise<string>;
  /**
   * Run when a genuinely bare workspace has neither an applicable remembered
   * view nor an applicable workspace default. The web host uses this to frame
   * the snapshot's first dataset without competing with an explicit URL,
   * profile, last view, or default view.
   */
  onInitialViewFallback?: () => void | Promise<void>;
}

export type CaptureBuilder = () => SavedView | null;

export interface CommittedShareLink {
  /** Absolute URL after the matching captured view has been committed. */
  url: string;
  /** The exact capture encoded into `url` (also used for share warnings). */
  view: SavedView;
}

export type FetchSavedViewById = (id: string) => Promise<ResolvedSavedView | null>;
export type FetchDefaultSavedView = () => Promise<ResolvedSavedView | null>;
export type FetchViewerProfile = (profile: string) => Promise<ResolvedSavedView | null>;
export type FetchLastView = () => Promise<ResolvedSavedView | null>;

const unresolvedSavedView: FetchSavedViewById = async () => null;

export class UrlSync {
  private debounceMs: number;
  private win: Window;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingChangeEpoch: number | null = null;
  /** Serializes URL encodes/writes so an older debounced capture can never
   * finish after and overwrite a user-explicit share capture. */
  private writeTail: Promise<void> = Promise.resolve();
  private destroyed = false;
  private popstateHandler: ((e: PopStateEvent) => void) | null = null;
  /** Serializes inbound navigation applies. Newer popstate generations make
   * queued older ones stale before they touch the scene. */
  private navigationTail: Promise<void> = Promise.resolve();
  private navigationEpoch = 0;
  /** Apply-settlement watermark for a default/last/profile restore whose bare
   * address is intentional. The first coarse change-tick flush at or after that
   * settlement is retired by epoch; a subsequent user mutation writes normally.
   * This replaces the timing-sensitive `suppressNextEmptyHashFlush` boolean. */
  private preserveEmptyHashEpoch = 0;
  private retiredPreserveEmptyHashEpoch = 0;

  private readonly captureBuilder: CaptureBuilder;
  private readonly applier: SavedViewApplier;
  private readonly fetchSavedViewById: FetchSavedViewById;
  private readonly fetchDefaultSavedView: FetchDefaultSavedView | null;
  private readonly fetchViewerProfile: FetchViewerProfile | null;
  private readonly fetchLastView: FetchLastView | null;
  private readonly restoreLastViewEnabled: () => boolean;
  private readonly encodeView: (view: SavedView) => Promise<string>;
  private readonly onInitialViewFallback: (() => void | Promise<void>) | null;

  constructor(
    captureBuilder: CaptureBuilder,
    applier: SavedViewApplier,
    options: UrlSyncOptions = {},
  ) {
    this.captureBuilder = captureBuilder;
    this.applier = applier;
    this.debounceMs = options.debounceMs ?? 350;
    this.win = options.window ?? window;
    this.fetchSavedViewById = options.fetchSavedViewById ?? unresolvedSavedView;
    this.fetchDefaultSavedView = options.fetchDefaultSavedView ?? null;
    this.fetchViewerProfile = options.fetchViewerProfile ?? null;
    this.fetchLastView = options.fetchLastView ?? null;
    this.restoreLastViewEnabled =
      options.restoreLastViewEnabled ?? getRestoreLastViewEnabled;
    this.encodeView = options.encodeView ?? encode;
    this.onInitialViewFallback = options.onInitialViewFallback ?? null;
  }

  /** Hook the popstate listener. Idempotent + re-armable after `destroy()`
   *  so React 18 Strict-Mode's mount→unmount→mount effect cycle (which
   *  double-invokes the cleanup before the second mount) doesn't leave the
   *  sync permanently destroyed. */
  start(): void {
    this.destroyed = false;
    if (this.popstateHandler !== null) return;
    this.popstateHandler = () => {
      // popstate fires for back/forward navigation. Generation serialization
      // means a busy apply is awaited and a newer navigation supersedes an
      // older queued one; no timing-based "busy, skip" window exists.
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
  bootstrap(): Promise<void> {
    const navigationEpoch = ++this.navigationEpoch;
    const run = async () => {
      await this.waitForActiveApply();
      if (this.destroyed || navigationEpoch !== this.navigationEpoch) return;
      await this.bootstrapCurrentLocation();
    };
    const result = this.navigationTail.then(run, run);
    this.navigationTail = result.catch(() => {});
    return result;
  }

  private async bootstrapCurrentLocation(): Promise<void> {

    const hash = this.win.location.hash;

    // `#a=<annotation-id>` is a workspace-scoped annotation deep-link
    // (annotation-views slice 3). It is resolved by the HOST (App.tsx) AFTER
    // the workspace document's annotations have loaded — not here — because the
    // pin doesn't exist at scene-bootstrap time. We only RECOGNIZE it so the
    // bootstrap doesn't fall through to `applyInitialViewForEmptyHash` and apply
    // the default/last view over the link's target. No fetch, no apply here.
    if (parseAnnotationHash(hash) !== null) return;

    const savedViewId = parseSavedViewIdHash(hash);
    if (savedViewId !== null) {
      let savedView: ResolvedSavedView | null;
      try {
        savedView = await this.fetchSavedViewById(savedViewId);
      } catch (e) {
        console.warn("[UrlSync] failed to fetch saved view:", e);
        return;
      }
      if (savedView === null) {
        console.warn(`[UrlSync] saved view ${savedViewId} not found`);
        return;
      }
      const settlement = await this.applier.apply(savedView.view);
      // Collapse `#b=<id>` to the live `#view=…` form so the URL reflects
      // the current scene, not the saved view's frozen snapshot. Skip if
      // the apply was a no-op (no scene yet); the next bootstrap will
      // rewrite when the scene is ready.
      if (settlement.status === "applied") await this.flushAfterSavedViewApply();
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
      if (await this.applyPreservingEmptyAddress(lastView.view)) return;
    }
    if (source === "default") {
      if (await this.applyDefaultSavedView()) return;
    }
    await this.applyInitialViewFallback();
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
    await this.applyPreservingEmptyAddress(savedView.view);
  }

  private async applyDefaultSavedView(): Promise<boolean> {
    let savedView: ResolvedSavedView | null;
    try {
      savedView = await this.fetchDefaultSavedView?.() ?? null;
    } catch (e) {
      console.warn("[UrlSync] failed to fetch default saved view:", e);
      return false;
    }
    if (savedView === null) return false;
    return this.applyPreservingEmptyAddress(savedView.view);
  }

  private async applyPreservingEmptyAddress(view: SavedView): Promise<boolean> {
    const settlement = await this.applier.apply(view);
    if (settlement.status === "applied") {
      this.preserveEmptyHashEpoch = Math.max(this.preserveEmptyHashEpoch, settlement.epoch);
      return true;
    }
    return false;
  }

  private async applyInitialViewFallback(): Promise<void> {
    if (!this.onInitialViewFallback) return;
    try {
      await this.onInitialViewFallback();
    } catch (e) {
      console.warn("[UrlSync] initial view fallback failed:", e);
    }
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

  /** Encode and write `#view=…` immediately after a saved-view apply. The
   * current browser route/hash is the write dedupe authority. */
  private async flushAfterSavedViewApply(): Promise<void> {
    if (this.destroyed) return;
    const view = this.captureBuilder();
    if (view === null) return;
    try {
      await this.writeCapturedView(view);
    } catch (e) {
      console.warn("[UrlSync] post-saved-view encode failed:", e);
    }
  }

  /**
   * Notify the sync that the scene has changed. Schedules a debounced URL
   * update tagged with the active apply generation, if any. Apply-owned ticks
   * retire only after that exact generation settles; user ticks remain writable.
   */
  notifyChange(): void {
    if (this.destroyed) return;
    // Capture cause at notification time. A render/effect that fires while an
    // apply generation owns the scene is retired only after THAT epoch settles;
    // a later user change records null and therefore remains writeable.
    this.pendingChangeEpoch = this.applier.getActiveEpoch();
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      const causedByApplyEpoch = this.pendingChangeEpoch;
      this.pendingChangeEpoch = null;
      void this.flushChange(causedByApplyEpoch);
    }, this.debounceMs);
  }

  /**
   * Atomically capture, encode, commit, and return a share URL.
   *
   * This is the only user-explicit share path. Returning the exact capture next
   * to the committed URL prevents the old race where the clipboard received a
   * stale location and warnings inspected a second, potentially different view.
   */
  async commitShareLink(): Promise<CommittedShareLink> {
    if (this.destroyed) throw new Error("View sharing is not available yet.");
    await this.waitForActiveApply();
    if (this.destroyed) throw new Error("View sharing is not available yet.");
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const view = this.captureBuilder();
    if (view === null) throw new Error("There is no active view to share.");
    const url = await this.writeCapturedView(view);
    return { url: new URL(url, this.win.location.href).href, view };
  }

  /** Force-write immediately, bypassing the debounce. Used by tests
   * and on user-explicit save events. */
  async flush(): Promise<void> {
    await this.flushChange(null);
  }

  private async flushChange(causedByApplyEpoch: number | null): Promise<void> {
    if (this.destroyed) return;
    if (causedByApplyEpoch !== null) {
      await this.applier.waitForSettlement(causedByApplyEpoch);
      return;
    }
    await this.waitForActiveApply();
    if (this.destroyed) return;
    if (
      isEmptyHash(this.win.location.hash)
      && this.preserveEmptyHashEpoch > this.retiredPreserveEmptyHashEpoch
    ) {
      this.retiredPreserveEmptyHashEpoch = this.preserveEmptyHashEpoch;
      return;
    }
    const view = this.captureBuilder();
    if (view === null) return;
    try {
      await this.writeCapturedView(view);
    } catch (e) {
      console.warn("[UrlSync] encode failed:", e);
    }
  }

  private async waitForActiveApply(): Promise<void> {
    // A queued navigation can start generation N+1 synchronously when N settles,
    // before this await continuation runs. Re-check the identity until no apply
    // owns the scene, then the caller captures synchronously in the same task.
    while (true) {
      const epoch = this.applier.getActiveEpoch();
      if (epoch === null) return;
      await this.applier.waitForSettlement(epoch);
    }
  }

  private async writeCapturedView(view: SavedView): Promise<string> {
    let resolveResult!: (url: string) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<string>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const run = async (): Promise<void> => {
      try {
        if (this.destroyed) throw new Error("View sharing is not available yet.");
        const payload = await this.encodeView(view);
        if (this.destroyed) throw new Error("View sharing is not available yet.");
        const newHash = `#view=${payload}`;
        const url = `${this.win.location.pathname}${this.win.location.search}${newHash}`;
        const currentUrl = `${this.win.location.pathname}${this.win.location.search}${this.win.location.hash}`;
        if (url !== currentUrl) {
          this.win.history.replaceState(this.win.history.state, "", url);
        }
        resolveResult(url);
      } catch (error) {
        rejectResult(error);
      }
    };
    this.writeTail = this.writeTail.then(run, run);
    // The queue tail intentionally absorbs this operation's failure; callers
    // receive it through `result`, while later writes remain runnable.
    this.writeTail = this.writeTail.catch(() => {});
    return result;
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

/** Parse the compact `#b=<id>` compatibility hash and return its workspace
 *  saved-view id, or null when the hash isn't of that shape. The stable `b`
 *  key is only URL syntax; it no longer names a separate bookmark resource.
 *  Validating the conservative `[A-Za-z0-9._-]+` id class prevents malformed
 *  hashes from driving arbitrary workspace saved-view item requests. */
export function parseSavedViewIdHash(hash: string): string | null {
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
 *  {@link parseSavedViewIdHash}'s conservative character class
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
