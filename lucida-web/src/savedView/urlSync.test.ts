import { describe, it, expect, vi, beforeEach } from "vitest";
import { UrlSync, parseViewHash } from "./urlSync.ts";
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

function makeFakeWindow(initialHash = ""): Window {
  const listeners: Record<string, Array<(e: Event) => void>> = {};
  const state: { state: unknown; href: string; hash: string } = {
    state: null,
    href: `http://localhost/${initialHash}`,
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
      get pathname() { return "/"; },
      get search() { return ""; },
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
    // round-trip cleanly under vi.useFakeTimers. The debounce-timing
    // assertion still holds because we use a tiny delay.
    const sync = new UrlSync(captureBuilder, applier as unknown as SavedViewApplier, {
      debounceMs: 30,
      window: win,
    });
    sync.notifyChange();
    sync.notifyChange();
    sync.notifyChange();
    expect(win.location.hash).toBe("");
    // Wait less than the debounce window — should still be empty.
    await new Promise((r) => setTimeout(r, 5));
    expect(win.location.hash).toBe("");
    // Wait past the debounce + encode time.
    await new Promise((r) => setTimeout(r, 80));
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
    // popstate handler kicks off `bootstrap()` whose decode awaits the
    // CompressionStream pipeline — drain a few macrotasks to be sure.
    await new Promise((r) => setTimeout(r, 5));
    expect(applier.apply).toHaveBeenCalledTimes(1);
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
});
