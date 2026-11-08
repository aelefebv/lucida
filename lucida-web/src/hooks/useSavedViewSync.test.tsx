// @vitest-environment happy-dom
//
// Hook wiring: notifyChange forwards to UrlSync, apply-complete wakes the
// render loop, and React reads the applied C/T/Z, viewMode, and multiChannel
// back from the scene. `dataset_id_for_url` is mocked so the hook builds
// without a wasm init.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { act, render } from "@testing-library/react";

// Mock lucida-core before importing the hook so the import-time
// `dataset_id_for_url` reference picks up the stub.
vi.mock("lucida-core", () => ({
  dataset_id_for_url: (url: string) => `ds-stub-${url.length.toString(16)}`,
}));

import { useSavedViewSync } from "./useSavedViewSync.ts";
import type { SavedView } from "../savedView/types.ts";
import { SAVED_VIEW_VERSION } from "../savedView/types.ts";
import { decode, encode } from "../savedView/encoder.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { WasmScene } from "lucida-core";
import { SceneStore } from "../sceneStore.ts";
import { useSceneView } from "./useSceneView.ts";

interface MockScene {
  zVal: number;
  cVal: number;
  tVal: number;
  cameraModeVal: string;
  multiChannelVal: boolean;
  epochCounts: { view: number; selection: number };
  epochs: () => string;
  z: () => number;
  c: () => number;
  t: () => number;
  camera_mode: () => string;
  multi_channel: () => boolean;
  apply_command: (json: string) => void;
  dataset_ids: () => string;
  available_layouts: (id: string) => string;
  dataset_volume_shape: (id: string) => Uint32Array;
  export_presence: () => string;
  export_dataset_presence: () => string;
  import_presence: (json: string) => void;
}

function makeMockScene(): MockScene {
  const presence = {
    camera: { mode: "slice", center: [0, 0], zoom: 1.0, viewport: [800, 600] },
    view: { z_range: { start: 0, end: 1 }, t: 0, c: 0, multi_channel: false },
    display: { contrast_min: 0, contrast_max: 65535, gamma: 1.0 },
  };
  const m: MockScene = {
    zVal: 0,
    cVal: 0,
    tVal: 0,
    cameraModeVal: "slice",
    multiChannelVal: false,
    epochCounts: { view: 0, selection: 0 },
    epochs: () => JSON.stringify({ content: 0, layout: 0, ...m.epochCounts }),
    z: () => m.zVal,
    c: () => m.cVal,
    t: () => m.tVal,
    camera_mode: () => m.cameraModeVal,
    multi_channel: () => m.multiChannelVal,
    apply_command(json: string) {
      try {
        const cmd = JSON.parse(json);
        if (cmd.type === "set_c") m.cVal = cmd.c;
        if (cmd.type === "set_t") m.tVal = cmd.t;
        if (cmd.type === "set_z") m.zVal = cmd.z;
        if (cmd.type === "set_z_range") m.zVal = cmd.start;
        if (cmd.type === "set_multi_channel") m.multiChannelVal = cmd.enabled;
        if (cmd.type === "pan") m.epochCounts.view++;
        else m.epochCounts.selection++;
      } catch { /* ignore */ }
    },
    dataset_ids: () => "[]",
    available_layouts: () => "[]",
    dataset_volume_shape: () => new Uint32Array(0),
    export_presence: () => JSON.stringify(presence),
    export_dataset_presence: () => JSON.stringify({ dataset_order: [], dataset_settings: {} }),
    import_presence: (json: string) => {
      const obj = JSON.parse(json);
      Object.assign(presence, obj);
      m.epochCounts.view++;
      m.epochCounts.selection++;
    },
  };
  return m;
}

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

interface Captured {
  current: {
    handle: ReturnType<typeof useSavedViewSync>;
    z: number;
    c: number;
    t: number;
    viewMode: "2d" | "3d";
    multiChannel: boolean;
  } | null;
}

interface HarnessProps {
  scene: MockScene;
  store: SceneStore;
  outRef: Captured;
  loopRef: React.RefObject<RenderLoop | null>;
  persistLastView?: (view: SavedView) => Promise<unknown>;
  lastViewDebounceMs?: number;
  captureSurface?: boolean;
}

