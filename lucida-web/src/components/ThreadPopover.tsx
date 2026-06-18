/**
 * The collaborative comment-thread popover for a single annotation pin — the
 * ONE place the rich thread UI lives, rendered by BOTH the 2D
 * ({@link AnnotationOverlay}) and 3D ({@link AnnotationOverlay3D}) overlays.
 *
 * It was extracted out of the 2D overlay (where it used to live inline) so the
 * thread experience is identical in both views and stays in lockstep: read the
 * flat, ordered comment list; add a comment (anyone); edit/remove your own
 * comment (author-only); delete the pin behind a two-step confirm (author-only).
 * Every interaction-contract testid the slice verifies lives here, so applying
 * this component in both overlays makes those ids hold in 2D and 3D at once:
 *   - the popover root carries `annot-thread-<pinId>`
 *   - the add box carries `comment-add-input-<pinId>` + `comment-add-send-<pinId>`
 *   - an own comment carries `comment-edit-<commentId>` (+ its save/remove)
 *   - an own pin carries `pin-delete-<pinId>` (+ its confirm/cancel)
 *
 * Every mutation goes through the shared apply-locally-and-send seam
 * (`applyDocumentCommand(scene, cmd, sendCommand)`): the local apply is what
 * shows the change in the author's own view (the server excludes the sender from
 * its rebroadcast), and the client-supplied id makes the local apply and the
 * peers' broadcast converge on the same comment. After any successful mutation
 * we call `onDocumentChanged` so the host overlay re-reads the authoritative pin
 * set via a fresh `version`.
 *
 * State scoping: this component owns ONLY ephemeral, per-thread UI state — the
 * add draft, the comment being edited, and whether delete is armed. Each host
 * overlay renders exactly one popover (for the pin whose thread is open) and
 * keys it by pin id, so switching pins remounts the popover and naturally clears
 * that state — no cross-pin bleed, no parent-held draft/edit maps.
 *
 * Positioning/anchoring is the host's job (the popover is an absolutely
 * positioned child of the pin's marker wrapper in each overlay); this component
 * is purely the thread UI and is presentation-position-agnostic.
 */
