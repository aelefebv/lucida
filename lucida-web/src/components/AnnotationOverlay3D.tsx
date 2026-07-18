/**
 * DOM overlay that renders collaborative annotation pins as markers in the 3D
 * volume view AND hosts their comment threads.
 *
 * This is the 3D counterpart to {@link AnnotationOverlay} (the 2D slice view).
 * The rich thread UI itself is NOT duplicated here: both views render the ONE
 * shared {@link ThreadPopover}, so opening a pin's thread, reading + adding
 * comments, editing/removing your own, and deleting the pin (with confirm) all
 * behave identically in 2D and 3D and stay in lockstep. This file owns only the
 * 3D-specific concerns: projecting markers with the volume camera, the pin
 * gesture (click vs. drag vs. Shift+drag), and where the popover is anchored.
 *
 * Pin gesture (mirrors the 2D dot, issue #771 / #778):
 *  - a plain CLICK (press+release without travel) on ANY pin opens/closes its
 *    thread — just like 2D;
 *  - a plain DRAG orbits the camera as usual. The camera (orbit in arcball,
 *    look-around in fly) is owned entirely by the canvas's pointer handlers
 *    (VolumeViewer). To keep that behavior byte-for-byte and avoid any
 *    re-implementation/regression, the marker does not drive the camera itself:
 *    the moment a plain press crosses the click slop it HANDS the gesture to the
 *    canvas (transfers pointer capture + replays the pointerdown there), and the
 *    canvas runs its normal orbit/fly drag for the rest of the gesture;
 *  - a Shift+DRAG on an OWN pin moves it IN-PLANE: the release point is depth-
 *    picked back into the volume via `pick_annotation_voxel` for its in-plane
 *    coords (declining on a ray miss), but the pin keeps its OWN slice depth so
 *    a drag never re-slices it (issue #791) — mirroring the 2D drag. Move stays
 *    author-only.
 * The forward-on-first-drag (rather than forward-on-press) is what lets a plain
 * press resolve into either a thread-opening click or an orbit, without the pin
 * ever moving on a plain gesture.
 *
 * Like the peer-cursor 3D path (`PeerCursors`), each marker is re-projected from
 * the pin's world point every animation frame via
 * `scene.project_annotation(datasetId, x, y, z)`, which lifts the stored
 * in-plane-voxel + voxel-depth point to world space through the SAME rendering
 * transform the volume pass uses, then projects it with the active camera — so a
 * marker stays glued to its voxel as the camera orbits, and hides when the point
 * swings behind the camera (the call returns empty).
 *
 * Authoritative pin state (pins AND their nested comments) lives in the WASM
 * scene; this component reads it via `scene.annotations(datasetId)` and never
 * owns a parallel copy. `version` (the remote-document version) bumps whenever a
 * pin or comment is added/removed/edited, re-running the read.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import type { Annotation, AnnotationOverlayHandle } from "./annotationDocument.ts";
import { useAnnotationOverlay } from "./useAnnotationOverlay.ts";
import {
  capturePointer,
  emitMoveAnnotation,
  exceedsClickSlop,
  releasePointer,
} from "./annotationInteraction.ts";
import { eventToScreenPx, makeProjectAnnotationToCss } from "./cameraProjection.ts";
import { CommentCountBadge, OffContextHelptext } from "./AnnotationPinBadges.tsx";
import type { RenderLoop } from "../renderLoop.ts";
import type { ViewportCoordinator } from "../viewportCoordinator.ts";
import { annotationVertices, isClosedShape, type ScreenPoint } from "./annotationGeometry.ts";
import { isOffContext, type ViewContext } from "./annotationContext.ts";
import { ThreadPopover } from "./ThreadPopover.tsx";
import type { MentionCandidate } from "./annotationMentions.ts";

interface Props {
  /** The dataset whose pins to show (annotations are scoped per dataset). */
  datasetId: string;
  wasmSceneRef: RefObject<WasmScene | null>;
  canvas: HTMLCanvasElement;
  /** Bumped whenever the remote document changes; re-reads the pin set. */
  version: number;
  /** The current view's Z/T/C selectors (issue #779) — App passes `{ z: dims.z,
   * t: dims.t, c: dims.c }`. Drives the SAME on/off-context decision as the 2D
   * overlay (shared {@link isOffContext}): a pin off the current Z/T/C renders
   * dimmed with a helptext naming where it lives, like an off-view peer cursor. */
  viewContext: ViewContext;
  /** Stable, browser-persisted annotation-author identity (issue #777): the
   * author's own pins are tinted distinctly, and only the author may
   * move/edit/delete their own pin (anyone may add a comment). Sourced from
   * `annotationAuthorId()`, not the per-connection `bridge.myId`, so ownership
   * survives leaving + rejoining a workspace. (Prop name kept as `myId`; its
   * value/type is now the string identity.) */
  myId: string;
  /** Send a wire command (already wrapped by the bridge). Required for the thread
   * (add/edit/remove comment, delete pin) and a Shift+drag move; mirrors the 2D
   * overlay's apply-locally-and-send seam. App.tsx already passes it. */
  sendCommand: (json: string) => void;
  /** Notify the parent that the document changed locally (a comment/pin was
   * added/edited/removed/moved) so dependent overlays re-read via a fresh
   * `version`. App.tsx already passes it. */
  onDocumentChanged: () => void;
  /** Narrow port to the host's sole viewport-effect coordinator. Required by
   * construction; there is no direct-scene/repaint-only fallback. */
  viewport: Pick<ViewportCoordinator, "apply">;
  frameSignal?: Pick<RenderLoop, "subscribePresentedFrame"> | null;
  /** Personal, view-only visibility for ALL annotations (issue #792) — the 3D
   * twin of the 2D overlay's prop. When `false`, the overlay renders NOTHING (no
   * pin markers, no line/box geometry, no open thread popover), so one toolbar
   * toggle declutters the volume view; the annotation set is untouched (hidden,
   * not deleted), so flipping back re-renders everything. When `true` (or
   * omitted) the overlay behaves exactly as before. Local only: no command, no
   * wire/document change, no peer effect (peer cursors are not annotations). */
  visible?: boolean;
  /** People who can be @-mentioned in a comment (issue #526), threaded straight
   * through to the shared {@link ThreadPopover} — the SAME prop the 2D overlay
   * takes, so the mention behavior is identical in 2D and 3D. In production App
   * derives these from a union of the workspace member roster and the document's
   * participants (distinct `scene.annotations()` authors plus the current user),
   * each carrying a stable @handle; a test injects them. Optional + defaulted to
   * `[]`, so omitting it just means no mention picker. */
  mentionCandidates?: MentionCandidate[];
  /** Jump to a pin's captured author view (annotation-views slice 2) — the SAME
   * prop the 2D overlay takes, threaded to the shared {@link ThreadPopover} as
   * its "Go to author's view" affordance, so the behavior is identical in 2D and
   * 3D. The host performs the full LIGHT restore (camera + z/t/c + display, no
   * dataset opening/hiding, no layout broadcast). Optional + defaulted to a
   * no-op. */
  onGoToAuthorView?: (pinId: string) => void;
}