function HookHarness({
  scene,
  store,
  outRef,
  loopRef,
  persistLastView,
  lastViewDebounceMs,
  captureSurface,
}: HarnessProps) {
  const { z, c, t, viewMode, multiChannel } = useSceneView(store);
  const [autoContrastMap, setAutoContrastMap] = useState<Map<string, boolean>>(new Map());
  // Mirror the latest map into a ref via useLayoutEffect — the hook reads
  // .current from event handlers and follow-on effects, all of which fire
  // after this layout effect has updated it.
  const autoContrastMapRef = useRef(autoContrastMap);
  useLayoutEffect(() => {
    autoContrastMapRef.current = autoContrastMap;
  }, [autoContrastMap]);
  const handle = useSavedViewSync({
    getScene: () => scene as unknown as Parameters<typeof useSavedViewSync>[0]["getScene"] extends () => infer R ? R : never,
    sendOpenRemoteDataset: () => {},
    sendCommand: () => {},
    changeTick: 0,
    sceneStore: store,
    debounceMs: 1,
    loopRef,
    autoContrastMapRef,
    setAutoContrastMap,
    persistLastView,
    lastViewDebounceMs,
    captureSurface,
    // Keep the per-user toggle out of these tests: the localStorage-backed
    // default is on, but pin it so a test machine's storage can't disarm the
    // capture we're asserting about.
    restoreLastViewEnabled: () => true,
  });
  useEffect(() => {
    outRef.current = { handle, z, c, t, viewMode, multiChannel };
  });
  return null;
}

function makeMockLoop(): {
  ref: React.RefObject<RenderLoop | null>;
  interactiveCalls: string[];
  residencyCalls: string[];
} {
  const interactiveCalls: string[] = [];
  const residencyCalls: string[] = [];
  const stub = {
    markInteractiveDirty: (source: string = "external") => { interactiveCalls.push(source); },
    markResidencyDirty: (source: string = "external") => { residencyCalls.push(source); },
  } as unknown as RenderLoop;
  // Use a real ref so the hook's `loopRef.current?.markInteractiveDirty(...)`
  // sees the stub.
  const ref = { current: stub } as React.RefObject<RenderLoop | null>;
  return { ref, interactiveCalls, residencyCalls };
}

describe("useSavedViewSync — exposes notifyChange (Bug #1)", () => {
  let scene: MockScene;
  let store: SceneStore;
  let outRef: Captured;

  beforeEach(() => {
    scene = makeMockScene();
    store = new SceneStore(() => scene as unknown as WasmScene);
    outRef = { current: null };
    // Reset the location hash so each test mounts with no pre-existing
    // bootstrap payload (otherwise a prior test's URL write triggers
    // an applier.apply on mount that races our explicit apply).
    window.history.replaceState(null, "", "/");
  });

  it("returns a stable notifyChange callback", async () => {
    const loop = makeMockLoop();
    const { rerender } = render(<HookHarness scene={scene} store={store} outRef={outRef} loopRef={loop.ref} />);
    await act(async () => { /* flush mount */ });
    const first = outRef.current?.handle.notifyChange;
    rerender(<HookHarness scene={scene} store={store} outRef={outRef} loopRef={loop.ref} />);
    await act(async () => { /* flush rerender */ });
    expect(outRef.current?.handle.notifyChange).toBe(first);
  });

  it("notifyChange schedules a debounced URL write", async () => {
    const loop = makeMockLoop();
    const originalReplace = window.history.replaceState;
    const replaceCalls: Array<{ url: string | null | undefined }> = [];
    window.history.replaceState = ((s: unknown, t: string, u?: string | null) => {
      replaceCalls.push({ url: u });
      return originalReplace.call(window.history, s, t, u);
    }) as typeof window.history.replaceState;

    try {
      await act(async () => {
        render(<HookHarness scene={scene} store={store} outRef={outRef} loopRef={loop.ref} />);
      });
      await act(async () => {
        outRef.current?.handle.notifyChange();
      });
      // Past debounce + encode latency.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 80));
      });
      expect(replaceCalls.some((c) => (c.url ?? "").includes("#view="))).toBe(true);
    } finally {
      window.history.replaceState = originalReplace;
    }
  });
});

