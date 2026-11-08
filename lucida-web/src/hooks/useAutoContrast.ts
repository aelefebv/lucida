import { useEffect } from "react";
import type { WasmScene } from "lucida-core";
import type { Session } from "../session.ts";
import type { ClientId } from "../bridge.ts";
import type { ViewportCommand } from "../commands.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { ChannelFit } from "../pipeline/autoContrast.ts";
import { invalidateResidency } from "../invalidation.ts";
import { guardedSceneCall } from "../sceneGuard.ts";
import { channelRangeKey, parseChannelRangeKey } from "../components/channels.ts";

declare global {
  interface Window {
    // The latest auto-contrast limits, read by the headless `dataset montage`
    // capture to derive a shared, background-clipped contrast.
    __lucidaAutoContrast?: { min: number; max: number };
  }
}

export interface AutoContrastTarget {
  scene: WasmScene | null;
  loop: RenderLoop | null;
  session: Session | null;
  /** Whether the layer fits its limits automatically. */
  auto: boolean;
  /** Whether this client follows a peer. */
  following: boolean;
}

/**
 * Set a channel's fitted limits, when its layer fits automatically. A
 * follower shows its leader's limits, which arrive with the leader's dataset
 * presence, so it sets none of its own. Returns whether it set them.
 */
export function applyAutoContrastFit(
  target: AutoContrastTarget,
  datasetId: string,
  channel: number,
  fit: ChannelFit,
): boolean {
  const { scene } = target;
  if (!scene || !target.auto || target.following) return false;
  const cmd: ViewportCommand = {
    type: "set_channel_contrast",
    dataset_id: datasetId,
    channel,
    min: fit.limits.min,
    max: fit.limits.max,
  };
  guardedSceneCall("apply_command", scene, () => scene.apply_command(JSON.stringify(cmd)));
  invalidateResidency(target.loop, "auto_contrast");
  target.session?.bridge.sendDatasetPresence(scene.export_dataset_presence());
  return true;
}

interface Params {
  activeLoop: RenderLoop | null;
  autoContrastMapRef: React.RefObject<Map<string, boolean>>;
  /** The latest fit per channel, keyed by {@link channelRangeKey}. */
  contrastFitMapRef: React.RefObject<Map<string, ChannelFit>>;
  setContrastFitMap: React.Dispatch<React.SetStateAction<Map<string, ChannelFit>>>;
  wasmSceneRef: React.RefObject<WasmScene | null>;
  loopRef: React.RefObject<RenderLoop | null>;
  sessionRef: React.RefObject<Session | null>;
  followTarget: ClientId | null;
  followTargetRef: React.RefObject<ClientId | null>;
}

/** Keep each channel's fit and, where the layer asks for it, its contrast limits. */
export function useAutoContrast({
  activeLoop,
  autoContrastMapRef,
  contrastFitMapRef,
  setContrastFitMap,
  wasmSceneRef,
  loopRef,
  sessionRef,
  followTarget,
  followTargetRef,
}: Params) {
  useEffect(() => {
    if (!activeLoop) return;
    activeLoop.setAutoContrastListener((datasetId, channel, fit) => {
      // A montage view shows a single dataset, so the latest limits are its own.
      window.__lucidaAutoContrast = { ...fit.limits };
      setContrastFitMap((prev) => new Map(prev).set(channelRangeKey(datasetId, channel), fit));
      applyAutoContrastFit(
        {
          scene: wasmSceneRef.current,
          loop: loopRef.current,
          session: sessionRef.current,
          auto: autoContrastMapRef.current.get(datasetId) ?? true,
          following: followTargetRef.current !== null,
        },
        datasetId,
        channel,
        fit,
      );
    });
    return () => activeLoop.setAutoContrastListener(null);
  }, [activeLoop, autoContrastMapRef, setContrastFitMap, wasmSceneRef, loopRef, sessionRef, followTargetRef]);

  // A client that stops following fits its own limits again. The fits kept
  // arriving while it followed, so the latest ones are its current view's.
  useEffect(() => {
    if (followTarget !== null) return;
    for (const [key, fit] of contrastFitMapRef.current) {
      const parsed = parseChannelRangeKey(key);
      if (!parsed) continue;
      applyAutoContrastFit(
        {
          scene: wasmSceneRef.current,
          loop: loopRef.current,
          session: sessionRef.current,
          auto: autoContrastMapRef.current.get(parsed.datasetId) ?? true,
          following: false,
        },
        parsed.datasetId,
        parsed.channel,
        fit,
      );
    }
  }, [followTarget, contrastFitMapRef, autoContrastMapRef, wasmSceneRef, loopRef, sessionRef]);
}
