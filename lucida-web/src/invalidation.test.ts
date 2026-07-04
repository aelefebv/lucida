import { describe, it, expect, vi } from "vitest";
import {
  invalidateDisplaySettings,
  invalidateResidency,
  invalidateAfterViewRestore,
  requestRender,
} from "./invalidation.ts";
import { getSceneSettings } from "./tickCommon.ts";
import type { WasmScene } from "lucida-core";

/** Recording double for the RenderLoop dirty-flag surface. */
function makeSink() {
  return {
    markInteractiveDirty: vi.fn<(source?: string) => void>(),
    markResidencyDirty: vi.fn<(source?: string) => void>(),
  };
}

/** Minimal scene whose settings reads are call-counted, to observe whether
 *  `getSceneSettings` served its cache or re-read from the scene. */
function makeSettingsScene() {
  const dataset_order = vi.fn(() => JSON.stringify(["wds-1"]));
  const all_dataset_settings = vi.fn(() => JSON.stringify({}));
  return {
    scene: { dataset_order, all_dataset_settings } as unknown as WasmScene,
    dataset_order,
    all_dataset_settings,
  };
}

describe("composed invalidation intents", () => {
  it("invalidateDisplaySettings bumps the settings generation and marks interactive", () => {
    const sink = makeSink();
    const { scene } = makeSettingsScene();

    const before = getSceneSettings(scene);
    invalidateDisplaySettings(sink, "test_source");

    // Planner-visible: the cached snapshot is stale, so the next read
    // re-derives it (fresh object identity).
    const after = getSceneSettings(scene);
    expect(after).not.toBe(before);
    expect(sink.markInteractiveDirty).toHaveBeenCalledExactlyOnceWith("test_source");
    expect(sink.markResidencyDirty).not.toHaveBeenCalled();
  });

  it("invalidateResidency bumps the settings generation and marks residency only", () => {
    const sink = makeSink();
    const { scene } = makeSettingsScene();

    const before = getSceneSettings(scene);
    invalidateResidency(sink);

    expect(getSceneSettings(scene)).not.toBe(before);
    expect(sink.markResidencyDirty).toHaveBeenCalledExactlyOnceWith("residency_settings");
    expect(sink.markInteractiveDirty).not.toHaveBeenCalled();
  });

  it("invalidateAfterViewRestore bumps the generation and marks both dirty kinds with one source", () => {
    const sink = makeSink();
    const { scene } = makeSettingsScene();

    const before = getSceneSettings(scene);
    invalidateAfterViewRestore(sink, "savedview_apply");

    expect(getSceneSettings(scene)).not.toBe(before);
    expect(sink.markInteractiveDirty).toHaveBeenCalledExactlyOnceWith("savedview_apply");
    expect(sink.markResidencyDirty).toHaveBeenCalledExactlyOnceWith("savedview_apply");
  });

  it("requestRender marks interactive without touching the settings generation", () => {
    const sink = makeSink();
    const { scene } = makeSettingsScene();

    const before = getSceneSettings(scene);
    requestRender(sink, "camera_mode_toggle");

    // View-only: the cached settings snapshot stays valid.
    expect(getSceneSettings(scene)).toBe(before);
    expect(sink.markInteractiveDirty).toHaveBeenCalledExactlyOnceWith("camera_mode_toggle");
    expect(sink.markResidencyDirty).not.toHaveBeenCalled();
  });

  it("every intent tolerates an absent loop and still invalidates the settings cache", () => {
    const { scene } = makeSettingsScene();

    let before = getSceneSettings(scene);
    expect(() => invalidateDisplaySettings(null)).not.toThrow();
    expect(getSceneSettings(scene)).not.toBe(before);

    before = getSceneSettings(scene);
    expect(() => invalidateResidency(undefined)).not.toThrow();
    expect(getSceneSettings(scene)).not.toBe(before);

    before = getSceneSettings(scene);
    expect(() => invalidateAfterViewRestore(null)).not.toThrow();
    expect(getSceneSettings(scene)).not.toBe(before);

    expect(() => requestRender(null)).not.toThrow();
  });
});
