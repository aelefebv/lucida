/** 2D slice viewer — delegates WebGPU rendering to a worker via RenderClient. */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { RenderClient } from "../renderer/renderClient.ts";
import { RenderLoop, type DatasetEntry } from "../renderLoop.ts";
import type { Session } from "../session.ts";
import { applyDocumentCommand, applyViewportCommand } from "../applyAndSend.ts";
import { buildAnnotationView, liveViewWithLiveZTC } from "../savedView/buildAnnotationView.ts";
import type { AnnotationDraft } from "./annotationDraft.ts";
import { LabelTooltip } from "./LabelTooltip.tsx";
import type { LabelTooltipRow } from "./labelTooltip.ts";
import { resolveLabelHover, asHoverScene } from "./resolveLabelHover.ts";

interface Props {
  z: number;
  t: number;
  c: number;
  session: Session;
  scene: WasmScene;
  datasets: Map<string, DatasetEntry>;
  client: RenderClient;
  canvas: HTMLCanvasElement;
  remoteDocumentVersion: number;
  emitPresence: () => void;
  breakFollow: () => void;
  sendCursor: (position: [number, number] | null) => void;
  loopRef: RefObject<RenderLoop | null>;
  onLoopChange: (loop: RenderLoop | null) => void;
  /** Dataset to attach a dropped pin to (annotations are scoped per dataset). */
  annotationDatasetId: string | null;
  /** Shape a shift-drag draws: a point pin, a line, or a box. */
  annotationKind: "point" | "line" | "box";
  /** Stable, browser-persisted annotation-author identity (issue #777), recorded
   * as a dropped pin's `author`. Sourced from `annotationAuthorId()`, not the
   * per-connection `bridge.myId`, so pins this browser drops stay yours across
   * leaving + rejoining a workspace. (Prop name kept as `myId`; its value/type is
   * now the string identity.) */
  myId: string;
  /** Send a wire command (already wrapped by the bridge). */
  sendCommand: (json: string) => void;
  /** Notify the parent that the document changed locally (a pin was dropped)
   * so dependent overlays re-read. Mirrors the remote-document version bump. */
  onDocumentChanged: () => void;
  /** Shared channel for the live box/line draw preview: the shift-drag writes
   * the in-progress shape here (screen-space CSS px, relative to the canvas) and
   * {@link AnnotationDraftOverlay} renders it growing under the cursor. Cleared
   * on release/cancel, when the real annotation is committed. */
  annotationDraftRef: RefObject<AnnotationDraft | null>;
}

/** Max pointer travel (CSS px) for a press+release to count as a click, not a drag. */
const PIN_CLICK_SLOP = 4;

/** How long the pointer must sit still before a label hover resolves (ms). Long
 * enough that a moving cursor never fires a pick per frame, short enough to feel
 * responsive once the pointer settles. */
const HOVER_SETTLE_MS = 150;

/** Resolved label tooltip content + its cursor position (CSS px, relative to the
 * canvas). `null` when nothing is hovered / the pick is background or hidden. */
interface HoverTooltip {
  x: number;
  y: number;
  name: string;
  value: number;
  rows: LabelTooltipRow[];
}

