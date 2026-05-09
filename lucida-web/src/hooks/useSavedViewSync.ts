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
}: Params): {
  applier: SavedViewApplier;
  captureBuilder: () => SavedView | null;
  trackedSendOpen: (url: string) => void;
} {
  // Construct everything lazily on first render via useState's initializer
  // (runs exactly once). Avoids the React-19 "no ref access during render"
  // lint while still letting captureBuilder + urlSync close over a stable
  // url-tracking map.
  const [bundle] = useState<SyncBundle>(() => {
    const urlByDatasetId = new Map<string, string>();
    const captureFn = (): SavedView | null => {
      const scene = getScene();
      if (!scene) return null;
      try {
        return buildCapture({ scene, urlByDatasetId });
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
      return buildCapture({ scene, urlByDatasetId: bundle.urlByDatasetId });
    } catch (e) {
      console.warn("[SavedView] capture failed:", e);
      return null;
    }
  }, [getScene, bundle.urlByDatasetId]);

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

  return {
    applier: bundle.applier,
    captureBuilder,
    trackedSendOpen,
  };
}
