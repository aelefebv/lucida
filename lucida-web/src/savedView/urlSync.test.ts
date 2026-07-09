import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  UrlSync,
  parseViewHash,
  parseBookmarkHash,
  parseAnnotationHash,
  buildAnnotationLink,
  parseViewerProfileSearch,
  type ResolvedSavedView,
} from "./urlSync.ts";
import { encode } from "./encoder.ts";
import { SavedViewApplier } from "./applier.ts";
import { SAVED_VIEW_VERSION, type SavedView } from "./types.ts";

function emptyView(): SavedView {
  return {
    v: SAVED_VIEW_VERSION,
    datasets: [],
    active_layouts: {},
    camera: { mode: "slice", center: [0, 0], zoom: 1.0, viewport: [800, 600] },
    view: { z_range: { start: 0, end: 1 }, t: 0, c: 0, multi_channel: false },
    display: { contrast_min: 0, contrast_max: 65535, gamma: 1.0 },
    dataset_order: [],
    dataset_settings: {},
  };
}

class FakeApplier {
  inProgress = false;
  applied: SavedView[] = [];
  apply = vi.fn(async (v: SavedView) => {
    this.inProgress = true;
    this.applied.push(v);
    await Promise.resolve();
    this.inProgress = false;
  });
  isInProgress() { return this.inProgress; }
}

function makeFakeWindow(initialHash = "", pathname = "/", search = ""): Window {
  const listeners: Record<string, Array<(e: Event) => void>> = {};
  const state: { state: unknown; href: string; hash: string } = {
    state: null,
    href: `http://localhost${pathname}${search}${initialHash}`,
    hash: initialHash,
  };
  return {
    addEventListener: (k: string, fn: (e: Event) => void) => {
      (listeners[k] ??= []).push(fn);
    },
    removeEventListener: (k: string, fn: (e: Event) => void) => {
      listeners[k] = (listeners[k] ?? []).filter((f) => f !== fn);
    },
    location: {
      get hash() { return state.hash; },
      get pathname() { return pathname; },
      get search() { return search; },
      get href() { return state.href; },
    },
    history: {
      get state() { return state.state; },
      replaceState: (s: unknown, _t: string, url?: string) => {
        state.state = s;
        if (url) {
          state.href = `http://localhost${url}`;
          const h = url.indexOf("#");
          state.hash = h >= 0 ? url.slice(h) : "";
        }
      },
    },
    /** Dispatch a fake popstate. */
    _popstate(detail: unknown) {
      for (const fn of listeners.popstate ?? []) {
        fn({ type: "popstate", state: detail } as unknown as Event);
      }
    },
  } as unknown as Window;
}

describe("parseViewHash", () => {
  it("returns null for empty hash", () => {
    expect(parseViewHash("")).toBeNull();
    expect(parseViewHash("#")).toBeNull();
  });

  it("extracts simple view payload", () => {
    expect(parseViewHash("#view=abc")).toBe("abc");
  });

  it("returns null for non-view hash", () => {
    expect(parseViewHash("#foo=bar")).toBeNull();
  });

  it("extracts view from multi-key hash", () => {
    expect(parseViewHash("#foo=bar&view=xyz&baz=1")).toBe("xyz");
  });
});

describe("parseViewerProfileSearch", () => {
  it("extracts a conservative viewer profile name", () => {
    expect(parseViewerProfileSearch("?viewer_profile=cli.default")).toBe("cli.default");
    expect(parseViewerProfileSearch("viewer_profile=cli_default-1")).toBe("cli_default-1");
  });

  it("rejects empty or unsafe viewer profile names", () => {
    expect(parseViewerProfileSearch("")).toBeNull();
    expect(parseViewerProfileSearch("?viewer_profile=")).toBeNull();
    expect(parseViewerProfileSearch("?viewer_profile=../default")).toBeNull();
  });
});

