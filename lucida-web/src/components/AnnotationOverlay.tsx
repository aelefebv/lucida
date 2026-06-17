/**
 * DOM overlay for collaborative annotations (point pins) and their comment
 * threads.
 *
 * Mirrors the peer-cursor overlay (`PeerCursors`): a `pointerEvents: none`
 * layer over the canvas whose markers are re-projected from 2D world space to
 * screen space every animation frame using the current camera. Because pins
 * are anchored in world space (the same frame layout/`centroidWorld` use),
 * they stay glued to the data across pan/zoom for every peer regardless of
 * their viewport. Each pin carries a small comment-count badge; clicking a pin
 * opens a popover with its thread, where any peer can add a comment and an
 * author can remove their own.
 *
 * Authoritative annotation state (pins AND their nested comments) lives in the
 * WASM scene (populated by `load_document` on snapshot and `apply_command` on
 * broadcast); this component reads it via `scene.annotations(datasetId)` — which
 * returns each pin with its `comments` array — and never owns a parallel copy.
 * `version` (the remote-document version) changes whenever a pin or comment is
 * added/removed, which re-runs the snapshot read.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { applyDocumentCommand } from "../applyAndSend.ts";
import { annotationVertices, isClosedShape, type ScreenPoint } from "./annotationGeometry.ts";

/** One comment in a pin's thread (as returned nested in `annotations()`). */
export interface Comment {
  id: string;
  author: string;
  text: string;
}

/** One pin, as returned by `WasmScene.annotations()`. `position` is the
 * in-plane world point; `z` is the additive depth, so the pin's full world
 * point is `(position[0], position[1], z)`. */
export interface Annotation {
  id: string;
  position: [number, number];
  /** The second in-plane world vertex: a line's far endpoint or a box's
   * opposite corner. Absent/`null` for a point (and for any slice-1..4 pin). */
  end?: [number, number] | null;
  /** Additive depth. Absent on a slice-1/2 pin → defaulted to 0 on read. */
  z?: number;
  author: string;
  /** "point" | "line" | "box". Absent on a slice-1 pin → treated as "point". */
  kind: string;
  /** Flat, insertion-ordered comment thread. Absent on a slice-1 pin →
   * defaulted to an empty array on read. */
  comments?: Comment[];
}

interface Props {
  /** The dataset whose pins to show (annotations are scoped per dataset). */
  datasetId: string;
  wasmSceneRef: RefObject<WasmScene | null>;
  canvas: HTMLCanvasElement;
  /** Bumped whenever the remote document changes; re-reads the pin set. */
  version: number;
  /** Local client id; used to gate the remove affordance to the author. */
  myId: number;
  /** Send a wire command (already wrapped by the bridge). */
  sendCommand: (json: string) => void;
  /** Notify the parent that the document changed locally (a pin/comment was
   * added or removed) so this overlay re-reads via a fresh `version`. */
  onDocumentChanged: () => void;
}

/** Max pointer travel (CSS px) for a press+release to count as a click, not a
 * drag. Mirrors SliceViewer's PIN_CLICK_SLOP so moving a pin and dropping one
 * share the same "did the pointer really travel?" threshold. */
const PIN_CLICK_SLOP = 4;

/** Live state for an in-progress pin drag, scoped to one captured pointer. */
interface PinDrag {
  pinId: string;
  pointerId: number;
  /** Press point in CSS px (clientX/Y), to measure travel against the slop. */
  startX: number;
  startY: number;
  /** The pin's depth at press; preserved across the move (z is not edited). */
  z: number;
  /** Flips true once travel passes the slop — the press becomes a real drag. */
  moved: boolean;
}

