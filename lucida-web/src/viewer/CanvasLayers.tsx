/**
 * What draws on and over the canvas: the 2D or 3D viewer, the annotation
 * overlays and draft, the pixel readout and the crosshairs of the point under
 * the pointer, the peer cursors, and the debug overlays. The view mode and
 * selectors come from the scene store; the engine supplies the scene, client,
 * canvas, loop, and session.
 */
import { lazy, Suspense, useCallback, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
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
import { ScaleBar } from "./ScaleBar.tsx";
import { useScaleBarShown } from "./scaleBar.ts";
import { ViewPanes } from "./ViewPanes.tsx";
import { ViewOverlays } from "./ViewOverlays.tsx";
import { HOME_KEYS, useViewHome } from "./useViewHome.ts";
import { FourUpPlanes, useFollowTile } from "./planeLines.ts";
import { Hover } from "./hover.ts";
import { comparisonActions, placedByHandNote, readLineUpByHand } from "../comparison.ts";
import type { ViewPane } from "../sceneStore.ts";
import type { SpatialAxis } from "../renderer/slicePlane.ts";
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
  /** Stand the active view at position `index` of its grid along `axis`, as a scrub does. */
  onAxisChange: (axis: SpatialAxis, index: number) => void;
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
  onAxisChange,
  userTransforms,
}: Props) {
  const engine = useEngine();
  const { scene, render, sessionRef } = useEngineParts();
  const { viewMode, zPlace, t, layers, views, maximized, links, layout } = useSceneView(engine.store);
  // Each view's settle and coverage, with several views.
  const settles = useSyncExternalStore(viewSettleSignal.subscribe, viewSettleSignal.get);
  const scaleBars = useScaleBarShown();

  // A finger's long press stands for both a right-click and a hover.
  const readoutRef = useRef<PixelReadoutHandle>(null);
  const [hover] = useState(() => new Hover());
  const openContextMenu2d = useCallback((at: ClientPoint) => {
    overlay2dRef.current?.openContextMenu(at);
    readoutRef.current?.pressAt(at);
  }, [overlay2dRef]);
  const openContextMenu3d = useCallback((at: ClientPoint) => {
    overlay3dRef.current?.openContextMenu(at);
    readoutRef.current?.pressAt(at);
  }, [overlay3dRef]);
  const onViewportChanged = useCallback(() => requestRender(engine.loop(), "annotation_viewport"), [engine]);
  const comparison = useMemo(() => comparisonActions(engine.scene, engine.loop), [engine]);

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
  const home = useViewHome({ viewers, loopRef: render.loopRef, breakFollow, emitPresence });
  // The one loop draws every view; a change of mode or layout keeps it.
  useViewerLoop(
    viewers && { session: viewers.session, datasets, client: viewers.client, canvas: viewers.canvas },
    render.loopRef,
    render.setActiveLoop,
    remoteDocumentVersion,
  );
  const [panesRoot, setPanesRoot] = useState<HTMLDivElement | null>(null);
  const planes = useMemo(() => (wasmScene ? new FourUpPlanes(wasmScene, engine.store) : null), [wasmScene, engine.store]);
  useFollowTile(planes, panesRoot, layout === "four_up");
  const overlays = hasDatasets && selectedDatasetId && wasmScene && canvas
    ? { datasetId: selectedDatasetId }
    : null;
  // The overlays draw the selected layer's pins, which sit on its own planes,
  // so its plane under the cut and its shown channels decide which pins are in
  // context.
  const selectedLayer = selectedDatasetId ? layers.get(selectedDatasetId) : undefined;
  const viewContext = {
    z: selectedLayer?.z_range.start ?? 0,
    t,
    channels: shownChannels(selectedLayer),
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
            zPlace={zPlace}
            t={t}
            wasmSceneRef={scene.wasmSceneRef}
            clientReady={render.clientReady}
            wasmReady={scene.wasmReady}
            canvasSize={canvasSize}
            surface={surface}
          />
        )}
        {scaleBars && viewers && <ScaleBar scene={viewers.scene} surface={surface} />}
      </>
    );
  };
  return (
    <>
      <ViewPanes views={views} maximized={maximized} actions={viewLayout} rootRef={setPanesRoot}>
        {paneContent}
      </ViewPanes>
      {hasDatasets && (
        <ViewOverlays
          views={views}
          store={engine.store}
          actions={comparison}
          nameOf={nameOf}
          activate={viewLayout.activate}
          coverageOf={(view) => settles.find((settle) => settle.view === view)}
          byHand={(a, b) => (wasmScene ? placedByHandNote(readLineUpByHand(wasmScene, a, b), nameOf) : null)}
          linkNotices={links?.notices}
          planes={planes}
          dragPlane={(view, axis, fraction) => {
            const index = planes?.positionAt(view, axis, fraction) ?? null;
            if (index !== null) onAxisChange(axis, index);
          }}
          hover={hover}
          home={home ? { run: home, keys: HOME_KEYS } : undefined}
        />
      )}
      {viewers && panesRoot && (
        <PixelReadout
          ref={readoutRef}
          canvas={viewers.canvas}
          eventRoot={panesRoot}
          client={viewers.client}
          scene={viewers.scene}
          datasets={datasets}
          layers={layers}
          hover={hover}
          trace={engine.loop}
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