describe("UrlSync", () => {
  let win: Window;
  let applier: FakeApplier;
  let captureBuilder: () => SavedView | null;
  let view: SavedView;

  beforeEach(() => {
    view = emptyView();
    win = makeFakeWindow();
    applier = new FakeApplier();
    captureBuilder = () => view;
  });

  it("debounces writes", async () => {
    // Real timers — the encoder uses CompressionStream which doesn't
    // round-trip cleanly under vi.useFakeTimers. We assert the debounce
    // contract directly (N calls collapse into 1 replaceState) via a
    // spy + vi.waitFor, so the test is robust to CI scheduling jitter.
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      debounceMs: 30,
      window: win,
    });
    const spy = vi.spyOn(win.history, "replaceState");
    sync.notifyChange();
    sync.notifyChange();
    sync.notifyChange();
    expect(spy).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(win.location.hash.startsWith("#view=")).toBe(true);
    sync.destroy();
  });

  it("debounce timing is configurable", () => {
    const sync500 = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      debounceMs: 500,
      window: win,
    });
    const sync10 = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      debounceMs: 10,
      window: win,
    });
    expect((sync500 as unknown as { debounceMs: number }).debounceMs).toBe(500);
    expect((sync10 as unknown as { debounceMs: number }).debounceMs).toBe(10);
  });

  it("suppresses writes while applier is in progress", async () => {
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      debounceMs: 20,
      window: win,
    });
    applier.inProgress = true;
    sync.notifyChange();
    await new Promise((r) => setTimeout(r, 60));
    expect(win.location.hash).toBe("");
    sync.destroy();
  });

  it("bootstraps from #view= on initial load", async () => {
    const v = emptyView();
    v.view.t = 7;
    const payload = await encode(v);
    win = makeFakeWindow(`#view=${payload}`);
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
    });
    await sync.bootstrap();
    expect(applier.apply).toHaveBeenCalledTimes(1);
    expect(applier.applied[0].view.t).toBe(7);
    sync.destroy();
  });

  it("bootstrap is a no-op when no #view= present", async () => {
    win = makeFakeWindow("");
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
    });
    await sync.bootstrap();
    expect(applier.apply).not.toHaveBeenCalled();
  });

  it("bootstraps from ?viewer_profile= when no hash is present", async () => {
    const v = emptyView();
    v.view.t = 12;
    win = makeFakeWindow("", "/w/ws-1", "?viewer_profile=cli.default");
    const fetchViewerProfile = vi.fn(async (profile: string): Promise<ResolvedSavedView | null> => ({
      id: `viewer_profile:${profile}`,
      view: v,
    }));
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
      fetchViewerProfile,
    });

    await sync.bootstrap();

    expect(fetchViewerProfile).toHaveBeenCalledWith("cli.default");
    expect(applier.apply).toHaveBeenCalledTimes(1);
    expect(applier.applied[0].view.t).toBe(12);
  });

  it("handles popstate by re-applying", async () => {
    const v = emptyView();
    v.view.t = 9;
    const payload = await encode(v);
    win = makeFakeWindow(`#view=${payload}`);
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
    });
    sync.start();
    (win as unknown as { _popstate: (s: unknown) => void })._popstate(null);
    // popstate kicks off a fire-and-forget `bootstrap()` whose decode awaits
    // the CompressionStream pipeline. Poll for the apply to land rather than
    // guessing a fixed wall-clock delay, which races a slow CI runner
    // (lucida-80g).
    await vi.waitFor(() => expect(applier.apply).toHaveBeenCalledTimes(1));
    sync.destroy();
  });

  it("popstate is suppressed during apply", async () => {
    const v = emptyView();
    const payload = await encode(v);
    win = makeFakeWindow(`#view=${payload}`);
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
    });
    sync.start();
    applier.inProgress = true;
    (win as unknown as { _popstate: (s: unknown) => void })._popstate(null);
    await Promise.resolve();
    expect(applier.apply).not.toHaveBeenCalled();
    sync.destroy();
  });

  it("flush writes URL once", async () => {
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
    });
    await sync.flush();
    expect(win.location.hash.startsWith("#view=")).toBe(true);
    sync.destroy();
  });

  it("flush preserves the current workspace route while writing #view", async () => {
    win = makeFakeWindow("", "/w/ws-123");
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
    });
    const spy = vi.spyOn(win.history, "replaceState");

    await sync.flush();

    expect(spy).toHaveBeenCalledWith(null, "", expect.stringMatching(/^\/w\/ws-123#view=/));
    sync.destroy();
  });

  it("flush is a no-op when capture returns null", async () => {
    const sync = new UrlSync(() => null, applier as unknown as SavedViewApplier, {
      window: win,
    });
    await sync.flush();
    expect(win.location.hash).toBe("");
    sync.destroy();
  });

  it("destroy cancels pending debounce", async () => {
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      debounceMs: 30,
      window: win,
    });
    sync.notifyChange();
    sync.destroy();
    await new Promise((r) => setTimeout(r, 80));
    expect(win.location.hash).toBe("");
  });

  it("re-arms after destroy + start (Strict-Mode mount→unmount→mount cycle)", async () => {
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      debounceMs: 30,
      window: win,
    });
    sync.start();
    sync.destroy();
    sync.start();
    sync.notifyChange();
    await new Promise((r) => setTimeout(r, 80));
    expect(win.location.hash.startsWith("#view=")).toBe(true);
  });
});

