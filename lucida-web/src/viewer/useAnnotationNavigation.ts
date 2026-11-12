/**
 * Going to an annotation, in two tiers. Gentle (a pin clicked on the canvas)
 * opens the thread and recenters, never touching camera, contrast, or zoom.
 * Explicit (a mention, "Go to author's view", or an `#a=` deep link) restores
 * the author's captured view, and falls back to gentle when the pin has none.
 */
import { useCallback, type RefObject } from "react";
import { applyViewportCommand } from "../applyAndSend.ts";
import type { Annotation, AnnotationOverlayHandle } from "../components/annotationDocument.ts";
import { inChannelContext, pinChannels } from "../components/annotationContext.ts";
import { resolveAnnotationDatasetId } from "../components/currentDatasetAnnotations.ts";
import { readResolvedLayers, shownChannels } from "../resolvedLayers.ts";
import { annotationCutCommand } from "../components/annotationCut.ts";
import type { Engine } from "../engine.ts";
import { useAnnotationDeepLink } from "../hooks/useAnnotationDeepLink.ts";
import { invalidateAfterViewRestore, requestRender } from "../invalidation.ts";
import type { DimensionExtentsResolver, LabelNamesResolver } from "../savedView/applier.ts";
import { restoreAnnotationView } from "../savedView/restoreAnnotationView.ts";
import type { ViewMode } from "../types.ts";
import { toast } from "../ui/toastQueue.ts";

interface Params {
  engine: Engine;
  viewMode: ViewMode;
  dimensionExtentsFor: DimensionExtentsResolver;
  labelNamesFor: LabelNamesResolver;
  /** The pins a mention or "Go to author's view" can name. */
  annotations: Annotation[];
  selectedDatasetId: string | null;
  setSelectedDatasetId: (id: string) => void;
  annotationsVisible: boolean;
  setAnnotationsVisible: (visible: boolean) => void;
  overlay2dRef: RefObject<AnnotationOverlayHandle | null>;
  overlay3dRef: RefObject<AnnotationOverlayHandle | null>;
  breakFollow: () => void;
  emitPresence: () => void;
  emitDatasetPresence: () => void;
  /** Collapses a resolved `#a=` hash to the live `#view=` form. */
  collapseDeepLinkHash: () => Promise<void>;
  /** The document version; the deep link re-checks on each bump. */
  docVersion: number;
  onDeepLinkNotFound: (notFound: boolean) => void;
}

