import { describe, expect, it, vi } from "vitest";
import type { WasmScene } from "lucida-core";
import type { Session } from "../session.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { ChannelFit } from "../pipeline/autoContrast.ts";
import { applyAutoContrastFit } from "./useAutoContrast.ts";

const FIT: ChannelFit = { limits: { min: 12, max: 840 }, range: { min: 0, max: 1000 }, provisional: false };

function target(over: { auto?: boolean; following?: boolean } = {}) {
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
      auto: over.auto ?? true,
      following: over.following ?? false,
    },
  };
}

describe("applyAutoContrastFit", () => {
  it("sets the fitted limits on the channel and tells peers", () => {
    const t = target();
    expect(applyAutoContrastFit(t.target, "ds", 2, FIT)).toBe(true);
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

  it("leaves a follower on its leader's limits", () => {
    const t = target({ following: true });
    expect(applyAutoContrastFit(t.target, "ds", 0, FIT)).toBe(false);
    expect(t.scene.apply_command).not.toHaveBeenCalled();
    expect(t.sendDatasetPresence).not.toHaveBeenCalled();
  });

  it("leaves limits a person set by hand", () => {
    const t = target({ auto: false });
    expect(applyAutoContrastFit(t.target, "ds", 0, FIT)).toBe(false);
    expect(t.scene.apply_command).not.toHaveBeenCalled();
  });
});
