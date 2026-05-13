// Wires the savedView module suite into the React tree:
//   - URL→DatasetId tracking (populated on local opens; resolved on
//     incoming DatasetOpened broadcasts via blake3-prefix derivation).
//   - SavedViewApplier (recipient apply orchestrator).
//   - UrlSync (debounced URL writes + bootstrap + popstate).
//
// Mounted in App.tsx after the bridge hook so it can hand the applier
// `sendCommand` + `sendOpenRemoteDataset` directly. Subscribes to scene
// epochs to drive the debounced URL writes — see
// `wiki/systems/subsystems/scene-state-and-epochs.md`.

import { useCallback, useEffect, useState } from "react";
import type { WasmScene } from "lucida-core";
import { dataset_id_for_url } from "lucida-core";
import { SavedViewApplier } from "../savedView/applier.ts";
import { UrlSync } from "../savedView/urlSync.ts";
import { buildCapture } from "../savedView/captureBuilder.ts";
import type { SavedView } from "../savedView/types.ts";
import type { RenderLoop } from "../renderLoop.ts";
import { bumpSettingsGeneration } from "../tickCommon.ts";

interface Params {
  /** Returns the live `WasmScene`, or null if not yet loaded. */
  getScene: () => WasmScene | null;
  /** Bridge functions sourced from `useBridge`. */
  sendOpenRemoteDataset: (url: string) => void;
  sendCommand: (json: string) => void;
  /** Tick that increments whenever the scene mutates locally — used to
   * drive URL re-encoding. We piggyback on the existing
   * `remoteDocumentVersion` + `datasetsVersion` counters. */
  changeTick: number;
  /** Debounce override for tests. Default 350. */
  debounceMs?: number;
  /** Callback fired after every successful apply; resolves the
   *  selected-dataset wrinkle ([[wiki/queue]] 2026-05-07, option c) by
   *  letting App.tsx re-target `selectedDatasetId` at the first visible
   *  dataset on apply (so dimension/contrast controls operate on
   *  something the user can see). */
  onApplyResult?: (firstVisibleDatasetId: string | null) => void;
  /** Render loop ref. The applier writes to WASM only; without marking
   *  interactive+residency dirty, the RAF-pull-based loop sits idle
   *  until the next user input (Bug #2 root cause). */
  loopRef: React.RefObject<RenderLoop | null>;
  /** React-side dim mirrors. The applier writes set_c/set_t/set_z_range
   *  to WASM; without these the C/T/Z sliders stay stale (e.g. bookmark
   *  saved on ch2 opens with the C slider showing 0; Bug #3 root cause). */
  setC: React.Dispatch<React.SetStateAction<number>>;
  setT: React.Dispatch<React.SetStateAction<number>>;
  setZ: React.Dispatch<React.SetStateAction<number>>;
  setViewMode: React.Dispatch<React.SetStateAction<"2d" | "3d">>;
  /** Per-dataset auto-contrast preference (read for capture, restored on
   *  apply). Lives in `useDatasetSettings.autoContrastMap`. Without this
   *  round-trip, recipient's auto-contrast immediately overwrites the
   *  captured contrast values via the intensity batcher. */
  autoContrastMapRef: React.RefObject<Map<string, boolean>>;
  setAutoContrastMap: React.Dispatch<React.SetStateAction<Map<string, boolean>>>;
}

interface SyncBundle {
  applier: SavedViewApplier;
  urlSync: UrlSync;
  urlByDatasetId: Map<string, string>;
}

