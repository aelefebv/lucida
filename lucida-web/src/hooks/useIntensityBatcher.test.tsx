// @vitest-environment happy-dom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WasmScene } from "lucida-core";
import type { RenderClient } from "../renderer/renderClient.ts";
import type { ViewportCoordinator } from "../viewportCoordinator.ts";
import { intensityRangeKey, useIntensityBatcher } from "./useIntensityBatcher.ts";

describe("useIntensityBatcher viewport effects", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("routes automatic contrast through the coordinator's data-driven policy", () => {
    const client = { onIntensityRange: null } as unknown as RenderClient;
    // Deliberately no apply_command/export_dataset_presence methods: a legacy
    // component-side scene/presence sequence would throw instead of passing.
    const scene = { c: () => 2 } as unknown as WasmScene;
    const viewport: Pick<ViewportCoordinator, "apply"> = {
      apply: vi.fn(() => true),
    };

    function Harness() {
      useIntensityBatcher({
        clientReady: true,
        clientRef: { current: client },
        autoContrastMapRef: { current: new Map([["ds-a", true]]) },
        wasmSceneRef: { current: scene },
        viewport,
        setDataRangeMap: vi.fn(),
      });
      return null;
    }

    render(<Harness />);
    act(() => client.onIntensityRange?.("ds-a", 2, 4, 90));

    expect(viewport.apply).toHaveBeenCalledExactlyOnceWith(
      {
        type: "set_channel_contrast",
        dataset_id: "ds-a",
        channel: 2,
        min: 4,
        max: 90,
      },
      {
        source: "auto_contrast",
        breakFollow: false,
        publication: "dataset-presence",
        invalidation: "residency",
        history: { skip: true },
      },
    );
  });

  it("keeps delayed interleaved ranges scoped to the reporting channel", () => {
    let raf: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      raf = callback;
      return 1;
    }));
    const client = { onIntensityRange: null } as unknown as RenderClient;
    let selectedChannel = 7;
    const scene = { c: () => selectedChannel } as unknown as WasmScene;
    const viewport: Pick<ViewportCoordinator, "apply"> = {
      apply: vi.fn(() => true),
    };
    const setDataRangeMap = vi.fn();

    function Harness() {
      useIntensityBatcher({
        clientReady: true,
        clientRef: { current: client },
        autoContrastMapRef: { current: new Map([["ds-a", true]]) },
        wasmSceneRef: { current: scene },
        viewport,
        setDataRangeMap,
      });
      return null;
    }

    render(<Harness />);
    act(() => {
      client.onIntensityRange?.("ds-a", 0, 10, 20);
      selectedChannel = 9;
      client.onIntensityRange?.("ds-a", 1, 100, 200);
    });

    expect(vi.mocked(viewport.apply).mock.calls.map(call => call[0])).toEqual([
      expect.objectContaining({ dataset_id: "ds-a", channel: 0, min: 10, max: 20 }),
      expect.objectContaining({ dataset_id: "ds-a", channel: 1, min: 100, max: 200 }),
    ]);
    act(() => { raf?.(0); });
    const update = setDataRangeMap.mock.calls[0][0] as (
      previous: Map<string, { min: number; max: number }>,
    ) => Map<string, { min: number; max: number }>;
    expect(update(new Map())).toEqual(new Map([
      [intensityRangeKey("ds-a", 0), { min: 10, max: 20 }],
      [intensityRangeKey("ds-a", 1), { min: 100, max: 200 }],
    ]));
  });
});