/** Live state for an in-progress pointer gesture that began on a marker, scoped
 * to one captured pointer. The marker captures the press so it can tell a click
 * from a drag itself (mirroring the 2D dot):
 *  - `mode: "move"` — a Shift+drag on an own pin: past the slop it previews under
 *    the cursor and release emits one `move_annotation` (author-only);
 *  - `mode: "orbit"` — a plain drag: the moment it passes the slop it is handed
 *    to the canvas (capture transfer + replayed pointerdown), which then owns the
 *    orbit/fly drag — so the camera behaves exactly as without this overlay. */
interface Pin3DDrag {
  pinId: string;
  pointerId: number;
  /** Move the pin (Shift on an own pin) or orbit the camera (plain). Fixed at
   * pointerdown from the Shift modifier + authorship. */
  mode: "move" | "orbit";
  /** Press point in CSS px, to measure travel against the slop. */
  startX: number;
  startY: number;
  /** Flips true once travel passes the slop — the press becomes a real drag. */
  moved: boolean;
  /** For an orbit gesture: set once the press has been handed to the canvas, so
   * we don't forward it more than once. */
  forwarded: boolean;
}

export const AnnotationOverlay3D = forwardRef<AnnotationOverlayHandle, Props>(function AnnotationOverlay3D({ datasetId, wasmSceneRef, canvas, version, viewContext, myId, sendCommand, onDocumentChanged, viewport, frameSignal, visible = true, mentionCandidates = [], onGoToAuthorView }: Props, ref) {
  const dotRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // SVG geometry element per line/box, re-projected each frame through the SAME
  // `project_annotation` call the dots use — so a line/box tracks the volume as
  // the camera orbits, just like a point marker.
  const shapeRefs = useRef<Map<string, SVGLineElement | SVGPolygonElement>>(new Map());
  // The authoritative pin set + which thread is open, with their shared
  // lifecycle (re-read on version/dataset change, close on vanish/dataset
  // switch/hide) — the same view-independent overlay state the 2D overlay
  // holds. (3D has no hovered-handle state on top of it.)
  const { annotations, annotationsRef, openPinId, setOpenPinId, focusPinWhenAvailable } = useAnnotationOverlay({
    wasmSceneRef,
    datasetId,
    version,
    visible,
  });

  const datasetIdRef = useRef(datasetId);
   
  datasetIdRef.current = datasetId;

  // Imperative navigation seam (issue #526) — the 3D twin of the 2D overlay's
  // `focusPin`, with the IDENTICAL handle shape so a host wires "jump to a pin"
  // the same way for both views; only the recenter MECHANICS differ. The 2D
  // `set_center` only moves the slice camera, so it is a NO-OP in 3D (the camera
  // is the arcball/fly, which `set_center` never touches). Instead this issues
  // `arcball_center_on_voxel`: the scene lifts the pin's voxel point to world via
  // the SAME rendering transform `project_annotation` uses and makes it the
  // arcball target, so the pin's marker re-projects to the viewport center. The
  // coordinator publishes presence/URL/follow state and marks the pull-based
  // render loop dirty as one effect boundary. The RAF tick
  // reprojects the now-open pin's marker, and its thread popover anchors there.
  // Reads the live pin set + dataset via refs; a missing pin / unready scene is a
  // safe no-op (and an unanchorable dataset is a no-op scene-side too).
  useImperativeHandle(
    ref,
    () => ({
      focusPin: (pinId: string) => {
        return focusPinWhenAvailable(pinId, (pin) => {
          const applied = viewport.apply(
            {
              type: "arcball_center_on_voxel",
              dataset_id: datasetIdRef.current,
              x: pin.position[0],
              y: pin.position[1],
              // The pin's slice depth (defaulted to 0 on a pre-depth pin), so the
              // arcball target is the pin's full 3D world point, not its in-plane
              // projection at z=0.
              z: pin.z ?? 0,
            },
            { source: "annotation_focus_3d", history: { label: "annotation focus" } },
          );
          if (applied) setOpenPinId(pin.id);
          return applied;
        });
      },
    }),
    [viewport, setOpenPinId, focusPinWhenAvailable],
  );

  // The live gesture, if any. Declared before the RAF effect because the tick
  // reads it to skip reprojecting the dot being Shift-moved (see below).
  const dragRef = useRef<Pin3DDrag | null>(null);
  // After a real drag (orbit or move), swallow the trailing click the browser
  // still fires on release so the thread doesn't toggle on drop. Keyed off the
  // pin id; cleared once the suppressed click is consumed. Mirrors the 2D dot.
  const suppressClickRef = useRef<string | null>(null);

  useEffect(() => {
    const projectFrame = () => {
      const scene = wasmSceneRef.current;
      if (scene) {
        // The single per-vertex projection every kind reuses: lift (x, y, z) to
        // world and project via the renderer's camera, in CSS px. `null` means
        // the vertex is behind the camera (or the dataset has no anchorable
        // member). The shared depth `z` applies to every vertex of a line/box.
        const project = makeProjectAnnotationToCss(scene, datasetIdRef.current);
        // The pin (if any) being actively Shift-moved past the slop: its dot is
        // positioned by the pointermove handler under the cursor, so the tick
        // must NOT reproject it from its (still-old) stored position — that would
        // fight the drag and snap the dot back every frame. On release the drag
        // clears and the tick resumes from the freshly-picked position. An orbit
        // gesture is excluded: it doesn't move the pin, so the dot keeps
        // reprojecting from world space to track the orbiting camera.
        const activeDrag = dragRef.current;
        const draggingId =
          activeDrag?.moved && activeDrag.mode === "move" ? activeDrag.pinId : null;
        for (const pin of annotationsRef.current) {
          const pinZ = pin.z ?? 0;
          const verts = annotationVertices(pin);
          const projected: (ScreenPoint | null)[] = verts.map((v) => project(v, pinZ));
          // If ANY vertex is behind the camera, hide the whole shape + dot — a
          // partially-projected line/box would streak across the screen.
          const allVisible = projected.every((p) => p !== null);

          const el = dotRefs.current.get(pin.id);
          if (el && pin.id !== draggingId) {
            const anchor = projected[0];
            if (!allVisible || !anchor) {
              el.style.display = "none";
            } else {
              el.style.display = "";
              el.style.transform = `translate(${anchor[0]}px, ${anchor[1]}px)`;
            }
          }

          const shape = shapeRefs.current.get(pin.id);
          if (shape) {
            if (!allVisible) {
              shape.style.display = "none";
            } else {
              shape.style.display = "";
              const pts = projected as ScreenPoint[];
              if (isClosedShape(pin)) {
                (shape as SVGPolygonElement).setAttribute(
                  "points",
                  pts.map((p) => `${p[0]},${p[1]}`).join(" "),
                );
              } else if (pts.length >= 2) {
                const line = shape as SVGLineElement;
                line.setAttribute("x1", String(pts[0][0]));
                line.setAttribute("y1", String(pts[0][1]));
                line.setAttribute("x2", String(pts[1][0]));
                line.setAttribute("y2", String(pts[1][1]));
              }
            }
          }
        }
      }
    };
    const initialFrame = requestAnimationFrame(projectFrame);
    const unsubscribe = frameSignal?.subscribePresentedFrame(projectFrame);
    return () => {
      cancelAnimationFrame(initialFrame);
      unsubscribe?.();
    };
  }, [wasmSceneRef, canvas, annotationsRef, frameSignal, version, visible]);

  // --- Pin gesture: click opens the thread; drag orbits; Shift+drag moves -----
  // Every marker is interactive (so any pin's thread can be opened by a click),
  // but the camera is still owned entirely by the canvas. The marker captures
  // the press to tell a click from a drag, then:
  //   - a plain drag is handed to the canvas the instant it passes the slop, so
  //     the canvas runs its real orbit/fly drag (no re-implementation);
  //   - a Shift+drag on an own pin previews + moves the pin;
  //   - a press that never passes the slop is a click → toggle the thread.

  /** Hand a plain drag to the canvas so the camera orbits/flies as usual.
   * Transfers capture to the canvas and replays the pointerdown there from the
   * ORIGINAL press point, so the canvas starts its drag with the correct anchor
   * (its first real move then computes the right delta — no jump). */
  const forwardPressToCanvas = (drag: Pin3DDrag, e: ReactPointerEvent) => {
    releasePointer(e.currentTarget as Element, drag.pointerId);
    // Take capture on the canvas so it owns the rest of the gesture; if capture
    // is unsupported (e.g. test env), the orbit still proceeds via the canvas
    // listeners on the dispatched event below.
    capturePointer(canvas, drag.pointerId);
    try {
      canvas.dispatchEvent(
        new PointerEvent("pointerdown", {
          pointerId: drag.pointerId,
          button: 0,
          buttons: e.buttons,
          // Replay from the press point so the canvas's lastPos anchors correctly.
          clientX: drag.startX,
          clientY: drag.startY,
          shiftKey: false,
          bubbles: true,
          cancelable: true,
        }),
      );
    } catch {
      // PointerEvent ctor unsupported — nothing more we can do; the plain drag
      // simply won't orbit in this (non-browser) environment.
    }
  };

  const onPinPointerDown = (pin: Annotation) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return; // only a primary press starts a gesture
    // A gesture is already in flight (a second pointer pressed mid-drag): ignore
    // it so the in-progress gesture completes rather than being silently reset.
    if (dragRef.current) return;
    // Start each gesture clean: clear any stale click-suppression from a prior
    // drag that never received its trailing click, so it can't eat a real click.
    suppressClickRef.current = null;
    const mine = pin.author === String(myId);
    // Shift on an OWN pin → move; everything else (plain press on any pin, or a
    // Shift press on a peer's pin) → orbit-or-click. A peer's pin can't be moved.
    const mode: "move" | "orbit" = e.shiftKey && mine ? "move" : "orbit";
    dragRef.current = {
      pinId: pin.id,
      pointerId: e.pointerId,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      forwarded: false,
    };
    // Bind the pointer to the marker so move/up land here while we decide
    // click-vs-drag.
    capturePointer(e.currentTarget as Element, e.pointerId);
  };

  const onPinPointerMove = (pin: Annotation) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pinId !== pin.id) return;
    if (!drag.moved) {
      // still within click slop — not yet a drag
      if (!exceedsClickSlop(drag.startX, drag.startY, e.clientX, e.clientY)) return;
      drag.moved = true;
    }

    if (drag.mode === "orbit") {
      // A plain drag: hand it to the canvas ONCE (the first time it passes the
      // slop) so the canvas owns the rest of the orbit/fly gesture.
      if (!drag.forwarded) {
        drag.forwarded = true;
        // A real drag must not also toggle the thread on the trailing click.
        suppressClickRef.current = pin.id;
        forwardPressToCanvas(drag, e);
        // Capture has moved to the canvas, so this marker won't receive the rest
        // of the gesture (move/up land on the canvas now). Release our gesture
        // state immediately so a stale orbit drag can't block the NEXT press on
        // this marker (onPinPointerDown bails while a drag is in flight). The
        // suppress flag persists to swallow the trailing click the browser still
        // fires on this marker after the drag.
        dragRef.current = null;
      }
      return;
    }

    // mode === "move": a Shift+drag on an own pin. Preview the dot under the
    // cursor (CSS px relative to the canvas). The RAF tick skips reprojecting
    // this dot while the drag is live; the authoritative position updates on
    // release.
    const el = dotRefs.current.get(pin.id);
    if (el) {
      const rect = canvas.getBoundingClientRect();
      el.style.display = "";
      el.style.transform = `translate(${e.clientX - rect.left}px, ${e.clientY - rect.top}px)`;
    }
  };

  const onPinPointerUp = (pin: Annotation) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pinId !== pin.id) return;
    dragRef.current = null;
    releasePointer(e.currentTarget as Element, drag.pointerId);

    // An orbit gesture that reaches pointerup on this marker never traveled (a
    // traveled one was handed to the canvas and its dragRef cleared, so the guard
    // above already returned). So this is a plain CLICK: emit nothing and DON'T
    // suppress — let onClick toggle the thread.
    if (drag.mode === "orbit") {
      return;
    }

    // mode === "move": a Shift+drag on an own pin. A Shift-press that never
    // passed the slop is not a move — emit nothing, and don't toggle the thread
    // (Shift is the move modifier; swallow its trailing click).
    if (!drag.moved) {
      suppressClickRef.current = pin.id;
      return;
    }
    // A real Shift+drag: resolve the release point through the SAME depth pick a
    // 3D pin drop uses — ray-cast into the volume for an in-plane-voxel + voxel-
    // depth point. Decline on a ray miss (a pin must anchor to data, never float
    // in empty space), so a Shift+drag that releases off the volume leaves the
    // pin where it was. Suppress the trailing click so the drop doesn't also pop
    // the thread.
    suppressClickRef.current = pin.id;
    const scene = wasmSceneRef.current;
    if (!scene) return;
    const [screenX, screenY] = eventToScreenPx(canvas, e);
    const voxel = scene.pick_annotation_voxel(datasetId, screenX, screenY);
    if (voxel.length < 3) return; // ray missed → don't move
    // A move repositions the pin IN-PLANE only — it must not change which slice
    // (Z) the pin belongs to (issue #791). So take the in-plane coords from the
    // ray-picked voxel (`[voxel[0], voxel[1]]`), but PRESERVE the pin's own depth
    // (`pin.z ?? 0`) rather than overwriting it with the picked voxel depth
    // (`voxel[2]`). Otherwise a 3D drag silently re-slices the pin, leaving it
    // stuck off-context on its original slice. This mirrors the 2D overlay's
    // move, which sends the pin's existing depth (`z: drag.z`). (`move_annotation`
    // carries no T/C, so timepoint/channel are preserved already.)
    emitMoveAnnotation(
      scene,
      { datasetId, id: pin.id, position: [voxel[0], voxel[1]], z: pin.z ?? 0 },
      sendCommand,
    );
    onDocumentChanged();
  };

  const onPinPointerCancel = (pin: Annotation) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pinId !== pin.id) return;
    const captured = drag.pointerId;
    dragRef.current = null;
    releasePointer(e.currentTarget as Element, captured);
    // A cancelled gesture never moves the pin; the tick snaps the dot back to its
    // projected position next frame.
  };

  // Personal show/hide of ALL annotations (issue #792): when hidden, render
  // NOTHING — no markers, no line/box geometry, no open thread popover — so the
  // volume view is unobstructed. Placed AFTER every hook above (rules of hooks:
  // the read/RAF/cleanup effects must run on every render to keep a stable
  // order), and the just-cleared open thread means a flip back to visible
  // re-renders the (untouched) annotation set from a clean baseline.
  if (!visible) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        // The layer never blocks camera orbit/zoom or the shift-drag pin draw on
        // the canvas: only the markers + an open popover opt back into pointer
        // events. A plain drag on a marker is handed straight to the canvas, so
        // the camera still owns every plain drag.
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: 10,
      }}
    >
      {/* Line/box geometry, projected per-vertex through the volume transform
          every frame (see the tick). Starts hidden so nothing flashes at the
          origin before the first projection. */}
      <svg
        width="100%"
        height="100%"
        style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", overflow: "visible" }}
      >
        {annotations.map((pin) => {
          if (pin.kind !== "line" && pin.kind !== "box") return null;
          if (!pin.end) return null;
          const color = pin.author === String(myId) ? "#FF3B30" : "#FF9F0A";
          if (isClosedShape(pin)) {
            return (
              <polygon
                key={pin.id}
                ref={(el) => {
                  if (el) shapeRefs.current.set(pin.id, el);
                  else shapeRefs.current.delete(pin.id);
                }}
                points=""
                fill={color}
                fillOpacity={0.12}
                stroke={color}
                strokeWidth={2.5}
                strokeLinejoin="round"
                style={{ display: "none" }}
              />
            );
          }
          return (
            <line
              key={pin.id}
              ref={(el) => {
                if (el) shapeRefs.current.set(pin.id, el);
                else shapeRefs.current.delete(pin.id);
              }}
              x1={0}
              y1={0}
              x2={0}
              y2={0}
              stroke={color}
              strokeWidth={2.5}
              strokeLinecap="round"
              style={{ display: "none" }}
            />
          );
        })}
      </svg>
      {annotations.map((pin) => {
        const mine = pin.author === String(myId);
        const comments = pin.comments ?? [];
        const isOpen = openPinId === pin.id;
        // Off-context (issue #779): same shared decision as the 2D overlay. In
        // 3D the wrapper's display is governed by the RAF tick (hidden when the
        // point projects behind the camera); off-context only adjusts the look
        // (dim + dashed dot + helptext), never the visibility — a visible pin
        // that lives elsewhere reads as off-view, like a peer cursor.
        // In 3D the volume renders every slice, so a pin on another Z is still
        // visible — ignore Z for off-context (only T/C dim a pin here). The 2D
        // overlay keeps Z, where it is a real slice selector.
        const offCtx = isOffContext(pin, viewContext, { ignoreZ: true });
        return (
          <div
            key={pin.id}
            data-testid={`annot-pin-wrapper-${pin.id}`}
            ref={(el) => {
              if (el) dotRefs.current.set(pin.id, el);
              else dotRefs.current.delete(pin.id);
            }}
            // Start hidden; the RAF tick reveals + positions it once projected,
            // so a marker never flashes at the origin for a frame.
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              display: "none",
              transform: "translate(0px, 0px)",
              willChange: "transform",
              pointerEvents: "none",
              // Dim the whole marker group off-context, like an off-view peer
              // cursor (the tick only writes display/transform, never opacity, so
              // this persists). An open thread is never dimmed.
              opacity: offCtx && !isOpen ? 0.5 : 1,
              // Like the 2D overlay (issue #772): every wrapper shares one layer
              // with no per-marker stacking, so a later pin's dot would paint over
              // an earlier pin's open popover. Lift only the open pin above the
              // rest so its popover clears every other marker; closing/switching
              // drops it back to the shared base.
              zIndex: isOpen ? 2 : 1,
            }}
          >
            {/* The pin marker (the thread-open click target for EVERY pin, so its
                testid is on every dot). A plain click toggles the thread; a plain
                drag is handed to the canvas (orbit); a Shift+drag on an own pin
                moves it. Every marker accepts the pointer so any pin's thread can
                open — a peer's pin just can't be Shift-moved. */}
            <button
              type="button"
              data-floating-anchor=""
              data-testid={`annot-pin-${pin.id}`}
              aria-label={mine ? "Open your annotation discussion" : `Open annotation discussion by ${pin.author}`}
              aria-expanded={isOpen}
              aria-controls={`annot-thread-${pin.id}`}
              title={
                mine
                  ? "Pin by you — click for thread, Shift+drag to move, drag to orbit"
                  : `Pin by ${pin.author} — click for thread, drag to orbit`
              }
              onPointerDown={onPinPointerDown(pin)}
              onPointerMove={onPinPointerMove(pin)}
              onPointerUp={onPinPointerUp(pin)}
              onPointerCancel={onPinPointerCancel(pin)}
              onClick={() => {
                // A real drag (orbit, or a Shift+drag move) just finished, or a
                // stationary Shift-press resolved: swallow the trailing click so
                // it doesn't also toggle the thread. Consume the flag once.
                if (suppressClickRef.current === pin.id) {
                  suppressClickRef.current = null;
                  return;
                }
                // A plain click toggles the comment thread popover.
                setOpenPinId((cur) => (cur === pin.id ? null : pin.id));
              }}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: 24,
                height: 24,
                minHeight: 24,
                marginLeft: -12,
                marginTop: -12,
                padding: 0,
                borderRadius: "50%",
                backgroundColor: "#FF3B30",
                // Distinct dashed outline off-context (mirrors the 2D overlay),
                // so it reads as "anchored on another Z/T/C" at a glance.
                border: offCtx ? "2px dashed white" : "2px solid white",
                boxShadow: "0 1px 3px rgba(0,0,0,0.6)",
                // Every marker accepts the pointer: a plain click opens the
                // thread, a plain drag is forwarded to the canvas to orbit.
                pointerEvents: "auto",
                cursor: mine ? "grab" : "pointer",
                touchAction: "none",
              }}
            />
            {/* Off-context helptext (issue #779): only when the pin lives on a
                different Z/T/C than the current view — the shared locator badge
                naming where it lives, identical in 2D and 3D. (Here T/C only;
                the wrapper's opacity dims, and the tick governs display.) */}
            {offCtx && <OffContextHelptext pin={pin} />}
            {/* Comment-count badge: only when the pin has at least one comment.
                The shared notification-count pill, identical in 2D and 3D — a
                child of the wrapper, so the per-frame projection (and the
                behind-the-camera hide) carries it with the marker. Clicking it
                toggles the thread, like clicking the dot. */}
            <CommentCountBadge
              count={comments.length}
              onToggleThread={() => setOpenPinId((cur) => (cur === pin.id ? null : pin.id))}
            />
            {/* Thread popover — the SAME shared component the 2D overlay renders,
                so 3D threads match 2D exactly. Anchored just below-right of the
                marker; lifting the open wrapper's z-index carries it above other
                markers. Keyed by pin id so its draft/edit/confirm state resets on
                switch. */}
            {isOpen && (
              <ThreadPopover
                key={pin.id}
                pin={pin}
                datasetId={datasetId}
                myId={myId}
                wasmSceneRef={wasmSceneRef}
                sendCommand={sendCommand}
                onDocumentChanged={onDocumentChanged}
                onClose={() => setOpenPinId(null)}
                mentionCandidates={mentionCandidates}
                onGoToAuthorView={onGoToAuthorView}
                frameSignal={frameSignal}
                canvas={canvas}
              />
            )}
          </div>
        );
      })}
    </div>
  );
});
