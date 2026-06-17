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
import { useEffect, useRef, useState, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { applyDocumentCommand } from "../applyAndSend.ts";

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
  /** Additive depth. Absent on a slice-1/2 pin → defaulted to 0 on read. */
  z?: number;
  author: string;
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
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  // Which pin's thread popover is open (by pin id), or null when none.
  const [openPinId, setOpenPinId] = useState<string | null>(null);
  // Draft comment text, keyed by pin id, so each open thread keeps its own.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

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

        for (const pin of annotationsRef.current) {
          const el = dotRefs.current.get(pin.id);
          if (!el) continue;
          // world -> screen (inverse of SliceViewer's screen -> world);
          // divide by dpr to land in CSS pixels.
          const screenX = ((pin.position[0] - centerX) * zoom + physW / 2) / dpr;
          const screenY = ((pin.position[1] - centerY) * zoom + physH / 2) / dpr;
          el.style.transform = `translate(${screenX}px, ${screenY}px)`;
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
                mirroring the peer-cursor dot. Clicking it toggles the thread. */}
            <div
              title={
                mine
                  ? `Pin by you — click for thread, shift-click to remove`
                  : `Pin by ${pin.author} — click for thread`
              }
              onClick={(e) => {
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
                cursor: "pointer",
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
                          <span style={{ wordBreak: "break-word", flex: 1 }}>{c.text}</span>
                          {mineComment && (
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