export function useSavedViewSync({
  getScene,
  sendOpenRemoteDataset,
  sendCommand,
  changeTick,
  debounceMs,
  onApplyResult,
  loopRef,
  setC,
  setT,
  setZ,
  setViewMode,
  autoContrastMapRef,
  setAutoContrastMap,
}: Params): {
  applier: SavedViewApplier;
  captureBuilder: () => SavedView | null;
  trackedSendOpen: (url: string) => void;
  /** Schedule a debounced URL write. App.tsx wraps this into the
   *  `emitPresence`/`emitDatasetPresence` callbacks so every viewport
   *  mutation co-taps the URL (Bug #1 fix). Stable identity. */
  notifyChange: () => void;
} {
  // Construct everything lazily on first render via useState's initializer
  // (runs exactly once). The captured `autoContrastMapRef` is read at
  // call-time inside captureFn (which fires from event handlers), not
  // during the initializer pass — so the new "passing a ref to a function
  // may read its value during render" rule is a false positive here.
  // eslint-disable-next-line react-hooks/refs
  const [bundle] = useState<SyncBundle>(() => {
    const urlByDatasetId = new Map<string, string>();
    const captureFn = (): SavedView | null => {
      const scene = getScene();
      if (!scene) return null;
      try {
        return buildCapture({
          scene,
          urlByDatasetId,
          autoContrastByDatasetId: autoContrastMapRef.current ?? undefined,
        });
      } catch (e) {
        console.warn("[SavedView] capture failed:", e);
        return null;
      }
    };
    const applier = new SavedViewApplier(
      {
        sendOpenRemoteDataset: (url: string) => {
          urlByDatasetId.set(dataset_id_for_url(url), url);
          sendOpenRemoteDataset(url);
        },
        sendCommand,
      },
      getScene,
      dataset_id_for_url,
    );
    const urlSync = new UrlSync(captureFn, applier, { debounceMs });
    return { applier, urlSync, urlByDatasetId };
  });

  // Public capture builder that closes over the same map.
  const captureBuilder = useCallback((): SavedView | null => {
    const scene = getScene();
    if (!scene) return null;
    try {
      return buildCapture({
        scene,
        urlByDatasetId: bundle.urlByDatasetId,
        autoContrastByDatasetId: autoContrastMapRef.current ?? undefined,
      });
    } catch (e) {
      console.warn("[SavedView] capture failed:", e);
      return null;
    }
  }, [getScene, bundle.urlByDatasetId, autoContrastMapRef]);

  // Wrap user-facing sendOpenRemoteDataset so URL→DatasetId tracking
  // catches every local open (FileBrowser, URL bar, applier).
  const trackedSendOpen = useCallback((url: string) => {
    bundle.urlByDatasetId.set(dataset_id_for_url(url), url);
    sendOpenRemoteDataset(url);
  }, [bundle.urlByDatasetId, sendOpenRemoteDataset]);

  // Mount popstate listener; tear it down on unmount.
  useEffect(() => {
    bundle.urlSync.start();
    return () => bundle.urlSync.destroy();
  }, [bundle.urlSync]);

  // Bootstrap: when the scene first becomes available, decode and apply
  // any `#view=…` payload. Idempotent — UrlSync.bootstrap is a no-op if
  // there's no hash, and the applier rejects re-entry.
  useEffect(() => {
    const scene = getScene();
    if (!scene) return;
    bundle.urlSync.bootstrap().catch((e) => {
      console.warn("[SavedView] bootstrap failed:", e);
    });
    // Only run once per scene becoming available — `getScene` returning
    // a non-null result is the trigger, and the applier guards re-entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle.urlSync, !!getScene()]);

  // Schedule a debounced URL write whenever the scene changes.
  useEffect(() => {
    bundle.urlSync.notifyChange();
  }, [bundle.urlSync, changeTick]);

  // Selected-dataset wrinkle (option c): subscribe to the applier's
  // post-apply summary and forward to the parent so it can re-target
  // `selectedDatasetId` at the first visible dataset. Subscription
  // installs once per applier and lifts/relifts when the consumer
  // changes its callback identity.
  useEffect(() => {
    if (!onApplyResult) return;
    return bundle.applier.subscribeApplyResult((r) => {
      onApplyResult(r.firstVisibleDatasetId);
    });
  }, [bundle.applier, onApplyResult]);

  // Apply-complete: refresh the render loop (Bug #2) and push post-apply
  // C/T/Z/viewMode back to React state (Bug #3). The applier writes to
  // WASM only; without this the RAF loop sits idle until the next user
  // input and the slider mirrors stay stale. Mirrors the bridge's
  // follow/presence-update flow (useBridge.ts onPresenceUpdate / onFollowChanged).
  useEffect(() => {
    return bundle.applier.subscribeApplyComplete((view) => {
      const scene = getScene();
      if (!scene) return;
      try {
        setZ(scene.z());
        setT(scene.t());
        setC(scene.c());
        setViewMode(scene.camera_mode() !== "slice" ? "3d" : "2d");
      } catch (e) {
        console.warn("[SavedView] post-apply state read failed:", e);
      }
      // Restore client-only auto-contrast preference. Without this, the
      // recipient's intensity batcher (default `true` per dataset)
      // immediately overwrites the captured contrast values. Per the
      // capture rule (defaults stripped), absent entries mean `true`;
      // explicit `false` entries are the meaningful ones to restore.
      if (view.auto_contrast) {
        setAutoContrastMap((prev) => {
          let changed = false;
          const next = new Map(prev);
          for (const [id, flag] of Object.entries(view.auto_contrast!)) {
            if (next.get(id) !== flag) {
              next.set(id, flag);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }
      bumpSettingsGeneration();
      loopRef.current?.markInteractiveDirty("savedview_apply");
      loopRef.current?.markResidencyDirty("savedview_apply");
    });
  }, [bundle.applier, getScene, loopRef, setC, setT, setZ, setViewMode, setAutoContrastMap]);

  // Stable notifyChange: App.tsx wraps emitPresence/emitDatasetPresence
  // so every viewport mutation co-taps the URL (Bug #1 fix). Forwards
  // to the underlying UrlSync; identity is stable across renders.
  const notifyChange = useCallback(() => {
    bundle.urlSync.notifyChange();
  }, [bundle.urlSync]);

  return {
    applier: bundle.applier,
    captureBuilder,
    trackedSendOpen,
    notifyChange,
  };
}
