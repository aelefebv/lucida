/**
 * What draws on and over the canvas: the 2D or 3D viewer, the annotation
 * overlays and draft, the pixel readout, the peer cursors, and the debug
 * overlays. The view mode and selectors come from the scene store; the engine
 * supplies the scene, client, canvas, loop, and session.
 */
import { lazy, Suspense, useCallback, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { viewSettleSignal } from "../pipeline/viewSettle.ts";
import { AnnotationDraftOverlay } from "../components/AnnotationDraftOverlay.tsx";
import { AnnotationOverlay } from "../components/AnnotationOverlay.tsx";
import { AnnotationOverlay3D } from "../components/AnnotationOverlay3D.tsx";
import type { AnnotationOverlayHandle } from "../components/annotationDocument.ts";
import type { AnnotationDraft } from "../components/annotationDraft.ts";
import type { Tool } from "../components/annotationTool.ts";
import type { ClientPoint, ViewSurface } from "../components/cameraProjection.ts";
import type { MentionCandidate } from "../components/annotationMentions.ts";
import { MoveScaleOverlay } from "../components/MoveScaleOverlay.tsx";
import { PeerCursorLayer } from "../components/PeerCursorLayer.tsx";
import { PixelReadout, type PixelReadoutHandle } from "../components/PixelReadout.tsx";
import { SliceViewer } from "../components/SliceViewer.tsx";
import { VolumeViewer } from "../components/VolumeViewer.tsx";
import { useEngine } from "../engine.ts";
import type { PeerStore } from "../peerStore.ts";
import { useSceneView } from "../hooks/useSceneView.ts";
import { shownChannels } from "../resolvedLayers.ts";
import { requestRender } from "../invalidation.ts";
import type { CanvasSize } from "../shell/CanvasStage.tsx";
import type { DatasetState } from "../types.ts";
import { useEngineParts } from "./engineParts.ts";
import { useViewerLoop } from "./useViewerLoop.ts";
import { ViewPanes } from "./ViewPanes.tsx";
import { WithheldNotice } from "./WithheldNotice.tsx";
import type { ViewPane } from "../sceneStore.ts";
import type { ViewLayoutActions } from "../viewLayout.ts";
import type { UserTransformActions } from "../hooks/useUserTransforms.ts";

// Code-split: mounted only when an overlay is on or a radius preview is being
// dragged.
const DebugOverlays = lazy(() =>
  import("../debug/DebugOverlays.tsx").then((m) => ({ default: m.DebugOverlays })),
);

interface Props {
  /** The open datasets, the live map the render loop reads. */
  datasets: Map<string, DatasetState>;
  /** Whether a dataset has ever registered; the viewers wait for one. */
  hasDatasets: boolean;
  selectedDatasetId: string | null;
  tool: Tool;
  annotationsVisible: boolean;
  /** The browser-persisted annotation author, not the connection's id. */
  annotationAuthor: string;
  remoteDocumentVersion: number;
  onDocumentChanged: () => void;
  emitPresence: () => void;
  breakFollow: () => void;
  sendCursor: (position: [number, number] | null) => void;
  sendCommand: (json: string) => void;
  peerStore: PeerStore;
  overlay2dRef: RefObject<AnnotationOverlayHandle | null>;
  overlay3dRef: RefObject<AnnotationOverlayHandle | null>;
  annotationDraftRef: RefObject<AnnotationDraft | null>;
  mentionCandidates: MentionCandidate[];
  onGoToAuthorView: (pinId: string) => void;
  canvasSize: CanvasSize;
  showDebugOverlays: boolean;
  /** What a press in a view calls to make it the active view. */
  viewLayout: ViewLayoutActions;
  /** What the move tool places the selected layer with. */
  userTransforms: UserTransformActions;
}

export function CanvasLayers({
  datasets,
  hasDatasets,
  selectedDatasetId,
  tool,
  annotationsVisible,
  annotationAuthor,
  remoteDocumentVersion,
  onDocumentChanged,
  emitPresence,
  breakFollow,
  sendCursor,
  sendCommand,
  peerStore,
  overlay2dRef,
  overlay3dRef,
  annotationDraftRef,
  mentionCandidates,
  onGoToAuthorView,
  canvasSize,
  showDebugOverlays,
  viewLayout,
  userTransforms,
}: Props) {
  const engine = useEngine();
  const { scene, render, sessionRef } = useEngineParts();
  const { viewMode, z, t, layers, views, maximized } = useSceneView(engine.store);
  // Each view's settle and coverage, with several views.
  const settles = useSyncExternalStore(viewSettleSignal.subscribe, viewSettleSignal.get);

  // A finger's long press stands for both a right-click and a hover.
  const readoutRef = useRef<PixelReadoutHandle>(null);
  const openContextMenu2d = useCallback((at: ClientPoint) => {
    overlay2dRef.current?.openContextMenu(at);
    readoutRef.current?.pressAt(at);
  }, [overlay2dRef]);
  const openContextMenu3d = useCallback((at: ClientPoint) => {
    overlay3dRef.current?.openContextMenu(at);
    readoutRef.current?.pressAt(at);
  }, [overlay3dRef]);
  const onViewportChanged = useCallback(() => requestRender(engine.loop(), "annotation_viewport"), [engine]);

  // The viewers take the live session, scene, and canvas as values. The
  // states above re-render this when any of them arrives.
  /* eslint-disable react-hooks/refs */
  const session = sessionRef.current;
  const canvas = render.canvasRef.current;
  const wasmScene = scene.wasmScene;
  const client = render.client;
  const viewers = hasDatasets && wasmScene && client && session && canvas
    ? { scene: wasmScene, client, session, canvas }
    : null;
  // The one loop draws every view; a change of mode or layout keeps it.
  useViewerLoop(
    viewers && { session: viewers.session, datasets, client: viewers.client, canvas: viewers.canvas },
    render.loopRef,
    render.setActiveLoop,
    remoteDocumentVersion,
  );
  const [panesRoot, setPanesRoot] = useState<HTMLDivElement | null>(null);
  const overlays = hasDatasets && selectedDatasetId && wasmScene && canvas
    ? { datasetId: selectedDatasetId }
    : null;
  // The overlays draw the selected layer's pins, so its shown channels decide
  // which pins are in context.
  const viewContext = {
    z,
    t,
    channels: shownChannels(selectedDatasetId ? layers.get(selectedDatasetId) : undefined),
  };
  const nameOf = (datasetId: string) => datasets.get(datasetId)?.name ?? datasetId;

  // What a view's pane holds: its viewer, in its own mode; the annotations of
  // the selected layer, where the view draws it; and in the active view the
  // draft and the peer cursors. Only the active view's overlay opens a menu.
  const paneContent = (pane: ViewPane, surface: ViewSurface) => {
    const slice = pane.cameraMode === "slice";
    const pins = overlays !== null && pane.draws.includes(overlays.datasetId);
    return (
      <>
        {viewers && slice && (
          <SliceViewer
            key="slice"
            scene={viewers.scene}
            surface={surface}
            canvas={viewers.canvas}
            active={pane.active}
            emitPresence={emitPresence}
            breakFollow={breakFollow}
            sendCursor={sendCursor}
            loopRef={render.loopRef}
            annotationDatasetId={selectedDatasetId}
            tool={tool}
            myId={annotationAuthor}
            sendCommand={sendCommand}
            onDocumentChanged={onDocumentChanged}
            annotationDraftRef={annotationDraftRef}
            onLongPress={openContextMenu2d}
          />
        )}
        {viewers && !slice && (
          <VolumeViewer
            key="volume"
            scene={viewers.scene}
            surface={surface}
            canvas={viewers.canvas}
            active={pane.active}
            emitPresence={emitPresence}
            breakFollow={breakFollow}
            sendCursor={sendCursor}
            cameraMode={pane.cameraMode}
            loopRef={render.loopRef}
            annotationDatasetId={selectedDatasetId}
            tool={tool}
            myId={annotationAuthor}
            sendCommand={sendCommand}
            onDocumentChanged={onDocumentChanged}
            annotationDraftRef={annotationDraftRef}
            onLongPress={openContextMenu3d}
          />
        )}
        {overlays && pane.active && (
          <AnnotationDraftOverlay draftRef={annotationDraftRef} visible={annotationsVisible} />
        )}
        {viewers && overlays && slice && tool === "move" && userTransforms.canEdit &&
          pane.draws.includes(overlays.datasetId) && (
          <MoveScaleOverlay
            datasetId={overlays.datasetId}
            name={nameOf(overlays.datasetId)}
            scene={viewers.scene}
            surface={surface}
            actions={userTransforms}
          />
        )}
        {overlays && pins && slice && (
          <AnnotationOverlay
            ref={pane.active ? overlay2dRef : undefined}
            datasetId={overlays.datasetId}
            wasmSceneRef={scene.wasmSceneRef}
            surface={surface}
            version={remoteDocumentVersion}
            viewContext={viewContext}
            myId={annotationAuthor}
            sendCommand={sendCommand}
            onDocumentChanged={onDocumentChanged}
            onViewportChanged={onViewportChanged}
            visible={annotationsVisible}
            tool={tool}
            mentionCandidates={mentionCandidates}
            onGoToAuthorView={onGoToAuthorView}
          />
        )}
        {overlays && pins && !slice && (
          <AnnotationOverlay3D
            ref={pane.active ? overlay3dRef : undefined}
            datasetId={overlays.datasetId}
            wasmSceneRef={scene.wasmSceneRef}
            surface={surface}
            version={remoteDocumentVersion}
            viewContext={viewContext}
            myId={annotationAuthor}
            sendCommand={sendCommand}
            onDocumentChanged={onDocumentChanged}
            onViewportChanged={onViewportChanged}
            visible={annotationsVisible}
            tool={tool}
            mentionCandidates={mentionCandidates}
            onGoToAuthorView={onGoToAuthorView}
          />
        )}
        {pane.active && (
          <PeerCursorLayer
            peerStore={peerStore}
            viewMode={slice ? "2d" : "3d"}
            z={z}
            t={t}
            wasmSceneRef={scene.wasmSceneRef}
            clientReady={render.clientReady}
            wasmReady={scene.wasmReady}
            canvasSize={canvasSize}
            surface={surface}
          />
        )}
        <WithheldNotice
          withheld={pane.withheld}
          views={views}
          nameOf={nameOf}
          coverage={settles.find((settle) => settle.view === pane.id)}
        />
      </>
    );
  };
  return (
    <>
      <ViewPanes views={views} maximized={maximized} actions={viewLayout} rootRef={setPanesRoot}>
        {paneContent}
      </ViewPanes>
      {viewers && panesRoot && (
        <PixelReadout
          ref={readoutRef}
          canvas={viewers.canvas}
          eventRoot={panesRoot}
          client={viewers.client}
          scene={viewers.scene}
          datasets={datasets}
          layers={layers}
        />
      )}
      {showDebugOverlays && (
        <Suspense fallback={null}>
          <DebugOverlays
            wasmSceneRef={scene.wasmSceneRef}
            canvasRef={render.canvasRef}
            datasets={datasets}
            renderLoopRef={render.loopRef}
            cpuCache={session?.cpuCache ?? null}
            viewMode={viewMode}
          />
        </Suspense>
      )}
    </>
  );
  /* eslint-enable react-hooks/refs */
}