export function SliceViewer({ z, t, c, session, scene, datasets, client, canvas, remoteDocumentVersion, emitPresence, breakFollow, sendCursor, loopRef: parentLoopRef, onLoopChange, annotationDatasetId, annotationKind, myId, sendCommand, onDocumentChanged, annotationDraftRef }: Props) {
  const loopRef = useRef<RenderLoop | null>(null);
  const [dragging, setDragging] = useState(false);
  const lastPos = useRef({ x: 0, y: 0 });

  // ── Label hover tooltip ──────────────────────────────────────────
  // Resolved content shown by <LabelTooltip>; null hides it.
  const [tooltip, setTooltip] = useState<HoverTooltip | null>(null);
  // Debounce timer for the hover settle (cleared on every move / gesture start).
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic token so a slow async pick reply that lands after the pointer has
  // moved on (or left) is discarded instead of flashing a stale tooltip.
  const hoverToken = useRef(0);
  // Latest scene/dataset for the settle handler without re-binding pointer
  // listeners on every doc change (same ref-mirror pattern as the pin refs).
  const sceneRef = useRef(scene);
  const clientRef = useRef(client);
  // Press context for distinguishing a pin-drop click from a pan drag, and for
  // anchoring a line/box draw at the press point. `world` is the start vertex.
  const pressStart = useRef<{ x: number; y: number; pin: boolean; world: [number, number] } | null>(null);

  // Mirror placement props into refs so the pointer handlers (which depend on
  // `canvas` only, to avoid re-binding listeners on every doc change) read the
  // latest values without stale closures. `zRef`/`tRef`/`cRef` carry the current
  // slice/timepoint/channel so a dropped pin records its Z/T/C (issue #779)
  // without re-binding the handlers on every slice change.
  const annotationDatasetIdRef = useRef(annotationDatasetId);
  const annotationKindRef = useRef(annotationKind);
  const zRef = useRef(z);
  const tRef = useRef(t);
  const cRef = useRef(c);
  const myIdRef = useRef(myId);
  const sendCommandRef = useRef(sendCommand);
  const onDocumentChangedRef = useRef(onDocumentChanged);
  // Keep every mirror current AFTER each commit rather than during render: the
  // handlers (and the render loop) read these refs only in async contexts (a
  // pointer event, a RAF tick), so refreshing them post-commit — with no
  // dependency array, so it runs after every render — delivers the same latest
  // value to those reads while keeping render itself a pure, side-effect-free
  // pass (no ref writes during render).
  useEffect(() => {
    annotationDatasetIdRef.current = annotationDatasetId;
    annotationKindRef.current = annotationKind;
    zRef.current = z;
    tRef.current = t;
    cRef.current = c;
    myIdRef.current = myId;
    sendCommandRef.current = sendCommand;
    onDocumentChangedRef.current = onDocumentChanged;
    sceneRef.current = scene;
    clientRef.current = client;
  });

  // Create/start render loop. Deliberately omits `datasets` (live mutable
  // Map shared with the parent — RenderLoop reads it each frame),
  // `onLoopChange` (stable parent callback), and `parentLoopRef` (a ref).
  // Re-creating the loop on those would tear down GPU state every frame.
  useEffect(() => {
    const loop = new RenderLoop({ session, datasets, client, canvas, mode: "slice" });
    loopRef.current = loop;
    parentLoopRef.current = loop;
    loop.start();
    onLoopChange(loop);
    return () => {
      loop.stop();
      parentLoopRef.current = null;
      onLoopChange(null);
    };
  }, [session, client, canvas]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loopRef.current?.setSliceParams(z, t, c);
  }, [z, t, c, scene, client, canvas]);

  useEffect(() => {
    loopRef.current?.markInteractiveDirty();
  }, [remoteDocumentVersion]);

  /** Convert a pointer event to 2D world coords (inverse of the camera). */
  const eventToWorld = useCallback(
    (e: PointerEvent): [number, number] => {
      const dpr = devicePixelRatio;
      const rect = canvas.getBoundingClientRect();
      const cursorX = (e.clientX - rect.left) * dpr;
      const cursorY = (e.clientY - rect.top) * dpr;
      const zoom = scene.zoom();
      const centerArr = scene.center();
      const halfW = (canvas.clientWidth * dpr) / 2;
      const halfH = (canvas.clientHeight * dpr) / 2;
      return [(cursorX - halfW) / zoom + centerArr[0], (cursorY - halfH) / zoom + centerArr[1]];
    },
    [canvas, scene],
  );

  // Cancel any pending hover settle and hide the tooltip. Bumps the token so a
  // late async reply for the cancelled hover is ignored.
  const cancelHover = useCallback(() => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    hoverToken.current++;
    setTooltip(null);
  }, []);

  // Resolve the label under the cursor (physical-pixel screen coords) and show a
  // tooltip iff a shown, effectively-visible label reports a non-zero id there.
  // The gating/pick logic lives in the pure `resolveLabelHover` (unit-tested);
  // this wrapper feeds it the current scene + worker sampler and guards the
  // async reply with a token so a settle for a since-moved / since-left cursor
  // never flashes a stale tooltip.
  const resolveHover = useCallback(
    async (screenX: number, screenY: number, cssX: number, cssY: number) => {
      const token = ++hoverToken.current;
      const sc = sceneRef.current;
      const cl = clientRef.current;
      const datasetId = annotationDatasetIdRef.current;
      if (!datasetId) {
        setTooltip(null);
        return;
      }
      const resolved = await resolveLabelHover(
        asHoverScene(sc),
        (ds, labelIndex, voxel, primaryShape) =>
          cl.sampleLabelValue(ds, labelIndex, voxel, primaryShape),
        datasetId,
        screenX,
        screenY,
      );
      // The pointer moved / left (or another settle started) while we awaited.
      if (token !== hoverToken.current) return;
      setTooltip(
        resolved
          ? { x: cssX, y: cssY, name: resolved.name, value: resolved.value, rows: resolved.rows }
          : null,
      );
    },
    [],
  );

  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      // Shift-press begins an annotation draw (a point on a click, or a
      // line/box from this anchor to the release point). A plain press begins a
      // pan drag, exactly as before. We record the press point in world space so
      // a line/box can use it as its first vertex regardless of pan/zoom since.
      const pin = e.shiftKey;
      pressStart.current = { x: e.clientX, y: e.clientY, pin, world: eventToWorld(e) };
      // A shift-press never pans — its drag draws the shape (or stays a click
      // for a point). A plain press pans as before.
      setDragging(!pin);
      lastPos.current = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
      // Any press begins a gesture (pan or draw) — dismiss the hover tooltip.
      cancelHover();
    },
    [canvas, eventToWorld, cancelHover],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      // All coordinates scaled to physical pixels to match WASM viewport
      const dpr = devicePixelRatio;
      const rect = canvas.getBoundingClientRect();
      const cursorX = (e.clientX - rect.left) * dpr;
      const cursorY = (e.clientY - rect.top) * dpr;
      const zoom = scene.zoom();
      const centerArr = scene.center();
      const halfW = canvas.clientWidth * dpr / 2;
      const halfH = canvas.clientHeight * dpr / 2;
      const worldX = (cursorX - halfW) / zoom + centerArr[0];
      const worldY = (cursorY - halfH) / zoom + centerArr[1];
      sendCursor([worldX, worldY]);

      // Live box/line draw preview: while a shift-press is drawing a line/box,
      // publish the in-progress shape (screen-space CSS px, relative to the
      // canvas) so AnnotationDraftOverlay grows it under the cursor. Below the
      // click slop it stays null (a sub-slop shift-release drops a point, not a
      // shape — mirror that so we don't flash a shape that becomes a point).
      const press = pressStart.current;
      if (press?.pin) {
        const drawKind = annotationKindRef.current;
        const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
        annotationDraftRef.current =
          (drawKind === "line" || drawKind === "box") && moved > PIN_CLICK_SLOP
            ? { kind: drawKind, x0: press.x - rect.left, y0: press.y - rect.top, x1: e.clientX - rect.left, y1: e.clientY - rect.top }
            : null;
      }

      // Label hover: while idle (no pan drag, no shift-draw), (re)arm a debounced
      // settle. Every move restarts the timer and invalidates any pending pick,
      // so a moving cursor never fires a pick per frame — only a settled one
      // does. The pick needs physical-pixel screen coords (WASM viewport space);
      // the tooltip is positioned in CSS px relative to the canvas.
      if (!dragging && !press?.pin) {
        if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
        hoverToken.current++;
        // Hide the previous tooltip immediately on move so it never lingers on
        // the wrong pixel; the settle re-shows it if the new spot has a label.
        setTooltip((prev) => (prev ? null : prev));
        const settleScreenX = cursorX;
        const settleScreenY = cursorY;
        const settleCssX = e.clientX - rect.left;
        const settleCssY = e.clientY - rect.top;
        hoverTimer.current = setTimeout(() => {
          hoverTimer.current = null;
          void resolveHover(settleScreenX, settleScreenY, settleCssX, settleCssY);
        }, HOVER_SETTLE_MS);
      }

      if (!dragging) return;
      const dx = (e.clientX - lastPos.current.x) * dpr;
      const dy = (e.clientY - lastPos.current.y) * dpr;
      lastPos.current = { x: e.clientX, y: e.clientY };
      const pdx = -dx;
      const pdy = -dy;
      breakFollow();
      applyViewportCommand(scene, { type: "pan", dx: pdx, dy: pdy });
      emitPresence();
      loopRef.current?.markInteractiveDirty();
    },
    [dragging, scene, canvas, emitPresence, breakFollow, sendCursor, annotationDraftRef, resolveHover],
  );

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      const press = pressStart.current;
      pressStart.current = null;
      setDragging(false);
      // The draw is ending — clear the live preview; the committed shape (below)
      // takes over.
      annotationDraftRef.current = null;

      // Only a shift-press draws, and only when a dataset is selected to scope
      // the annotation to.
      if (!press?.pin) return;
      const datasetId = annotationDatasetIdRef.current;
      if (!datasetId) return;

      const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
      const kind = annotationKindRef.current;
      // A line/box needs a real drag (two distinct vertices). A click — or a
      // line/box that never left the slop — falls back to dropping a point, so a
      // stray shift-click never leaves an invisible zero-size shape. A point
      // kind drops only on a genuine click (travel within slop), exactly as
      // before; a point-kind drag is a no-op.
      const drawShape = (kind === "line" || kind === "box") && moved > PIN_CLICK_SLOP;
      const dropPoint = !drawShape && moved <= PIN_CLICK_SLOP;
      if (!drawShape && !dropPoint) return;

      const id = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const end = eventToWorld(e);
      // Snapshot the author's CURRENT view onto the pin (annotation-views slice
      // 1) so a later slice can restore it on navigation. Workspace-dataset-id
      // form (no source URLs — it rides on broadcast/persisted document state).
      // The live Z/T/C come from the slider refs, but the slab THICKNESS and
      // `multi_channel` are read from the scene's presence via the canonical
      // `getLiveView` shape (`liveViewWithLiveZTC`) — so a 2D pin captured with
      // multi-channel on, or on a multi-plane slab, records them faithfully
      // instead of collapsing to a single-plane, single-channel view. `null`
      // (capture failure) just omits the view — it is optional/additive.
      const capturedView = buildAnnotationView(
        scene,
        liveViewWithLiveZTC(scene, zRef.current, tRef.current, cRef.current),
      );
      // Apply locally AND send (mirrors applyDocumentCommand for every other doc
      // command): the sender is excluded from the server's rebroadcast, so
      // without the local apply the author would never see their own shape. The
      // client-supplied id makes the local apply and peers' broadcast converge.
      //
      // Depth-from-slice in 2D mode: the shape takes the current view's slice
      // depth `z` (the same in-plane voxel frame `position`/`end` use), shared
      // by both vertices. That anchors it in 3D — the volume overlay lifts each
      // (x, y, z) to world via the renderer's transform. A slice-1/2 pin had no
      // z/end and loads as a point at z = 0.0.
      applyDocumentCommand(
        scene,
        {
          type: "add_annotation",
          dataset_id: datasetId,
          id,
          // For a point, the anchor IS the release point (drop-where-clicked).
          // For a line/box, the anchor is the press point and `end` the release.
          position: drawShape ? press.world : end,
          end: drawShape ? end : null,
          z: zRef.current,
          // Stamp the view's current T/C so the pin belongs to this slice/
          // timepoint/channel (issue #779); the overlay shows it off-context
          // when the view later differs.
          t: tRef.current,
          c: cRef.current,
          author: String(myIdRef.current),
          kind: drawShape ? kind : "point",
          // The author's full view at creation (camera + display + slice).
          // Omitted from the wire when capture failed (additive field).
          ...(capturedView ? { view: capturedView } : {}),
        },
        sendCommandRef.current,
      );
      onDocumentChangedRef.current();
      loopRef.current?.markInteractiveDirty();
    },
    [eventToWorld, scene, annotationDraftRef],
  );

  const onPointerCancel = useCallback(() => {
    // A cancelled gesture never drops a pin.
    pressStart.current = null;
    setDragging(false);
    annotationDraftRef.current = null;
    cancelHover();
  }, [annotationDraftRef, cancelHover]);

  const onPointerLeave = useCallback(() => {
    sendCursor(null);
    // Dismiss the label tooltip when the pointer leaves the canvas.
    cancelHover();
  }, [sendCursor, cancelHover]);

  // Clear cursor + hover on unmount (e.g. mode switch to 3D)
  useEffect(() => {
    return () => {
      sendCursor(null);
      cancelHover();
    };
  }, [sendCursor, cancelHover]);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      // Zoom remaps screen→voxel; drop any pending/visible hover so it can't
      // report an id for the pre-zoom cursor position.
      cancelHover();

      const dpr = devicePixelRatio;
      const rect = canvas.getBoundingClientRect();
      const cursorX = (e.clientX - rect.left) * dpr;
      const cursorY = (e.clientY - rect.top) * dpr;
      const canvasW = canvas.clientWidth * dpr;
      const canvasH = canvas.clientHeight * dpr;

      const oldZoom = scene.zoom();
      const centerArr = scene.center();
      const worldX = (cursorX - canvasW / 2) / oldZoom + centerArr[0];
      const worldY = (cursorY - canvasH / 2) / oldZoom + centerArr[1];

      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      breakFollow();
      applyViewportCommand(scene, { type: "zoom_by", factor });
      const newZoom = scene.zoom();

      const newCx = worldX - (cursorX - canvasW / 2) / newZoom;
      const newCy = worldY - (cursorY - canvasH / 2) / newZoom;
      applyViewportCommand(scene, { type: "set_center", x: newCx, y: newCy });
      emitPresence();
      loopRef.current?.markInteractiveDirty();
    },
    [scene, canvas, emitPresence, breakFollow, cancelHover],
  );

  useEffect(() => {
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    // Mutating canvas.style.cursor is the lightweight pattern for
    // grab/grabbing feedback during pointer drag — promoting cursor
    // state to the parent + a CSS class would re-render the whole
    // viewport tree on every drag transition.
    // eslint-disable-next-line react-hooks/immutability
    canvas.style.cursor = dragging ? "grabbing" : "grab";
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [canvas, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave, onWheel, dragging]);

  // The tooltip is the only DOM this viewer renders (the canvas + gestures are
  // imperative). It sits in the same absolute-in-`position:relative` wrapper as
  // the other 2D overlays, positioned in CSS px near the cursor.
  return tooltip ? (
    <LabelTooltip
      x={tooltip.x}
      y={tooltip.y}
      name={tooltip.name}
      value={tooltip.value}
      rows={tooltip.rows}
    />
  ) : null;
}
