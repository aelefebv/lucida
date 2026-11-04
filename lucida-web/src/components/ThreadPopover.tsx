/**
 * The comment-thread popover for one annotation pin, shared by the 2D
 * ({@link AnnotationOverlay}) and 3D ({@link AnnotationOverlay3D}) overlays so
 * the thread UI and its testids hold in both views.
 *
 * Every mutation applies locally and sends (`applyDocumentCommand`), because the
 * server leaves the sender out of its rebroadcast; client-supplied ids make both
 * paths converge. State here is per-thread only: hosts key the popover by pin id,
 * so switching pins remounts it and clears drafts. Hosts also position it.
 */
import { useRef, useState, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { applyDocumentCommand } from "../applyAndSend.ts";
import type { Annotation, Comment } from "./annotationDocument.ts";
import {
  splitMentionTokens,
  type MentionCandidate,
} from "./annotationMentions.ts";
import { useMentionAutocomplete } from "./useMentionAutocomplete.ts";
import { deriveHandle } from "./annotationParticipants.ts";
import { buildAnnotationLink } from "../savedView/urlSync.ts";

interface Props {
  /** The pin whose thread this is, with its nested `comments`. */
  pin: Annotation;
  /** The dataset the pin belongs to (commands are scoped per dataset). */
  datasetId: string;
  /** The browser-persisted author identity from `annotationAuthorId()`, not the
   * per-connection `bridge.myId`, so authorship survives rejoining a workspace.
   * Gates the author-only controls and stamps new comments. */
  myId: string;
  /** Live scene handle for the apply-locally half of the seam. */
  wasmSceneRef: RefObject<WasmScene | null>;
  /** Send a wire command (already wrapped by the bridge). */
  sendCommand: (json: string) => void;
  /** Called after a local change so the host re-reads via a fresh `version`. */
  onDocumentChanged: () => void;
  /** The host owns which pin is open, so closing is its call. */
  onClose: () => void;
  /** Who the composer can @-mention. With none, the picker never opens. */
  mentionCandidates?: MentionCandidate[];
  /** Offered only when the pin has a captured `view`; the host runs the light
   * restore. A pin selected on the canvas only recenters, so this is how a
   * viewer opts into the author's framing. */
  onGoToAuthorView?: (pinId: string) => void;
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
  mentionCandidates = [],
  onGoToAuthorView,
}: Props) {
  const [draft, setDraft] = useState("");
  // A mention pick returns focus here so typing continues.
  const addInputRef = useRef<HTMLInputElement>(null);
  // Only one comment edits at a time.
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // One edit field mounts at a time, so one shared ref always points at it.
  const editInputRef = useRef<HTMLInputElement>(null);
  // Nothing is emitted until Confirm, so one click can never destroy a pin and
  // its thread.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const mine = pin.author === String(myId);
  const comments = pin.comments ?? [];

  // Copies `<workspace-url>#a=<pinId>`. A deep link, not an access grant: the
  // recipient still loads the workspace through the existing gate. Any viewer
  // can copy it.
  const copyLink = async () => {
    const link = buildAnnotationLink(pin.id);
    try {
      await navigator.clipboard.writeText(link);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    setTimeout(() => setCopyState("idle"), 2500);
  };

  // Anyone may add a comment.
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

  // Both composers share one hook. The picker derives from the draft, with no
  // open flag, so it can't drift from what's typed. Only one picker is ever
  // open: the edit composer mounts only for the comment being edited.
  const addMention = useMentionAutocomplete(
    draft,
    setDraft,
    mentionCandidates,
    addInputRef,
  );
  const editMention = useMentionAutocomplete(
    editDraft,
    setEditDraft,
    mentionCandidates,
    editInputRef,
  );

  // Author-only.
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

  // Author-only.
  const startEdit = (comment: Comment) => {
    // One active affordance at a time: arming an edit disarms delete.
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
      // An empty edit emits nothing, so a cleared field never wipes the comment.
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

  // Author-only. Delete only arms the confirm; Confirm alone emits
  // remove_annotation, which cascades the pin's whole thread.
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
    // The host closes the thread once the pin is gone; reset anyway so a re-open
    // never resurfaces the confirm.
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
          <button
            data-testid={`pin-copy-link-${pin.id}`}
            onClick={copyLink}
            title="Copy a shareable link to this annotation"
            aria-label="Copy link to this annotation"
            style={{
              background: "none",
              border: "none",
              color: copyState === "failed" ? "#f85149" : "#58a6ff",
              cursor: "pointer",
              fontSize: 12,
              lineHeight: 1,
              padding: 0,
              fontWeight: 600,
            }}
          >
            {copyState === "copied"
              ? "Copied!"
              : copyState === "failed"
                ? "Copy failed"
                : "Copy link"}
          </button>
          {pin.view && (
            <button
              data-testid={`pin-goto-author-view-${pin.id}`}
              onClick={() => onGoToAuthorView?.(pin.id)}
              title="Go to the view the author had when they placed this pin"
              aria-label="Go to author's view"
              style={{
                background: "none",
                border: "none",
                color: "#58a6ff",
                cursor: "pointer",
                fontSize: 12,
                lineHeight: 1,
                padding: 0,
                fontWeight: 600,
              }}
            >
              Go to author&rsquo;s view
            </button>
          )}
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
      {/* Names the blast radius, the pin and its comments, before committing. */}
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
                {/* An author is an opaque per-browser id, so show the handle they
                    are @-mentioned by, never the raw id, capped with an ellipsis
                    so it can't overflow the panel. Self stays "you". */}
                <span
                  title={mineComment ? "you" : deriveHandle(c.author)}
                  style={{
                    color: "#58a6ff",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    maxWidth: 120,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {mineComment ? "you" : deriveHandle(c.author)}
                </span>
                {isEditing ? (
                  // Same @-mention autocomplete as the add box. Enter saves when
                  // the picker is closed; Escape and blur cancel.
                  <>
                    {/* Positions the mention picker just above the field, as in
                        the add composer. */}
                    <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
                      {editMention.open && (
                        <div
                          data-testid={`mention-picker-edit-${c.id}`}
                          role="listbox"
                          aria-label="Mention a collaborator"
                          style={{
                            position: "absolute",
                            left: 0,
                            right: 0,
                            bottom: "100%",
                            marginBottom: 4,
                            maxHeight: 132,
                            overflowY: "auto",
                            background: "#161b22",
                            border: "1px solid #30363d",
                            borderRadius: 6,
                            boxShadow: "0 4px 12px rgba(0,0,0,0.6)",
                            zIndex: 1,
                          }}
                        >
                          {editMention.matches.map((candidate) => (
                            <button
                              key={candidate.id}
                              type="button"
                              role="option"
                              data-testid={`mention-option-${candidate.id}`}
                              // Keeps focus on the edit input so its blur cancel
                              // doesn't fire and `pick`'s refocus lands on a live
                              // field.
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => editMention.pick(candidate.label)}
                              style={{
                                display: "block",
                                width: "100%",
                                textAlign: "left",
                                padding: "5px 8px",
                                fontSize: 12,
                                background: "none",
                                border: "none",
                                color: "#e6edf3",
                                cursor: "pointer",
                              }}
                            >
                              <span style={{ color: "#58a6ff", fontWeight: 600 }}>
                                @
                              </span>
                              {candidate.label}
                            </button>
                          ))}
                        </div>
                      )}
                      <input
                        ref={editInputRef}
                        type="text"
                        data-testid={`comment-edit-input-${c.id}`}
                        value={editDraft}
                        autoFocus
                        aria-label="Edit comment"
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            // With the picker open, Enter picks the top match;
                            // it saves only with the picker closed.
                            if (editMention.open) {
                              e.preventDefault();
                              editMention.pick(editMention.matches[0].label);
                              return;
                            }
                            e.preventDefault();
                            saveEdit(c.id);
                          } else if (e.key === "Escape") {
                            if (editMention.open) {
                              // Escape first dismisses the picker (a trailing
                              // space closes the token) without cancelling the edit.
                              e.preventDefault();
                              setEditDraft((cur) => `${cur} `);
                              return;
                            }
                            e.preventDefault();
                            cancelEdit();
                          }
                        }}
                        onBlur={(e) => {
                          // Blur cancels unless focus is moving to this comment's
                          // save control. Mention picks prevent the mousedown
                          // default, so they never blur.
                          const next = e.relatedTarget as HTMLElement | null;
                          if (
                            next?.dataset?.testid === `comment-edit-save-${c.id}`
                          ) {
                            return;
                          }
                          cancelEdit();
                        }}
                        style={{
                          width: "100%",
                          minWidth: 0,
                          padding: "2px 4px",
                          fontSize: 12,
                          background: "#0d1117",
                          color: "#e6edf3",
                          border: "1px solid #30363d",
                          borderRadius: 4,
                          boxSizing: "border-box",
                        }}
                      />
                    </div>
                    <button
                      data-testid={`comment-edit-save-${c.id}`}
                      // Keeps focus on the input so its blur cancel doesn't tear
                      // the field down before the click saves.
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
                    {/* Chips are styling only: every segment renders as text,
                        never HTML. */}
                    <span style={{ wordBreak: "break-word", flex: 1 }}>
                      {splitMentionTokens(c.text).map((seg, i) =>
                        seg.kind === "mention" ? (
                          <span
                            key={i}
                            data-testid="mention-chip"
                            style={{
                              color: "#58a6ff",
                              backgroundColor: "rgba(56,139,253,0.15)",
                              borderRadius: 4,
                              padding: "0 3px",
                              fontWeight: 600,
                            }}
                          >
                            {seg.text}
                          </span>
                        ) : (
                          <span key={i}>{seg.text}</span>
                        ),
                      )}
                    </span>
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
      <div
        style={{
          position: "relative",
          display: "flex",
          gap: 4,
          padding: 6,
          borderTop: "1px solid #30363d",
        }}
      >
        {/* Floats above the composer because the popover clips its own
            overflow. */}
        {addMention.open && (
          <div
            data-testid={`mention-picker-${pin.id}`}
            role="listbox"
            aria-label="Mention a collaborator"
            style={{
              position: "absolute",
              left: 6,
              right: 6,
              bottom: "100%",
              marginBottom: 4,
              maxHeight: 132,
              overflowY: "auto",
              background: "#161b22",
              border: "1px solid #30363d",
              borderRadius: 6,
              boxShadow: "0 4px 12px rgba(0,0,0,0.6)",
              zIndex: 1,
            }}
          >
            {addMention.matches.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                role="option"
                data-testid={`mention-option-${candidate.id}`}
                // Keeps focus on the input so `pick`'s refocus lands on a live
                // field.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addMention.pick(candidate.label)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "5px 8px",
                  fontSize: 12,
                  background: "none",
                  border: "none",
                  color: "#e6edf3",
                  cursor: "pointer",
                }}
              >
                <span style={{ color: "#58a6ff", fontWeight: 600 }}>@</span>
                {candidate.label}
              </button>
            ))}
          </div>
        )}
        <input
          ref={addInputRef}
          type="text"
          data-testid={`comment-add-input-${pin.id}`}
          value={draft}
          placeholder="Add a comment…"
          aria-label="Add a comment"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // With the picker open, Enter picks the top match; it sends only
              // with the picker closed.
              if (addMention.open) {
                e.preventDefault();
                addMention.pick(addMention.matches[0].label);
                return;
              }
              e.preventDefault();
              addComment();
            } else if (e.key === "Escape" && addMention.open) {
              // Escape dismisses the picker by appending a space, which closes
              // the token, without sending or losing the draft.
              e.preventDefault();
              setDraft((cur) => `${cur} `);
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