describe("parseBookmarkHash", () => {
  it("returns null for empty hash", () => {
    expect(parseBookmarkHash("")).toBeNull();
    expect(parseBookmarkHash("#")).toBeNull();
  });

  it("extracts the bookmark id from #b=<id>", () => {
    expect(parseBookmarkHash("#b=abc-123")).toBe("abc-123");
    expect(parseBookmarkHash("b=abc-123")).toBe("abc-123");
  });

  it("returns null for non-b keys", () => {
    expect(parseBookmarkHash("#view=xxx")).toBeNull();
    expect(parseBookmarkHash("#foo=bar")).toBeNull();
  });

  it("rejects ids with special characters (defense against junk URLs)", () => {
    expect(parseBookmarkHash("#b=abc/def")).toBeNull();
    expect(parseBookmarkHash("#b=abc def")).toBeNull();
    expect(parseBookmarkHash("#b=")).toBeNull();
  });

  it("accepts UUID-like ids", () => {
    expect(parseBookmarkHash("#b=550e8400-e29b-41d4-a716-446655440000"))
      .toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("decodes URI-encoded ids before validating", () => {
    expect(parseBookmarkHash("#b=550e8400-e29b")).toBe("550e8400-e29b");
  });
});

describe("UrlSync — #b=<id> bootstrap", () => {
  let win: Window;
  let applier: FakeApplier;
  let captureBuilder: () => SavedView | null;
  let view: SavedView;

  beforeEach(() => {
    view = emptyView();
    applier = new FakeApplier();
    captureBuilder = () => view;
  });

  it("fetches the saved view, hands its view to the applier, and rewrites URL to #view=…", async () => {
    win = makeFakeWindow("#b=abc-123");
    const fetchedViews: SavedView[] = [];
    const sentinelView = emptyView();
    sentinelView.view.t = 42;
    const stub = vi.fn(async (id: string): Promise<ResolvedSavedView | null> => {
      fetchedViews.push(sentinelView);
      return {
        id,
        view: sentinelView,
      };
    });
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
      fetchBookmark: stub,
    });
    await sync.bootstrap();

    expect(stub).toHaveBeenCalledWith("abc-123");
    expect(applier.apply).toHaveBeenCalledOnce();
    expect(applier.applied[0].view.t).toBe(42);
    // URL collapses to #view=… so a subsequent pan re-applies live state,
    // not the saved view's frozen snapshot.
    expect(win.location.hash.startsWith("#view=")).toBe(true);
    sync.destroy();
  });

  it("returns gracefully when the saved-view id is unknown (404)", async () => {
    win = makeFakeWindow("#b=missing");
    const stub = vi.fn(async (): Promise<ResolvedSavedView | null> => null);
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
      fetchBookmark: stub,
    });
    await sync.bootstrap();
    expect(stub).toHaveBeenCalled();
    expect(applier.apply).not.toHaveBeenCalled();
    sync.destroy();
  });

  it("returns gracefully on fetch error without crashing", async () => {
    win = makeFakeWindow("#b=err");
    const stub = vi.fn(async (): Promise<ResolvedSavedView | null> => {
      throw new Error("network down");
    });
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
      fetchBookmark: stub,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await sync.bootstrap();
    expect(applier.apply).not.toHaveBeenCalled();
    warn.mockRestore();
    sync.destroy();
  });

  it("popstate to a #b=<id> URL re-applies through the same path", async () => {
    win = makeFakeWindow("#b=xyz");
    const sentinel = emptyView();
    sentinel.view.t = 99;
    const stub = vi.fn(async (id: string): Promise<ResolvedSavedView | null> => ({
      id,
      view: sentinel,
    }));
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
      fetchBookmark: stub,
    });
    sync.start();
    (win as unknown as { _popstate: (s: unknown) => void })._popstate(null);
    // Poll for the bookmark fetch + apply to land instead of guessing a fixed
    // wall-clock delay, which races a slow CI runner (lucida-80g).
    await vi.waitFor(() => expect(applier.apply).toHaveBeenCalledOnce());
    expect(applier.applied[0].view.t).toBe(99);
    sync.destroy();
  });
});

