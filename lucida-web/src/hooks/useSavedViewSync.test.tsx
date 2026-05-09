// @vitest-environment happy-dom
//
// Hook-level tests for useSavedViewSync. Covers the post-fix wiring:
//   - Bug 1: notifyChange is exposed and forwards to UrlSync.
//   - Bug 2: applier's apply-complete fires markInteractiveDirty/Residency.
//   - Bug 3: applier's apply-complete pushes post-apply C/T/Z/viewMode
//     back to the React-side dim mirrors.
//
// Mocks `lucida-core`'s `dataset_id_for_url` so the hook can construct
// without a wasm init (mirrors applier.test.ts's injected fakeIdForUrl).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { useEffect, useState } from "react";
import { act, render } from "@testing-library/react";

// Mock lucida-core BEFORE importing the hook so the import-time
// `dataset_id_for_url` reference picks up the stub.
vi.mock("lucida-core", () => ({
  dataset_id_for_url: (url: string) => `ds-stub-${url.length.toString(16)}`,
}));

import { useSavedViewSync } from "./useSavedViewSync.ts";
import type { SavedView } from "../savedView/types.ts";
import { SAVED_VIEW_VERSION } from "../savedView/types.ts";
import type { RenderLoop } from "../renderLoop.ts";

interface MockScene {
  zVal: number;
  cVal: number;
  tVal: number;
  cameraModeVal: string;
  z: () => number;
  c: () => number;
  t: () => number;
  camera_mode: () => string;
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
    z: () => m.zVal,
    c: () => m.cVal,
    t: () => m.tVal,
    camera_mode: () => m.cameraModeVal,
    apply_command(json: string) {
      try {
        const cmd = JSON.parse(json);
        if (cmd.type === "set_c") m.cVal = cmd.c;
        if (cmd.type === "set_t") m.tVal = cmd.t;
        if (cmd.type === "set_z") m.zVal = cmd.z;
        if (cmd.type === "set_z_range") m.zVal = cmd.start;
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
  current: ReturnType<typeof useSavedViewSync> | null;
  z: number;
  c: number;
  t: number;
  viewMode: "2d" | "3d";
}

interface HarnessProps {
  scene: MockScene;
  out: Captured;
  loopRef: React.RefObject<RenderLoop | null>;
  initial?: { z?: number; c?: number; t?: number; viewMode?: "2d" | "3d" };
}

function HookHarness({ scene, out, loopRef, initial }: HarnessProps) {
  const [z, setZ] = useState(initial?.z ?? 0);
  const [c, setC] = useState(initial?.c ?? 0);
  const [t, setT] = useState(initial?.t ?? 0);
  const [viewMode, setViewMode] = useState<"2d" | "3d">(initial?.viewMode ?? "2d");
  const handle = useSavedViewSync({
    getScene: () => scene as unknown as Parameters<typeof useSavedViewSync>[0]["getScene"] extends () => infer R ? R : never,
    sendOpenRemoteDataset: () => {},
    sendCommand: () => {},
    changeTick: 0,
    debounceMs: 1,
    loopRef,
    setC,
    setT,
    setZ,
    setViewMode,
  });
  useEffect(() => {
    out.current = handle;
    out.z = z;
    out.c = c;
    out.t = t;
    out.viewMode = viewMode;
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
  let out: Captured;

  beforeEach(() => {
    scene = makeMockScene();
    out = { current: null, z: 0, c: 0, t: 0, viewMode: "2d" };
    // Reset the location hash so each test mounts with no pre-existing
    // bootstrap payload (otherwise a prior test's URL write triggers
    // an applier.apply on mount that races our explicit apply).
    window.history.replaceState(null, "", "/");
  });

  it("returns a stable notifyChange callback", async () => {
    const loop = makeMockLoop();
    const { rerender } = render(<HookHarness scene={scene} out={out} loopRef={loop.ref} />);
    await act(async () => { /* flush mount */ });
    const first = out.current?.notifyChange;
    rerender(<HookHarness scene={scene} out={out} loopRef={loop.ref} />);
    await act(async () => { /* flush rerender */ });
    expect(out.current?.notifyChange).toBe(first);
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
        render(<HookHarness scene={scene} out={out} loopRef={loop.ref} />);
      });
      await act(async () => {
        out.current?.notifyChange();
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

describe("useSavedViewSync — apply-complete wiring (Bug #2 / #3)", () => {
  let scene: MockScene;
  let out: Captured;

  beforeEach(() => {
    scene = makeMockScene();
    out = { current: null, z: 0, c: 0, t: 0, viewMode: "2d" };
    window.history.replaceState(null, "", "/");
  });

  it("marks loop interactive + residency dirty after apply (Bug #2)", async () => {
    const loop = makeMockLoop();
    await act(async () => {
      render(<HookHarness scene={scene} out={out} loopRef={loop.ref} />);
    });
    expect(loop.interactiveCalls).toEqual([]);
    expect(loop.residencyCalls).toEqual([]);

    await act(async () => {
      await out.current!.applier.apply(emptyView());
    });

    expect(loop.interactiveCalls).toContain("savedview_apply");
    expect(loop.residencyCalls).toContain("savedview_apply");
  });

  it("pushes post-apply C/T/Z back to React state (Bug #3)", async () => {
    const loop = makeMockLoop();
    await act(async () => {
      render(<HookHarness scene={scene} out={out} loopRef={loop.ref} />);
    });
    expect(out.c).toBe(0);

    const v = emptyView();
    v.view.c = 2;
    v.view.t = 5;
    v.view.z_range = { start: 7, end: 8 };
    await act(async () => {
      await out.current!.applier.apply(v);
    });
    // Drain a render so the harness's tracking useEffect picks up
    // the new state values pushed by the apply-complete listener.
    await act(async () => { /* flush pending effects */ });

    // Assert via the live scene first (sanity: apply landed at WASM).
    expect(scene.cVal).toBe(2);
    expect(scene.tVal).toBe(5);
    expect(scene.zVal).toBe(7);
    // Then assert React mirrors caught up.
    expect(out.c).toBe(2);
    expect(out.t).toBe(5);
    expect(out.z).toBe(7);
  });

  it("syncs viewMode from post-apply scene state", async () => {
    const loop = makeMockLoop();
    await act(async () => {
      render(<HookHarness scene={scene} out={out} loopRef={loop.ref} />);
    });
    expect(out.viewMode).toBe("2d");

    // Flip the mock's camera_mode to non-slice to simulate a 3D camera apply.
    scene.cameraModeVal = "arcball";
    await act(async () => {
      await out.current!.applier.apply(emptyView());
    });
    await act(async () => { /* flush pending effects */ });
    expect(out.viewMode).toBe("3d");
  });
});