import { useState, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { applyDocumentCommand } from "../applyAndSend.ts";
import type { Annotation, Comment } from "./AnnotationOverlay.tsx";

interface Props {
  /** The pin whose thread this is, with its nested `comments`. */
  pin: Annotation;
  /** The dataset the pin belongs to (commands are scoped per dataset). */
  datasetId: string;
  /** Stable, browser-persisted annotation-author identity (issue #777): gates the
   * author-only affordances (edit/remove a comment, delete the pin) and is
   * recorded as a new comment's `author`. Sourced from `annotationAuthorId()` via
   * the host overlay, not the per-connection `bridge.myId`, so authorship
   * survives leaving + rejoining a workspace. (Prop name kept as `myId`; its
   * value/type is now the string identity.) */
  myId: string;
  /** Live scene handle for the apply-locally half of the seam. */
  wasmSceneRef: RefObject<WasmScene | null>;
  /** Send a wire command (already wrapped by the bridge). */
  sendCommand: (json: string) => void;
  /** Notify the host that the document changed locally (a comment/pin was
   * added/edited/removed) so it re-reads via a fresh `version`. */
  onDocumentChanged: () => void;
  /** Ask the host to close this thread (the × control). The host owns which pin
   * is open, so closing is its decision to make. */
  onClose: () => void;
}

/** Stable client-supplied id so the local apply and peers' broadcast converge. */
function newId(prefix: string): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function ThreadPopover({
  pin,
  datasetId,
  myId,
  wasmSceneRef,
  sendCommand,
  onDocumentChanged,
  onClose,
}: Props) {
  // Draft text for a NEW comment in this thread.
  const [draft, setDraft] = useState("");
  // The comment currently being edited (by id), or null, plus its in-flight
  // text. Only one comment edits at a time — opening another (or saving/
  // cancelling) replaces it.
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // Whether this pin's delete is armed (two-step confirm). A small piece of
  // local UI state — NOT a modal — that turns the Delete trigger into a
  // Confirm/Cancel. Nothing is emitted until Confirm, so a pin and its whole
  // thread can never be destroyed by a single click.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const mine = pin.author === String(myId);
  const comments = pin.comments ?? [];

  // --- Add a comment (add_comment) — anyone may add -------------------------
  const addComment = () => {
    const text = draft.trim();
    if (!text) return;
    const scene = wasmSceneRef.current;
    if (!scene) return;
    applyDocumentCommand(
      scene,
      {
        type: "add_comment",
        dataset_id: datasetId,
        annotation_id: pin.id,
        id: newId("comment"),
        author: String(myId),
        text,
      },
      sendCommand,
    );
    setDraft("");
    onDocumentChanged();
  };

  // --- Remove an own comment (remove_comment) — author-only -----------------
  const removeComment = (commentId: string) => {
    const scene = wasmSceneRef.current;
    if (!scene) return;
    applyDocumentCommand(
      scene,
      {
        type: "remove_comment",
        dataset_id: datasetId,
        annotation_id: pin.id,
        id: commentId,
      },
      sendCommand,
    );
    onDocumentChanged();
  };

  // --- Edit an own comment (edit_comment) — author-only ----------------------
  const startEdit = (comment: Comment) => {
    // Arming an edit and arming a delete are mutually exclusive — the popover
    // shows exactly one active affordance at a time.
    setConfirmingDelete(false);
    setEditingCommentId(comment.id);
    setEditDraft(comment.text);
  };

  const cancelEdit = () => {
    setEditingCommentId(null);
    setEditDraft("");
  };

  const saveEdit = (commentId: string) => {
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
        annotation_id: pin.id,
        id: commentId,
        text,
      },
      sendCommand,
    );
    cancelEdit();
    onDocumentChanged();
  };

  // --- Delete the pin (remove_annotation), two-step + author-only -----------
  // The Delete trigger only arms the confirm (emits nothing); Confirm is the
  // single point that emits remove_annotation, which cascades the pin's whole
  // thread on apply. Cancel just disarms.
  const requestDeletePin = () => {
    cancelEdit();
    setConfirmingDelete(true);
  };

  const cancelDeletePin = () => {
    setConfirmingDelete(false);
  };

  const confirmDeletePin = () => {
    const scene = wasmSceneRef.current;
    if (!scene) {
      setConfirmingDelete(false);
      return;
    }
    applyDocumentCommand(
      scene,
      { type: "remove_annotation", dataset_id: datasetId, id: pin.id },
      sendCommand,
    );
    // The pin's disappearance will close the thread via the host's effect; reset
    // the local confirm anyway so a re-open never resurfaces it.
    setConfirmingDelete(false);
    onDocumentChanged();
  };

  return (
    <div
      data-testid={`annot-thread-${pin.id}`}
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
        <span>Thread{comments.length > 0 ? ` (${comments.length})` : ""}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Delete trigger — author-only. Activating it arms the confirm below
              (it does NOT emit), so a pin and its whole thread can never be
              removed in one click. A peer's pin renders no pin-delete-* control. */}
          {mine && (
            <button
              data-testid={`pin-delete-${pin.id}`}
              onClick={requestDeletePin}
              title="Delete pin"
              aria-label="Delete pin"
              style={{
                background: "none",
                border: "none",
                color: "#f85149",
                cursor: "pointer",
                fontSize: 12,
                lineHeight: 1,
                padding: 0,
                fontWeight: 600,
              }}
            >
              Delete
            </button>
          )}
          <button
            onClick={onClose}
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
      </div>
      {/* Confirm strip — only when this pin's delete is armed (author-only). Names
          the blast radius (the pin AND its comments) before committing. Confirm
          is the single emit point; Cancel disarms and emits nothing. */}
      {mine && confirmingDelete && (
        <div
          role="alertdialog"
          aria-label={`Delete this pin and its ${comments.length} comment${comments.length === 1 ? "" : "s"}?`}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "8px",
            borderBottom: "1px solid #30363d",
            background: "rgba(248,81,73,0.08)",
          }}
        >
          <span style={{ color: "#e6edf3" }}>
            Delete this pin and its {comments.length} comment
            {comments.length === 1 ? "" : "s"}? This can&rsquo;t be undone.
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              data-testid={`pin-delete-confirm-${pin.id}`}
              onClick={confirmDeletePin}
              aria-label={`Confirm delete pin and ${comments.length} comment${comments.length === 1 ? "" : "s"}`}
              style={{
                flex: 1,
                padding: "4px 8px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                color: "white",
                background: "#da3633",
                border: "1px solid #f85149",
                borderRadius: 4,
              }}
            >
              Delete {comments.length} comment{comments.length === 1 ? "" : "s"}
            </button>
            <button
              data-testid={`pin-delete-cancel-${pin.id}`}
              onClick={cancelDeletePin}
              aria-label="Cancel delete"
              style={{
                flex: 1,
                padding: "4px 8px",
                fontSize: 12,
                cursor: "pointer",
                color: "#e6edf3",
                background: "transparent",
                border: "1px solid #30363d",
                borderRadius: 4,
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
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
                  // Edit mode: a field seeded with the current text. Enter saves
                  // (trimmed; empty rejected); Escape and blur cancel.
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
                          saveEdit(c.id);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelEdit();
                        }
                      }}
                      onBlur={(e) => {
                        // Blur cancels the edit — UNLESS focus is moving to this
                        // comment's save control, in which case let the save's
                        // click commit it.
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
                      // preventDefault on mousedown keeps focus on the input so
                      // its onBlur cancel doesn't fire first and tear the field
                      // down before the click saves; the actual save runs on
                      // click (so a plain click — real or synthetic — commits).
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => saveEdit(c.id)}
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
                          onClick={() => removeComment(c.id)}
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
          data-testid={`comment-add-input-${pin.id}`}
          value={draft}
          placeholder="Add a comment…"
          aria-label="Add a comment"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addComment();
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
          data-testid={`comment-add-send-${pin.id}`}
          onClick={addComment}
          disabled={!draft.trim()}
          style={{
            padding: "4px 8px",
            fontSize: 12,
            cursor: draft.trim() ? "pointer" : "default",
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
