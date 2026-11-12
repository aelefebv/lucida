import { useEffect } from "react";
import type { WasmScene } from "lucida-core";
import type { Session } from "../session.ts";
import type { ViewportCommand } from "../commands.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { ChannelFit, ChannelFitUpdate } from "../pipeline/autoContrast.ts";
import { invalidateResidency } from "../invalidation.ts";
import type { PeerStore } from "../peerStore.ts";
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
  /** Whether the dataset's layer fits its limits automatically. */
  auto: (datasetId: string) => boolean;
  /** Whether this client follows a peer. */
  following: boolean;
}

/**
 * Set each channel's fitted limits, where its layer fits automatically, and
 * tell the loop and peers once for all of them. A follower shows its
 * leader's limits, which arrive with the leader's dataset presence, so it
 * sets none of its own. Returns whether it set any.
 */
export function applyAutoContrastFits(target: AutoContrastTarget, fits: readonly ChannelFitUpdate[]): boolean {
  const { scene } = target;
  if (!scene || target.following) return false;
  let applied = false;
  for (const { datasetId, channel, fit } of fits) {
    if (!target.auto(datasetId)) continue;
    const cmd: ViewportCommand = {
      type: "set_channel_contrast",
      dataset_id: datasetId,
      channel,
      min: fit.limits.min,
      max: fit.limits.max,
    };
    guardedSceneCall("apply_command", scene, () => scene.apply_command(JSON.stringify(cmd)));
    applied = true;
  }
  if (!applied) return false;
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
  peerStore: PeerStore;
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
  peerStore,
}: Params) {
  useEffect(() => {
    if (!activeLoop) return;
    activeLoop.setAutoContrastListener((fits) => {
      // A montage view shows a single dataset, so the latest limits are its own.
      window.__lucidaAutoContrast = { ...fits[fits.length - 1].fit.limits };
      setContrastFitMap((prev) => {
        const next = new Map(prev);
        for (const { datasetId, channel, fit } of fits) next.set(channelRangeKey(datasetId, channel), fit);
        return next;
      });
      applyAutoContrastFits(
        {
          scene: wasmSceneRef.current,
          loop: loopRef.current,
          session: sessionRef.current,
          auto: (datasetId) => autoContrastMapRef.current.get(datasetId) ?? true,
          following: peerStore.getState().followTarget !== null,
        },
        fits,
      );
    });
    return () => activeLoop.setAutoContrastListener(null);
  }, [activeLoop, autoContrastMapRef, setContrastFitMap, wasmSceneRef, loopRef, sessionRef, peerStore]);

  // A client that stops following fits its own limits again. The fits kept
  // arriving while it followed, so the latest ones are its current view's.
  useEffect(() => {
    let following = peerStore.getState().followTarget !== null;
    return peerStore.subscribe(() => {
      const wasFollowing = following;
      following = peerStore.getState().followTarget !== null;
      if (!wasFollowing || following) return;
      const fits: ChannelFitUpdate[] = [];
      for (const [key, fit] of contrastFitMapRef.current) {
        const parsed = parseChannelRangeKey(key);
        if (parsed) fits.push({ ...parsed, fit });
      }
      applyAutoContrastFits(
        {
          scene: wasmSceneRef.current,
          loop: loopRef.current,
          session: sessionRef.current,
          auto: (datasetId) => autoContrastMapRef.current.get(datasetId) ?? true,
          following: false,
        },
        fits,
      );
    });
  }, [peerStore, contrastFitMapRef, autoContrastMapRef, wasmSceneRef, loopRef, sessionRef]);
}
