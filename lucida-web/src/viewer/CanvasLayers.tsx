/**
 * What draws on and over the canvas: the 2D or 3D viewer, the annotation
 * overlays and draft, the peer cursors, and the debug overlays. The view mode
 * and selectors come from the scene store; the engine supplies the scene,
 * client, canvas, loop, and session.
 */
import { lazy, Suspense, useCallback, type RefObject } from "react";
import { AnnotationDraftOverlay } from "../components/AnnotationDraftOverlay.tsx";
import { AnnotationOverlay } from "../components/AnnotationOverlay.tsx";
import { AnnotationOverlay3D } from "../components/AnnotationOverlay3D.tsx";
import type { AnnotationOverlayHandle } from "../components/annotationDocument.ts";
import type { AnnotationDraft } from "../components/annotationDraft.ts";
import type { Tool } from "../components/annotationTool.ts";
import type { ClientPoint } from "../components/cameraProjection.ts";
import type { MentionCandidate } from "../components/annotationMentions.ts";
import { PeerCursorLayer } from "../components/PeerCursorLayer.tsx";
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
}: Props) {
  const engine = useEngine();
  const { scene, render, sessionRef } = useEngineParts();
  const { viewMode, cameraMode, z, t, layers } = useSceneView(engine.store);

  const openContextMenu2d = useCallback((at: ClientPoint) => overlay2dRef.current?.openContextMenu(at), [overlay2dRef]);
  const openContextMenu3d = useCallback((at: ClientPoint) => overlay3dRef.current?.openContextMenu(at), [overlay3dRef]);
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
  const overlays = hasDatasets && selectedDatasetId && wasmScene && canvas
    ? { datasetId: selectedDatasetId, canvas }
    : null;
  // The overlays draw the selected layer's pins, so its shown channels decide
  // which pins are in context.
  const viewContext = {
    z,
    t,
    channels: shownChannels(selectedDatasetId ? layers.get(selectedDatasetId) : undefined),
  };
  return (
    <>
      {viewers && viewMode === "2d" && (
        <SliceViewer
          session={viewers.session}
          scene={viewers.scene}
          datasets={datasets}
          client={viewers.client}
          canvas={viewers.canvas}
          remoteDocumentVersion={remoteDocumentVersion}
          emitPresence={emitPresence}
          breakFollow={breakFollow}
          sendCursor={sendCursor}
          loopRef={render.loopRef}
          onLoopChange={render.setActiveLoop}
          annotationDatasetId={selectedDatasetId}
          tool={tool}
          myId={annotationAuthor}
          sendCommand={sendCommand}
          onDocumentChanged={onDocumentChanged}
          annotationDraftRef={annotationDraftRef}
          onLongPress={openContextMenu2d}
        />
      )}
      {overlays && viewMode === "2d" && (
        <>
          <AnnotationDraftOverlay draftRef={annotationDraftRef} visible={annotationsVisible} />
          <AnnotationOverlay
            ref={overlay2dRef}
            datasetId={overlays.datasetId}
            wasmSceneRef={scene.wasmSceneRef}
            canvas={overlays.canvas}
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
        </>
      )}
      {viewers && viewMode === "3d" && (
        <VolumeViewer
          session={viewers.session}
          scene={viewers.scene}
          datasets={datasets}
          client={viewers.client}
          canvas={viewers.canvas}
          remoteDocumentVersion={remoteDocumentVersion}
          emitPresence={emitPresence}
          breakFollow={breakFollow}
          sendCursor={sendCursor}
          cameraMode={cameraMode}
          loopRef={render.loopRef}
          onLoopChange={render.setActiveLoop}
          annotationDatasetId={selectedDatasetId}
          tool={tool}
          myId={annotationAuthor}
          sendCommand={sendCommand}
          onDocumentChanged={onDocumentChanged}
          annotationDraftRef={annotationDraftRef}
          onLongPress={openContextMenu3d}
        />
      )}
      {overlays && viewMode === "3d" && (
        <>
          <AnnotationDraftOverlay draftRef={annotationDraftRef} visible={annotationsVisible} />
          <AnnotationOverlay3D
            ref={overlay3dRef}
            datasetId={overlays.datasetId}
            wasmSceneRef={scene.wasmSceneRef}
            canvas={overlays.canvas}
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
        </>
      )}
      <PeerCursorLayer
        peerStore={peerStore}
        viewMode={viewMode}
        z={z}
        t={t}
        wasmSceneRef={scene.wasmSceneRef}
        clientReady={render.clientReady}
        wasmReady={scene.wasmReady}
        canvasSize={canvasSize}
      />
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