describe("useSavedViewSync — capture surface writes no user state (#923)", () => {
  let scene: MockScene;
  let store: SceneStore;
  let outRef: Captured;

  // Fake timers here on purpose: these assert about a 3-second debounce, and
  // sleeping on the real clock to prove "nothing happened" is both slow and
  // the kind of test that flakes on a loaded CI runner.
  beforeEach(() => {
    scene = makeMockScene();
    store = new SceneStore(() => scene as unknown as WasmScene);
    outRef = { current: null };
    window.history.replaceState(null, "", "/");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists the last view on an interactive session (behavior is unchanged)", async () => {
    const loop = makeMockLoop();
    const persisted: SavedView[] = [];
    await act(async () => {
      render(
        <HookHarness
          scene={scene}
          store={store}
          outRef={outRef}
          loopRef={loop.ref}
          persistLastView={async (v) => { persisted.push(v); }}
          lastViewDebounceMs={3000}
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(persisted.length).toBe(1);
  });

  it("persists a pan with no other change as the last view", async () => {
    const loop = makeMockLoop();
    const persisted: SavedView[] = [];
    await act(async () => {
      render(
        <HookHarness
          scene={scene}
          store={store}
          outRef={outRef}
          loopRef={loop.ref}
          persistLastView={async (v) => { persisted.push(v); }}
          lastViewDebounceMs={3000}
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(persisted.length).toBe(1);

    await act(async () => {
      scene.apply_command(JSON.stringify({ type: "pan", dx: 10, dy: 0 }));
      store.sync();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(persisted.length).toBe(2);
  });

  it("sends no last view for a render that changed nothing", async () => {
    const loop = makeMockLoop();
    const persisted: SavedView[] = [];
    const persist = async (v: SavedView) => { persisted.push(v); };
    const harness = () => (
      <HookHarness
        scene={scene}
        store={store}
        outRef={outRef}
        loopRef={loop.ref}
        persistLastView={persist}
        lastViewDebounceMs={3000}
      />
    );
    let rerender: (ui: React.ReactElement) => void = () => {};
    await act(async () => {
      rerender = render(harness()).rerender;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(persisted.length).toBe(1);

    await act(async () => {
      rerender(harness());
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(persisted.length).toBe(1);
  });

  it("persists nothing on the capture surface, however long the run", async () => {
    const loop = makeMockLoop();
    const persisted: SavedView[] = [];
    await act(async () => {
      render(
        <HookHarness
          scene={scene}
          store={store}
          outRef={outRef}
          loopRef={loop.ref}
          captureSurface
          persistLastView={async (v) => { persisted.push(v); }}
          lastViewDebounceMs={3000}
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    expect(persisted).toEqual([]);
  });

  it("schedules no timer at all on the capture surface, so there is no wall-clock floor", async () => {
    const loop = makeMockLoop();
    const realSetTimeout = window.setTimeout;
    const delays: number[] = [];
    window.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof window.setTimeout;
    try {
      await act(async () => {
        render(
          <HookHarness
            scene={scene}
            store={store}
            outRef={outRef}
            loopRef={loop.ref}
            captureSurface
            persistLastView={async () => {}}
            lastViewDebounceMs={30_000}
          />,
        );
      });
      expect(delays).not.toContain(30_000);
    } finally {
      window.setTimeout = realSetTimeout;
    }
  });
});

describe("useSavedViewSync — the URL and the last view follow the camera", () => {
  let scene: MockScene;
  let store: SceneStore;
  let outRef: Captured;
  let written: Promise<SavedView["camera"]>[];
  let originalReplace: History["replaceState"];

  // Real timers: the URL write waits on an encode the fake clock can't drive.
  // The URL writes are read from `replaceState` rather than the hash, since a
  // flush another test left in flight can land on the hash at any time.
  beforeEach(() => {
    scene = makeMockScene();
    store = new SceneStore(() => scene as unknown as WasmScene);
    outRef = { current: null };
    window.history.replaceState(null, "", "/");
    written = [];
    originalReplace = window.history.replaceState;
    window.history.replaceState = ((s: unknown, t: string, url?: string | URL | null) => {
      const payload = /view=([^&]+)/.exec(String(url ?? ""))?.[1];
      if (payload) written.push(decode(payload).then((v) => v.camera));
      return originalReplace.call(window.history, s, t, url);
    }) as History["replaceState"];
  });

  afterEach(() => {
    window.history.replaceState = originalReplace;
  });

  function setCamera(camera: Record<string, unknown>) {
    scene.import_presence(JSON.stringify({ camera }));
    store.sync();
  }

  const writtenCameras = () => Promise.all(written);

  /** Past both debounces and the encode. */
  const settle = () => act(async () => {
    await new Promise((r) => setTimeout(r, 80));
  });

  it("persists neither while the camera is unframed, and both once it is fitted", async () => {
    const loop = makeMockLoop();
    const persisted: SavedView[] = [];
    setCamera({ mode: "slice", center: [0, 0], zoom: 1, viewport: [800, 600], framing: "unframed" });
    await act(async () => {
      render(
        <HookHarness
          scene={scene}
          store={store}
          outRef={outRef}
          loopRef={loop.ref}
          persistLastView={async (v) => { persisted.push(v); }}
          lastViewDebounceMs={5}
        />,
      );
    });
    await act(async () => {
      outRef.current!.handle.notifyChange();
    });
    await settle();
    expect(persisted).toHaveLength(0);
    expect((await writtenCameras()).filter((c) => c.framing === "unframed")).toHaveLength(0);

    await act(async () => {
      setCamera({ mode: "slice", center: [64, 64], zoom: 2, viewport: [800, 600], framing: "framed" });
    });
    await vi.waitFor(async () => {
      expect(persisted).toHaveLength(1);
      expect((await writtenCameras()).some((c) => c.framing === "framed")).toBe(true);
    });
  });

  it("rewrites #view= when a canvas change moves the view with no control touched", async () => {
    const loop = makeMockLoop();
    await act(async () => {
      render(<HookHarness scene={scene} store={store} outRef={outRef} loopRef={loop.ref} />);
    });
    await act(async () => {
      outRef.current!.handle.notifyChange();
    });
    await settle();

    // A resize refits a framed camera: only the scene's epochs say so.
    await act(async () => {
      setCamera({ mode: "slice", center: [64, 64], zoom: 0.5, viewport: [400, 600], framing: "framed" });
    });
    await vi.waitFor(async () => {
      const viewports = (await writtenCameras()).map((c) => c.viewport.join("x"));
      expect(viewports).toContain("400x600");
    });
  });
});

describe("useSavedViewSync — apply-complete wiring (Bug #2 / #3)", () => {
  let scene: MockScene;
  let store: SceneStore;
  let outRef: Captured;

  beforeEach(() => {
    scene = makeMockScene();
    store = new SceneStore(() => scene as unknown as WasmScene);
    outRef = { current: null };
    window.history.replaceState(null, "", "/");
  });

  it("marks loop interactive + residency dirty after apply (Bug #2)", async () => {
    const loop = makeMockLoop();
    await act(async () => {
      render(<HookHarness scene={scene} store={store} outRef={outRef} loopRef={loop.ref} />);
    });
    expect(loop.interactiveCalls).toEqual([]);
    expect(loop.residencyCalls).toEqual([]);

    await act(async () => {
      await outRef.current!.handle.applier.apply(emptyView());
    });

    expect(loop.interactiveCalls).toContain("savedview_apply");
    expect(loop.residencyCalls).toContain("savedview_apply");
  });

  it("lets React read the applied C/T/Z back from the scene", async () => {
    const loop = makeMockLoop();
    await act(async () => {
      render(<HookHarness scene={scene} store={store} outRef={outRef} loopRef={loop.ref} />);
    });
    expect(outRef.current?.c).toBe(0);

    const v = emptyView();
    v.view.c = 2;
    v.view.t = 5;
    v.view.z_range = { start: 7, end: 8 };
    await act(async () => {
      await outRef.current!.handle.applier.apply(v);
    });
    // Drain a render so the harness's tracking useEffect picks up
    // the new state values pushed by the apply-complete listener.
    await act(async () => { /* flush pending effects */ });

    // Assert via the live scene first (sanity: apply landed at WASM).
    expect(scene.cVal).toBe(2);
    expect(scene.tVal).toBe(5);
    expect(scene.zVal).toBe(7);
    // Then assert React reads it back.
    expect(outRef.current?.c).toBe(2);
    expect(outRef.current?.t).toBe(5);
    expect(outRef.current?.z).toBe(7);
  });

  it("reads viewMode from the post-apply scene", async () => {
    const loop = makeMockLoop();
    await act(async () => {
      render(<HookHarness scene={scene} store={store} outRef={outRef} loopRef={loop.ref} />);
    });
    expect(outRef.current?.viewMode).toBe("2d");

    // Flip the mock's camera_mode to non-slice to simulate a 3D camera apply.
    scene.cameraModeVal = "arcball";
    await act(async () => {
      await outRef.current!.handle.applier.apply(emptyView());
    });
    await act(async () => { /* flush pending effects */ });
    expect(outRef.current?.viewMode).toBe("3d");
  });

  it("reads multiChannel from the post-apply scene", async () => {
    const loop = makeMockLoop();
    await act(async () => {
      render(<HookHarness scene={scene} store={store} outRef={outRef} loopRef={loop.ref} />);
    });
    expect(outRef.current?.multiChannel).toBe(false);

    const v = emptyView();
    v.view.multi_channel = true;
    await act(async () => {
      await outRef.current!.handle.applier.apply(v);
    });
    await act(async () => { /* flush pending effects */ });

    expect(scene.multiChannelVal).toBe(true);
    expect(outRef.current?.multiChannel).toBe(true);
  });

  // The layer panel reads single-channel mode on `c` as that channel soloed.
  it("restores a URL recorded in single-channel mode on its channel, from a composite", async () => {
    const loop = makeMockLoop();
    scene.multiChannelVal = true;
    await act(async () => {
      render(<HookHarness scene={scene} store={store} outRef={outRef} loopRef={loop.ref} />);
    });

    // Single-channel views were recorded without the flag.
    const recorded = emptyView();
    recorded.view.c = 1;
    delete recorded.view.multi_channel;
    const restored = await decode(await encode(recorded));

    await act(async () => {
      await outRef.current!.handle.applier.apply(restored);
    });
    await act(async () => { /* flush pending effects */ });

    expect(scene.multiChannelVal).toBe(false);
    expect(scene.cVal).toBe(1);
    expect(outRef.current?.multiChannel).toBe(false);
    expect(outRef.current?.c).toBe(1);
  });
});