describe("UrlSync — default saved view bootstrap", () => {
  let win: Window;
  let applier: FakeApplier;
  let view: SavedView;
  let captureBuilder: () => SavedView | null;

  beforeEach(() => {
    view = emptyView();
    applier = new FakeApplier();
    captureBuilder = () => view;
  });

  it("applies the default saved view for an empty hash", async () => {
    win = makeFakeWindow("");
    const defaultView = emptyView();
    defaultView.view.t = 7;
    const fetchDefault = vi.fn(async (): Promise<ResolvedSavedView | null> => ({
      id: "default",
      view: defaultView,
    }));
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
      fetchDefaultSavedView: fetchDefault,
    });

    await sync.bootstrap();

    expect(fetchDefault).toHaveBeenCalledOnce();
    expect(applier.apply).toHaveBeenCalledOnce();
    expect(applier.applied[0].view.t).toBe(7);
    expect(win.location.hash).toBe("");
    sync.destroy();
  });

  it("does not apply the default when #view is explicit", async () => {
    const explicit = emptyView();
    explicit.view.t = 3;
    const payload = await encode(explicit);
    win = makeFakeWindow(`#view=${payload}`);
    const fetchDefault = vi.fn(async (): Promise<ResolvedSavedView | null> => ({
      id: "default",
      view: emptyView(),
    }));
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
      fetchDefaultSavedView: fetchDefault,
    });

    await sync.bootstrap();

    expect(fetchDefault).not.toHaveBeenCalled();
    expect(applier.applied[0].view.t).toBe(3);
    sync.destroy();
  });

  it("does not apply the default when #b is explicit", async () => {
    win = makeFakeWindow("#b=saved");
    const saved = emptyView();
    saved.view.t = 11;
    const fetchDefault = vi.fn(async (): Promise<ResolvedSavedView | null> => ({
      id: "default",
      view: emptyView(),
    }));
    const fetchSaved = vi.fn(async (): Promise<ResolvedSavedView | null> => ({
      id: "saved",
      view: saved,
    }));
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
      fetchSavedViewById: fetchSaved,
      fetchDefaultSavedView: fetchDefault,
    });

    await sync.bootstrap();

    expect(fetchDefault).not.toHaveBeenCalled();
    expect(fetchSaved).toHaveBeenCalledWith("saved");
    expect(applier.applied[0].view.t).toBe(11);
    expect(win.location.hash.startsWith("#view=")).toBe(true);
    sync.destroy();
  });

  it("suppresses the initial empty-hash flush after applying the default", async () => {
    win = makeFakeWindow("");
    const defaultView = emptyView();
    defaultView.view.t = 7;
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
      fetchDefaultSavedView: async () => ({ id: "default", view: defaultView }),
    });

    await sync.bootstrap();
    await sync.flush();

    expect(win.location.hash).toBe("");
    await sync.flush();
    expect(win.location.hash.startsWith("#view=")).toBe(true);
    sync.destroy();
  });
});