export function useAnnotationNavigation({
  engine,
  viewMode,
  dimensionExtentsFor,
  labelNamesFor,
  annotations,
  selectedDatasetId,
  setSelectedDatasetId,
  annotationsVisible,
  setAnnotationsVisible,
  overlay2dRef,
  overlay3dRef,
  breakFollow,
  emitPresence,
  emitDatasetPresence,
  collapseDeepLinkHash,
  docVersion,
  onDeepLinkNotFound,
}: Params) {
  // The gentle tier: bring the pin on-context by cutting the plane it lies on,
  // matching its T, and showing a channel it was placed on.
  const gentleOnContext = useCallback((pin: Annotation) => {
    const scene = engine.scene();
    if (!scene) return;
    const datasetId = resolveAnnotationDatasetId(scene, selectedDatasetId);
    const targetT = pin.t ?? 0;
    let contextChanged = false;
    const cut = datasetId ? annotationCutCommand(scene, datasetId, pin) : null;
    if (cut) {
      applyViewportCommand(scene, cut);
      contextChanged = true;
    }
    if (targetT !== scene.t()) {
      applyViewportCommand(scene, { type: "set_t", t: targetT });
      contextChanged = true;
    }
    const layer = datasetId ? readResolvedLayers(scene, scene.active_view()).get(datasetId) : undefined;
    const placement = pinChannels(pin);
    if (datasetId && layer && !inChannelContext(placement, shownChannels(layer))) {
      // A pin placed on a solo gets that solo back; one placed in the
      // composite gets the composite back.
      const solo = placement.length === 1 && placement[0] < layer.channel_count ? placement[0] : null;
      applyViewportCommand(scene, { type: "set_channel_solo", dataset_id: datasetId, channel: solo });
      contextChanged = true;
    }
    if (contextChanged) {
      requestRender(engine.loop(), "annotation_context");
      breakFollow();
      emitPresence();
      emitDatasetPresence();
    }
  }, [engine, selectedDatasetId, breakFollow, emitPresence, emitDatasetPresence]);

  // Focus a pin in whichever overlay is mounted for a given view mode. The
  // mode is passed in because a just-restored 3D camera may have flipped it
  // out from under this render's `viewMode`.
  const focusPinForMode = useCallback((pinId: string, mode: ViewMode) => {
    const handle = mode === "3d" ? overlay3dRef.current : overlay2dRef.current;
    handle?.focusPin(pinId);
  }, [overlay2dRef, overlay3dRef]);

  // Focus once the overlay can take it: a frame later when the annotations
  // were hidden or the mode is about to remount the overlay.
  const focusWhenShown = useCallback((pinId: string, mode: ViewMode, remounting: boolean) => {
    const focus = () => focusPinForMode(pinId, mode);
    if (!annotationsVisible) setAnnotationsVisible(true);
    if (remounting || !annotationsVisible) {
      requestAnimationFrame(focus);
    } else {
      focus();
    }
  }, [annotationsVisible, setAnnotationsVisible, focusPinForMode]);

  // The explicit tier: restore the author's camera (switching 2D/3D mode before
  // focusing), z-slab/t/c, and display through `restoreAnnotationView`, which
  // issues only local viewport commands, then recenter on the pin.
  const restoreCapturedView = useCallback((pin: Annotation, datasetIdOverride?: string) => {
    const scene = engine.scene();
    if (!scene || !pin.view) {
      gentleOnContext(pin);
      focusWhenShown(pin.id, viewMode, false);
      return;
    }

    // Clamp against the pin's own dataset. A deep link passes it explicitly;
    // otherwise resolve it the way the pin set was read. With no selection,
    // `selectedDatasetId ?? ""` would clamp against the `[1,1,1]` sentinel and
    // collapse a deep Z to plane 0, so an unresolvable dataset passes
    // `undefined` and the clamp is skipped.
    const pinDatasetId =
      datasetIdOverride ?? resolveAnnotationDatasetId(scene, selectedDatasetId) ?? undefined;
    const result = restoreAnnotationView({
      scene,
      view: pin.view,
      datasetId: pinDatasetId,
      dimensionExtentsFor,
      labelNamesFor,
    });

    breakFollow();
    emitPresence();
    emitDatasetPresence();
    invalidateAfterViewRestore(engine.loop(), "annotation_view_restore");

    if (result.notice) toast({ title: result.notice, tone: "info" });
    focusWhenShown(pin.id, result.viewMode, result.cameraModeChanged);
  }, [
    engine, viewMode, dimensionExtentsFor, labelNamesFor, selectedDatasetId,
    gentleOnContext, focusWhenShown, breakFollow, emitPresence, emitDatasetPresence,
  ]);

  // A mention jump restores the author's view, or recenters gently when the
  // pin has none. An unknown pin still gets a focus, a no-op if no overlay
  // holds it, so a stale id never wedges navigation.
  const navigateToMention = useCallback((pinId: string) => {
    const pin = annotations.find((p) => p.id === pinId);
    if (!pin) {
      focusWhenShown(pinId, viewMode, false);
      return;
    }
    restoreCapturedView(pin);
  }, [annotations, restoreCapturedView, focusWhenShown, viewMode]);

  // "Go to author's view" in a pin's thread.
  const goToAuthorView = useCallback((pinId: string) => {
    const pin = annotations.find((p) => p.id === pinId);
    if (!pin) return;
    restoreCapturedView(pin);
  }, [annotations, restoreCapturedView]);

  // The pin may live on an unselected dataset, which the restore selects
  // first and gives a frame to land.
  const restoreDeepLinkPin = useCallback(
    (pin: Annotation, datasetId: string, onRestored: () => void) => {
      // Collapse `#a=` to `#view=` only after the restore, in the same frame, so
      // the URL captures the restored camera rather than the stale one.
      const run = () => {
        restoreCapturedView(pin, datasetId);
        onRestored();
      };
      if (selectedDatasetId !== datasetId) {
        setSelectedDatasetId(datasetId);
        requestAnimationFrame(run);
      } else {
        run();
      }
    },
    [restoreCapturedView, selectedDatasetId, setSelectedDatasetId],
  );

  const collapseHash = useCallback(() => {
    void collapseDeepLinkHash();
  }, [collapseDeepLinkHash]);
  // Re-checked on every document version, so the restore runs on the first
  // one where the pin is readable, not at scene bootstrap while the document
  // is still empty.
  useAnnotationDeepLink({
    getScene: engine.scene,
    docVersion,
    onRestore: restoreDeepLinkPin,
    onCollapseHash: collapseHash,
    onNotFound: onDeepLinkNotFound,
  });

  return { navigateToMention, goToAuthorView };
}