function readAnnotations(scene: WasmScene | null, datasetId: string): Annotation[] {
  if (!scene) return [];
  try {
    const json = scene.annotations(datasetId);
    const parsed = JSON.parse(json) as Annotation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Stable client-supplied id so the local apply and peers' broadcast converge. */
function newId(prefix: string): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function AnnotationOverlay({ datasetId, wasmSceneRef, canvas, version, myId, sendCommand, onDocumentChanged }: Props) {
  const dotRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // SVG geometry element per non-point pin (the line segment / box outline),
  // re-projected each frame through the SAME world->screen math as the dot.
  const shapeRefs = useRef<Map<string, SVGLineElement | SVGPolygonElement>>(new Map());
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  // Which pin's thread popover is open (by pin id), or null when none.
  const [openPinId, setOpenPinId] = useState<string | null>(null);
  // Draft comment text, keyed by pin id, so each open thread keeps its own.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // The comment currently being edited (by comment id), or null when none, plus
  // its in-flight draft text. Only one comment edits at a time — opening another
  // (or saving/cancelling) replaces it.
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  // The live pin drag, if any. A ref (not state) so the per-pointer handlers
  // mutate it without re-rendering mid-drag; the RAF tick keeps repositioning
  // the dot from world space, so we don't need to store a screen offset here.
  const dragRef = useRef<PinDrag | null>(null);
  // After a real drag (not a click), swallow the click event the browser still
  // fires on pointerup so the thread popover doesn't toggle on drop. Keyed off
  // the pin id; cleared once the suppressed click is consumed.
  const suppressClickRef = useRef<string | null>(null);

  // Re-read the authoritative pin set (with threads) from WASM whenever the
  // document version changes (a pin/comment was added/removed locally or by a
  // peer) or the scoped dataset changes. Reading happens in an effect (not
  // render) so we never touch the scene ref during render. The RAF tick below
  // only repositions existing DOM nodes; it does not re-read or allocate.
  useEffect(() => {
    setAnnotations(readAnnotations(wasmSceneRef.current, datasetId));
  }, [wasmSceneRef, datasetId, version]);

  // If the pin whose thread is open disappears (removed by its author or a
  // peer, or its dataset changed), close the popover so it can't dangle.
  useEffect(() => {
    if (openPinId !== null && !annotations.some((p) => p.id === openPinId)) {
      setOpenPinId(null);
    }
  }, [annotations, openPinId]);

  useEffect(() => {
    setOpenPinId(null);
  }, [datasetId]);

  // No separate effect is needed to clear a stale edit: the edit field only
  // renders for a comment still present in the open thread's `comments` (we map
  // over them), so a removed/closed comment's field simply stops rendering, and
  // `startEdit` always re-seeds `editDraft` from the comment's current text — so
  // a dangling `editingCommentId` can never surface old text over another pin.

  // Reposition markers every frame from world space using the live camera,
  // exactly like PeerCursors. Read the latest pins via a ref so the loop
  // doesn't remount when the set changes. Mirroring a value into a ref in the
  // render phase is the same idempotent pattern PeerCursors uses for its
  // per-frame reads — written, never read, during this render.
  const annotationsRef = useRef(annotations);
  // eslint-disable-next-line react-hooks/refs
  annotationsRef.current = annotations;

  useEffect(() => {
    let rafId: number;
    const tick = () => {
      const scene = wasmSceneRef.current;
      if (scene) {
        const dpr = devicePixelRatio;
        const physW = Math.round(canvas.clientWidth * dpr);
        const physH = Math.round(canvas.clientHeight * dpr);
        const zoom = scene.zoom();
        const center = scene.center();
        const centerX = center[0];
        const centerY = center[1];
        // world -> screen (inverse of SliceViewer's screen -> world); divide by
        // dpr to land in CSS pixels. This is the single per-vertex projection
        // every kind reuses — the dot, the line, and the box corners all go
        // through it.
        const project = (v: ScreenPoint): ScreenPoint => [
          ((v[0] - centerX) * zoom + physW / 2) / dpr,
          ((v[1] - centerY) * zoom + physH / 2) / dpr,
        ];

        // The pin (if any) being actively dragged past the slop: its dot is
        // positioned by the pointermove handler under the cursor, so the tick
        // must NOT reproject it from its (still-old) stored position — that would
        // fight the drag and snap the dot back every frame. On release the drag
        // clears and the tick resumes from the freshly-applied position.
        const draggingId = dragRef.current?.moved ? dragRef.current.pinId : null;

        for (const pin of annotationsRef.current) {
          // Anchor dot (the interaction target) sits at the first vertex.
          const el = dotRefs.current.get(pin.id);
          if (el && pin.id !== draggingId) {
            const [ax, ay] = project(pin.position);
            el.style.transform = `translate(${ax}px, ${ay}px)`;
          }
          // Line/box geometry: project every vertex through the same `project`
          // and rewrite the shared SVG element's coordinates in place.
          const shape = shapeRefs.current.get(pin.id);
          if (shape) {
            const pts = annotationVertices(pin).map(project);
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
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [wasmSceneRef, canvas]);

  const addComment = (pinId: string) => {
    const text = (drafts[pinId] ?? "").trim();
    if (!text) return;
    const scene = wasmSceneRef.current;
    if (!scene) return;
    // Apply locally AND send (mirrors every other doc command): the sender is
    // excluded from the server's rebroadcast, so the local apply is what shows
    // the comment in the author's own thread. The client-supplied id makes the
    // local apply and the peers' broadcast converge on the same comment.
    applyDocumentCommand(
      scene,
      {
        type: "add_comment",
        dataset_id: datasetId,
        annotation_id: pinId,
        id: newId("comment"),
        author: String(myId),
        text,
      },
      sendCommand,
    );
    setDrafts((d) => ({ ...d, [pinId]: "" }));
    onDocumentChanged();
  };

  const removeComment = (pinId: string, commentId: string) => {
    const scene = wasmSceneRef.current;
    if (!scene) return;
    applyDocumentCommand(
      scene,
      {
        type: "remove_comment",
        dataset_id: datasetId,
        annotation_id: pinId,
        id: commentId,
      },
      sendCommand,
    );
    onDocumentChanged();
  };

  // Begin editing a comment: seed the field with its current text. Mirrors how
  // a draft is opened for a new comment, but keyed to the comment being edited.
  const startEdit = (comment: Comment) => {
    setEditingCommentId(comment.id);
    setEditDraft(comment.text);
  };

  const cancelEdit = () => {
    setEditingCommentId(null);
    setEditDraft("");
  };

  // Commit an edit: trim, reject empty (emit nothing — mirrors addComment), and
  // otherwise apply-locally-and-send a single edit_comment for this comment id.
  const saveEdit = (pinId: string, commentId: string) => {
    const text = editDraft.trim();
    if (!text) {
      // An empty/whitespace edit is a no-op: leave edit mode without emitting,
      // so a cleared field never wipes the comment.
      cancelEdit();
      return;
    }
    const scene = wasmSceneRef.current;
    if (!scene) return;
    applyDocumentCommand(
      scene,
      {
        type: "edit_comment",
        dataset_id: datasetId,
        annotation_id: pinId,
        id: commentId,
        text,
      },
      sendCommand,
    );
    cancelEdit();
    onDocumentChanged();
  };

  /** Convert a pointer event to 2D world coords — the inverse camera projection,
   * identical to SliceViewer's `eventToWorld` (world = (screenPx − half)/zoom +
   * center). Reused so a moved pin lands in the SAME world frame add_annotation
   * stores, regardless of pan/zoom. */
  const eventToWorld = (e: { clientX: number; clientY: number }): [number, number] => {
    const scene = wasmSceneRef.current;
    if (!scene) return [0, 0];
    const dpr = devicePixelRatio;
    const rect = canvas.getBoundingClientRect();
    const cursorX = (e.clientX - rect.left) * dpr;
    const cursorY = (e.clientY - rect.top) * dpr;
    const zoom = scene.zoom();
    const center = scene.center();
    const halfW = (canvas.clientWidth * dpr) / 2;
    const halfH = (canvas.clientHeight * dpr) / 2;
    return [(cursorX - halfW) / zoom + center[0], (cursorY - halfH) / zoom + center[1]];
  };

  // --- Pin drag (move_annotation) ---------------------------------------------
  // The author's own pin marker is the drag handle. We drive the whole gesture
  // with Pointer Events ON the marker (capture on down; move/up on the marker),
  // so the pointer stays bound to it even if it slides off — exactly the pattern
  // the interaction contract asks for and the harness dispatches to.

  const onPinPointerDown = (pin: Annotation) => (e: ReactPointerEvent) => {
    // Only the author drags; only a primary, non-shift press (shift-click stays
    // the remove gesture). Anything else falls through to the click handlers.
    if (pin.author !== String(myId)) return;
    if (e.button !== 0 || e.shiftKey) return;
    // A drag is already in flight (a second pointer pressed mid-drag): ignore it
    // so the in-progress gesture completes rather than being silently reset.
    if (dragRef.current) return;
    // Start each gesture with a clean slate: clear any stale click-suppression
    // from a prior drag that never received its trailing click, so it can never
    // eat a future legitimate click on this pin.
    suppressClickRef.current = null;
    dragRef.current = {
      pinId: pin.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      z: pin.z ?? 0,
      moved: false,
    };
    // Bind the pointer to the marker so move/up land here through the drag.
    // happy-dom may lack pointer capture; it's a progressive enhancement, never
    // required for the gesture to complete.
    try {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    } catch {
      // capture unsupported (e.g. test env) — moves/ups still arrive on target
    }
  };

  const onPinPointerMove = (pin: Annotation) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    // Scope to the active drag's pin (only one drag at a time). We don't gate on
    // pointerId equality — a captured pointer already guarantees same-id delivery
    // in a real browser, and not gating keeps the gesture robust to harnesses
    // that don't echo the id on every event.
    if (!drag || drag.pinId !== pin.id) return;
    if (!drag.moved) {
      const travel = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (travel <= PIN_CLICK_SLOP) return; // still within click slop — not yet a drag
      drag.moved = true;
    }
    // Past the slop: preview the move by repositioning the dot live under the
    // cursor (CSS px relative to the canvas). The RAF tick reprojects from world
    // space every frame, so this transform only governs the in-flight frames;
    // the authoritative position updates on release via apply_command.
    const el = dotRefs.current.get(pin.id);
    if (el) {
      const rect = canvas.getBoundingClientRect();
      el.style.transform = `translate(${e.clientX - rect.left}px, ${e.clientY - rect.top}px)`;
    }
  };

  const onPinPointerUp = (pin: Annotation) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pinId !== pin.id) return;
    dragRef.current = null;
    try {
      // Release the pointer we actually captured (its id from pointerdown).
      (e.currentTarget as Element).releasePointerCapture?.(drag.pointerId);
    } catch {
      // ignore — capture may not have been taken
    }
    // A press that never passed the slop is a click, not a move: emit nothing and
    // let the marker's onClick run (toggle thread / shift-remove). Only a real
    // drag emits, and it suppresses the trailing click so the thread doesn't pop.
    if (!drag.moved) return;
    suppressClickRef.current = pin.id;
    const scene = wasmSceneRef.current;
    if (!scene) return;
    const position = eventToWorld(e);
    applyDocumentCommand(
      scene,
      {
        type: "move_annotation",
        dataset_id: datasetId,
        id: pin.id,
        position,
        z: drag.z,
      },
      sendCommand,
    );
    onDocumentChanged();
  };

  const onPinPointerCancel = (pin: Annotation) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pinId !== pin.id) return;
    // A cancelled gesture (e.g. the OS stealing the pointer) never moves the pin;
    // the RAF tick snaps the dot back to its stored world position next frame.
    const captured = drag.pointerId;
    dragRef.current = null;
    try {
      (e.currentTarget as Element).releasePointerCapture?.(captured);
    } catch {
      // ignore
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        // Pins and their popovers accept clicks; the layer itself does not
        // block canvas pan/zoom/pin-placement elsewhere.
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: 10,
      }}
    >
      {/* Shape layer: one SVG element per line/box, drawn beneath the DOM
          markers. Each shape's coordinates are rewritten every frame by the RAF
          tick (projecting its vertices through the shared `project`), so it
          stays glued to the data across pan/zoom — exactly like the dots. */}
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
            />
          );
        })}
      </svg>
      {annotations.map((pin) => {
        const mine = pin.author === String(myId);
        const comments = pin.comments ?? [];
        const isOpen = openPinId === pin.id;
        return (
          <div
            key={pin.id}
            ref={(el) => {
              if (el) dotRefs.current.set(pin.id, el);
              else dotRefs.current.delete(pin.id);
            }}
            style={{
              // The marker is positioned via transform each frame; the popover
              // is an absolutely-positioned child anchored to it.
              position: "absolute",
              top: 0,
              left: 0,
              transform: "translate(0px, 0px)",
              willChange: "transform",
              pointerEvents: "none",
            }}
          >
            {/* The pin marker itself: a circular dot centered on the anchor,
                mirroring the peer-cursor dot. For the author it is also the drag
                handle (Pointer Events below) — a click toggles the thread, a
                shift-click removes, a real drag moves. A peer's pin only clicks
                (it carries no drag testid and ignores the drag handlers). */}
            <div
              data-testid={mine ? `annot-pin-${pin.id}` : undefined}
              title={
                mine
                  ? `Pin by you — click for thread, drag to move, shift-click to remove`
                  : `Pin by ${pin.author} — click for thread`
              }
              onPointerDown={mine ? onPinPointerDown(pin) : undefined}
              onPointerMove={mine ? onPinPointerMove(pin) : undefined}
              onPointerUp={mine ? onPinPointerUp(pin) : undefined}
              onPointerCancel={mine ? onPinPointerCancel(pin) : undefined}
              onClick={(e) => {
                // A real drag just finished: swallow the trailing click so the
                // drop doesn't also toggle the thread. Consume the flag once.
                if (suppressClickRef.current === pin.id) {
                  suppressClickRef.current = null;
                  return;
                }
                // Shift-click removes the pin (author only); plain click toggles
                // the comment thread popover. This keeps pin-removal available
                // without stealing the click that opens a discussion.
                if (e.shiftKey) {
                  if (!mine) return;
                  const scene = wasmSceneRef.current;
                  if (!scene) return;
                  applyDocumentCommand(
                    scene,
                    { type: "remove_annotation", dataset_id: datasetId, id: pin.id },
                    sendCommand,
                  );
                  onDocumentChanged();
                  return;
                }
                setOpenPinId((cur) => (cur === pin.id ? null : pin.id));
              }}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: 12,
                height: 12,
                marginLeft: -6,
                marginTop: -6,
                borderRadius: "50%",
                backgroundColor: "#FF3B30",
                border: "2px solid white",
                boxShadow: "0 1px 3px rgba(0,0,0,0.6)",
                pointerEvents: "auto",
                // Own pins advertise the move affordance with a move cursor; a
                // peer's pin stays a plain pointer (click-only).
                cursor: mine ? "grab" : "pointer",
                touchAction: mine ? "none" : undefined,
              }}
            />
            {/* Comment-count badge: only when the pin has at least one comment.
                A tiny pill at the pin's upper-right, like a notification count. */}
            {comments.length > 0 && (
              <div
                aria-label={`${comments.length} comment${comments.length === 1 ? "" : "s"}`}
                onClick={() => setOpenPinId((cur) => (cur === pin.id ? null : pin.id))}
                style={{
                  position: "absolute",
                  top: -14,
                  left: 4,
                  minWidth: 16,
                  height: 16,
                  padding: "0 4px",
                  borderRadius: 8,
                  backgroundColor: "#1f6feb",
                  color: "white",
                  fontSize: 11,
                  lineHeight: "16px",
                  textAlign: "center",
                  fontWeight: 600,
                  boxShadow: "0 1px 2px rgba(0,0,0,0.5)",
                  pointerEvents: "auto",
                  cursor: "pointer",
                }}
              >
                {comments.length}
              </div>
            )}
            {/* Thread popover: the flat, ordered comment list plus an add box.
                Anchored just below-right of the pin. */}
            {isOpen && (
              <div
                style={{
                  position: "absolute",
                  top: 10,
                  left: 10,
                  width: 240,
                  maxHeight: 280,
                  display: "flex",
                  flexDirection: "column",
                  background: "rgba(22,27,34,0.97)",
                  color: "#e6edf3",
                  border: "1px solid #30363d",
                  borderRadius: 8,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.6)",
                  fontSize: 12,
                  pointerEvents: "auto",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "6px 8px",
                    borderBottom: "1px solid #30363d",
                    fontWeight: 600,
                  }}
                >
                  <span>
                    Thread{comments.length > 0 ? ` (${comments.length})` : ""}
                  </span>
                  <button
                    onClick={() => setOpenPinId(null)}
                    aria-label="Close thread"
                    style={{
                      background: "none",
                      border: "none",
                      color: "#8b949e",
                      cursor: "pointer",
                      fontSize: 14,
                      lineHeight: 1,
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
                </div>
                <div style={{ overflowY: "auto", padding: "4px 0", flex: 1 }}>
                  {comments.length === 0 ? (
                    <div style={{ padding: "8px", color: "#8b949e" }}>
                      No comments yet. Start the discussion.
                    </div>
                  ) : (
                    comments.map((c) => {
                      const mineComment = c.author === String(myId);
                      const isEditing = mineComment && editingCommentId === c.id;
                      return (
                        <div
                          key={c.id}
                          style={{
                            padding: "4px 8px",
                            display: "flex",
                            gap: 6,
                            alignItems: "baseline",
                          }}
                        >
                          <span style={{ color: "#58a6ff", fontWeight: 600, whiteSpace: "nowrap" }}>
                            {mineComment ? "you" : c.author}
                          </span>
                          {isEditing ? (
                            // Edit mode: a field seeded with the current text.
                            // Enter saves (trimmed; empty rejected), Escape and
                            // blur cancel — mirroring the rename/draft patterns.
                            <>
                              <input
                                type="text"
                                data-testid={`comment-edit-input-${c.id}`}
                                value={editDraft}
                                autoFocus
                                aria-label="Edit comment"
                                onChange={(e) => setEditDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    saveEdit(pin.id, c.id);
                                  } else if (e.key === "Escape") {
                                    e.preventDefault();
                                    cancelEdit();
                                  }
                                }}
                                onBlur={(e) => {
                                  // Blur cancels the edit — UNLESS focus is
                                  // moving to this comment's save control, in
                                  // which case let the save's click commit it.
                                  const next = e.relatedTarget as HTMLElement | null;
                                  if (next?.dataset?.testid === `comment-edit-save-${c.id}`) {
                                    return;
                                  }
                                  cancelEdit();
                                }}
                                style={{
                                  flex: 1,
                                  minWidth: 0,
                                  padding: "2px 4px",
                                  fontSize: 12,
                                  background: "#0d1117",
                                  color: "#e6edf3",
                                  border: "1px solid #30363d",
                                  borderRadius: 4,
                                }}
                              />
                              <button
                                data-testid={`comment-edit-save-${c.id}`}
                                // preventDefault on mousedown keeps focus on the
                                // input so its onBlur cancel doesn't fire first
                                // and tear the field down before the click saves;
                                // the actual save runs on click (so a plain
                                // click — real or synthetic — commits once).
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => saveEdit(pin.id, c.id)}
                                title="Save comment"
                                aria-label="Save comment"
                                style={{
                                  background: "none",
                                  border: "none",
                                  color: "#3fb950",
                                  cursor: "pointer",
                                  fontSize: 12,
                                  lineHeight: 1,
                                  padding: 0,
                                }}
                              >
                                ✓
                              </button>
                            </>
                          ) : (
                            <>
                              <span style={{ wordBreak: "break-word", flex: 1 }}>{c.text}</span>
                              {mineComment && (
                                <>
                                  <button
                                    data-testid={`comment-edit-${c.id}`}
                                    onClick={() => startEdit(c)}
                                    title="Edit comment"
                                    aria-label="Edit comment"
                                    style={{
                                      background: "none",
                                      border: "none",
                                      color: "#8b949e",
                                      cursor: "pointer",
                                      fontSize: 12,
                                      lineHeight: 1,
                                      padding: 0,
                                    }}
                                  >
                                    ✎
                                  </button>
                                  <button
                                    onClick={() => removeComment(pin.id, c.id)}
                                    title="Remove comment"
                                    aria-label="Remove comment"
                                    style={{
                                      background: "none",
                                      border: "none",
                                      color: "#8b949e",
                                      cursor: "pointer",
                                      fontSize: 12,
                                      lineHeight: 1,
                                      padding: 0,
                                    }}
                                  >
                                    ×
                                  </button>
                                </>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
                <div style={{ display: "flex", gap: 4, padding: 6, borderTop: "1px solid #30363d" }}>
                  <input
                    type="text"
                    value={drafts[pin.id] ?? ""}
                    placeholder="Add a comment…"
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [pin.id]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addComment(pin.id);
                      }
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: "4px 6px",
                      fontSize: 12,
                      background: "#0d1117",
                      color: "#e6edf3",
                      border: "1px solid #30363d",
                      borderRadius: 4,
                    }}
                  />
                  <button
                    onClick={() => addComment(pin.id)}
                    disabled={!(drafts[pin.id] ?? "").trim()}
                    style={{
                      padding: "4px 8px",
                      fontSize: 12,
                      cursor: (drafts[pin.id] ?? "").trim() ? "pointer" : "default",
                    }}
                  >
                    Send
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