describe("UrlSync — last view bootstrap (#700)", () => {
  let applier: FakeApplier;
  let captureBuilder: () => SavedView | null;

  beforeEach(() => {
    applier = new FakeApplier();
    captureBuilder = () => emptyView();
  });

  it("restores the per-user last view for a bare workspace open when enabled", async () => {
    const win = makeFakeWindow("");
    const last = emptyView();
    last.view.t = 5;
    const fetchLastView = vi.fn(async (): Promise<ResolvedSavedView | null> => ({
      id: "last-view",
      view: last,
    }));
    const fetchDefault = vi.fn(async (): Promise<ResolvedSavedView | null> => ({
      id: "default",
      view: emptyView(),
    }));
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
      fetchLastView,
      fetchDefaultSavedView: fetchDefault,
      restoreLastViewEnabled: () => true,
    });

    await sync.bootstrap();

    expect(fetchLastView).toHaveBeenCalledOnce();
    // Last view takes priority over the default — the default is never fetched.
    expect(fetchDefault).not.toHaveBeenCalled();
    expect(applier.applied[0].view.t).toBe(5);
    sync.destroy();
  });

  it("falls back to the default when the toggle is off (and never fetches last view)", async () => {
    const win = makeFakeWindow("");
    const def = emptyView();
    def.view.t = 9;
    const fetchLastView = vi.fn(async (): Promise<ResolvedSavedView | null> => ({
      id: "last-view",
      view: emptyView(),
    }));
    const fetchDefault = vi.fn(async (): Promise<ResolvedSavedView | null> => ({
      id: "default",
      view: def,
    }));
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
      fetchLastView,
      fetchDefaultSavedView: fetchDefault,
      restoreLastViewEnabled: () => false,
    });

    await sync.bootstrap();

    expect(fetchLastView).not.toHaveBeenCalled();
    expect(fetchDefault).toHaveBeenCalledOnce();
    expect(applier.applied[0].view.t).toBe(9);
    sync.destroy();
  });

  it("falls back to the default when there is no remembered last view", async () => {
    const win = makeFakeWindow("");
    const def = emptyView();
    def.view.t = 2;
    const fetchLastView = vi.fn(async (): Promise<ResolvedSavedView | null> => null);
    const fetchDefault = vi.fn(async (): Promise<ResolvedSavedView | null> => ({
      id: "default",
      view: def,
    }));
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
      fetchLastView,
      fetchDefaultSavedView: fetchDefault,
      restoreLastViewEnabled: () => true,
    });

    await sync.bootstrap();

    expect(fetchLastView).toHaveBeenCalledOnce();
    expect(fetchDefault).toHaveBeenCalledOnce();
    expect(applier.applied[0].view.t).toBe(2);
    sync.destroy();
  });

  it("a URL #view= always wins over the remembered last view", async () => {
    const explicit = emptyView();
    explicit.view.t = 42;
    const payload = await encode(explicit);
    const win = makeFakeWindow(`#view=${payload}`);
    const fetchLastView = vi.fn(async (): Promise<ResolvedSavedView | null> => ({
      id: "last-view",
      view: emptyView(),
    }));
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
      fetchLastView,
      restoreLastViewEnabled: () => true,
    });

    await sync.bootstrap();

    // The hash branch handled it; the last view was never consulted.
    expect(fetchLastView).not.toHaveBeenCalled();
    expect(applier.applied[0].view.t).toBe(42);
    sync.destroy();
  });

  it("degrades to the default when the last-view fetch throws", async () => {
    const win = makeFakeWindow("");
    const def = emptyView();
    def.view.t = 8;
    const fetchLastView = vi.fn(async (): Promise<ResolvedSavedView | null> => {
      throw new Error("offline");
    });
    const fetchDefault = vi.fn(async (): Promise<ResolvedSavedView | null> => ({
      id: "default",
      view: def,
    }));
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      window: win,
      fetchLastView,
      fetchDefaultSavedView: fetchDefault,
      restoreLastViewEnabled: () => true,
    });

    await sync.bootstrap();

    expect(applier.applied[0].view.t).toBe(8);
    sync.destroy();
  });
});

