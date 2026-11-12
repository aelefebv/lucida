import { describe, expect, it, vi } from "vitest";
import type { WasmScene } from "lucida-core";
import type { Session } from "../session.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { ChannelFit } from "../pipeline/autoContrast.ts";
import { applyAutoContrastFits } from "./useAutoContrast.ts";

const FIT: ChannelFit = { limits: { min: 12, max: 840 }, range: { min: 0, max: 1000 }, provisional: false };

function target(over: { auto?: (datasetId: string) => boolean; following?: boolean } = {}) {
  const scene = {
    apply_command: vi.fn(),
    export_dataset_presence: vi.fn(() => "{}"),
  };
  const sendDatasetPresence = vi.fn();
  const loop = { markInteractiveDirty: vi.fn(), markResidencyDirty: vi.fn(), markInput: vi.fn() };
  return {
    scene,
    sendDatasetPresence,
    loop,
    target: {
      scene: scene as unknown as WasmScene,
      loop: loop as unknown as RenderLoop,
      session: { bridge: { sendDatasetPresence } } as unknown as Session,
      auto: over.auto ?? (() => true),
      following: over.following ?? false,
    },
  };
}

describe("applyAutoContrastFits", () => {
  it("sets the fitted limits on the channel and tells peers", () => {
    const t = target();
    expect(applyAutoContrastFits(t.target, [{ datasetId: "ds", channel: 2, fit: FIT }])).toBe(true);
    expect(JSON.parse(t.scene.apply_command.mock.calls[0][0])).toEqual({
      type: "set_channel_contrast",
      dataset_id: "ds",
      channel: 2,
      min: 12,
      max: 840,
    });
    expect(t.loop.markResidencyDirty).toHaveBeenCalledWith("auto_contrast");
    expect(t.sendDatasetPresence).toHaveBeenCalledOnce();
  });

  it("sets every channel's limits and tells the loop and peers once", () => {
    const t = target();
    const fits = [0, 1, 2].map((channel) => ({ datasetId: "ds", channel, fit: FIT }));
    expect(applyAutoContrastFits(t.target, fits)).toBe(true);
    expect(t.scene.apply_command).toHaveBeenCalledTimes(3);
    expect(t.loop.markResidencyDirty).toHaveBeenCalledOnce();
    expect(t.sendDatasetPresence).toHaveBeenCalledOnce();
  });

  it("leaves a follower on its leader's limits", () => {
    const t = target({ following: true });
    expect(applyAutoContrastFits(t.target, [{ datasetId: "ds", channel: 0, fit: FIT }])).toBe(false);
    expect(t.scene.apply_command).not.toHaveBeenCalled();
    expect(t.sendDatasetPresence).not.toHaveBeenCalled();
  });

  it("leaves limits a person set by hand", () => {
    const t = target({ auto: (datasetId) => datasetId !== "ds" });
    expect(applyAutoContrastFits(t.target, [{ datasetId: "ds", channel: 0, fit: FIT }])).toBe(false);
    expect(t.scene.apply_command).not.toHaveBeenCalled();
    expect(t.loop.markResidencyDirty).not.toHaveBeenCalled();
    expect(applyAutoContrastFits(t.target, [
      { datasetId: "ds", channel: 0, fit: FIT },
      { datasetId: "other", channel: 0, fit: FIT },
    ])).toBe(true);
    expect(JSON.parse(t.scene.apply_command.mock.calls[0][0]).dataset_id).toBe("other");
  });
});