describe("parseAnnotationHash (#a=<annotation-id>, slice 3)", () => {
  it("returns null for empty hash", () => {
    expect(parseAnnotationHash("")).toBeNull();
    expect(parseAnnotationHash("#")).toBeNull();
  });

  it("extracts the annotation id from #a=<id>", () => {
    expect(parseAnnotationHash("#a=pin-123")).toBe("pin-123");
    expect(parseAnnotationHash("a=pin-123")).toBe("pin-123");
  });

  it("returns null for non-a keys (doesn't collide with #view= / #b=)", () => {
    expect(parseAnnotationHash("#view=xxx")).toBeNull();
    expect(parseAnnotationHash("#b=abc")).toBeNull();
    expect(parseAnnotationHash("#foo=bar")).toBeNull();
  });

  it("accepts UUID-like annotation ids (client-minted)", () => {
    expect(parseAnnotationHash("#a=550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("rejects junk: special chars, spaces, empty value (defense against forged links)", () => {
    expect(parseAnnotationHash("#a=abc/def")).toBeNull();
    expect(parseAnnotationHash("#a=abc def")).toBeNull();
    expect(parseAnnotationHash("#a=<script>")).toBeNull();
    expect(parseAnnotationHash("#a=")).toBeNull();
  });

  it("decodes URI-encoded ids before validating", () => {
    // "pin-123" percent-encoded round-trips back to the same id.
    expect(parseAnnotationHash("#a=pin%2D123")).toBe("pin-123");
    // …but decoding to a junk char still rejects.
    expect(parseAnnotationHash("#a=pin%2F123")).toBeNull();
  });

  it("extracts #a= when coexisting with other params", () => {
    expect(parseAnnotationHash("#foo=bar&a=pin-9&baz=1")).toBe("pin-9");
  });
});

describe("buildAnnotationLink (#a= round-trip, slice 3)", () => {
  it("builds <workspace-url>#a=<pinId> from the location", () => {
    const link = buildAnnotationLink("pin-123", {
      origin: "https://lucida.example",
      pathname: "/w/ws-1",
      search: "",
    });
    expect(link).toBe("https://lucida.example/w/ws-1#a=pin-123");
  });

  it("preserves an existing query string", () => {
    const link = buildAnnotationLink("pin-9", {
      origin: "https://lucida.example",
      pathname: "/w/ws-1",
      search: "?debug=1",
    });
    expect(link).toBe("https://lucida.example/w/ws-1?debug=1#a=pin-9");
  });

  it("round-trips: parseAnnotationHash recovers the id buildAnnotationLink wrote", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const link = buildAnnotationLink(id, {
      origin: "https://lucida.example",
      pathname: "/w/ws-1",
      search: "",
    });
    const hash = link.slice(link.indexOf("#"));
    expect(parseAnnotationHash(hash)).toBe(id);
  });
});

describe("UrlSync — #a=<id> bootstrap (deferred to host; no apply here)", () => {
  it("recognizes #a= and applies NOTHING at bootstrap (resolve is the host's post-doc-load job)", async () => {
    const win = makeFakeWindow("#a=pin-123", "/w/ws-1");
    const applier = new FakeApplier();
    // Wire a default + last view + bookmark fetcher: NONE must fire — a #a=
    // link must not be mistaken for a bare workspace open (which would apply the
    // default/last view over the link's target).
    const fetchDefault = vi.fn(async (): Promise<ResolvedSavedView | null> => ({
      id: "default",
      view: emptyView(),
    }));
    const fetchLastView = vi.fn(async (): Promise<ResolvedSavedView | null> => ({
      id: "last-view",
      view: emptyView(),
    }));
    const fetchBookmark = vi.fn(async (): Promise<ResolvedSavedView | null> => null);
    const sync = new UrlSync(() => emptyView(), applier as unknown as SavedViewApplier, {
      window: win,
      fetchDefaultSavedView: fetchDefault,
      fetchLastView,
      fetchBookmark,
      restoreLastViewEnabled: () => true,
    });

    await sync.bootstrap();

    expect(applier.apply).not.toHaveBeenCalled();
    expect(fetchDefault).not.toHaveBeenCalled();
    expect(fetchLastView).not.toHaveBeenCalled();
    expect(fetchBookmark).not.toHaveBeenCalled();
    // The hash is left intact for the host to resolve post-doc-load.
    expect(win.location.hash).toBe("#a=pin-123");
    sync.destroy();
  });

  it("collapseToLiveView() rewrites the #a= hash to the live #view= form", async () => {
    const win = makeFakeWindow("#a=pin-123", "/w/ws-1");
    const applier = new FakeApplier();
    const sync = new UrlSync(() => emptyView(), applier as unknown as SavedViewApplier, {
      window: win,
    });

    await sync.collapseToLiveView();

    expect(win.location.hash.startsWith("#view=")).toBe(true);
    sync.destroy();
  });
});
