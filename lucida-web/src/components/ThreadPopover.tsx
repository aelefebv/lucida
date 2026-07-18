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
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
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
import type { RenderLoop } from "../renderLoop.ts";
import { useFloatingSurfacePlacement } from "./useFloatingSurfacePlacement.ts";
import "./ThreadPopover.css";

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
  /** People who can be @-mentioned in this thread's composer (issue #526),
   * threaded down from the host overlay (which in production derives them from
   * the document's participants). A mention is inline `@name` text, so picking
   * one only edits the draft — it rides the SAME `add_comment` as any comment.
   * Optional + defaulted to `[]` so the thread works with no candidates (the
   * picker simply never opens). */
  mentionCandidates?: MentionCandidate[];
  /** Jump to the author's captured view for this pin (annotation-views slice 2).
   * Rendered as a "Go to author's view" affordance ONLY when the pin carries a
   * captured `view` (older pins have none → no button). The host performs the
   * full LIGHT restore (camera + z/t/c + display, no dataset opening/hiding, no
   * layout broadcast). This is how a pin selected PASSIVELY on the canvas (which
   * stays a gentle recenter) opts into the author's framing on demand. Optional
   * + defaulted to a no-op so the thread works unwired (e.g. a test harness). */
  onGoToAuthorView?: (pinId: string) => void;
  frameSignal?: Pick<RenderLoop, "subscribePresentedFrame"> | null;
  /** Stable focus fallback when the projected marker is clipped, deleted, or
   * removed with its overlay. Both 2D and 3D hosts already own this canvas. */
  canvas: HTMLCanvasElement;
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
  frameSignal,
  canvas,
}: Props) {
  // Draft text for a NEW comment in this thread.
  const [draft, setDraft] = useState("");
  // The add-comment input element, so picking a mention can return focus to it
  // (the contract: a pick keeps focus in the input so typing continues).
  const addInputRef = useRef<HTMLInputElement>(null);
  // The comment currently being edited (by id), or null, plus its in-flight
  // text. Only one comment edits at a time — opening another (or saving/
  // cancelling) replaces it.
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // The edit input element, so picking a mention while editing returns focus to
  // it (same contract as the add box). Only one edit field is mounted at a time
  // (one comment edits at a time), so a single shared ref always points at the
  // live edit input.
  const editInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editingCommentId === null) return;
    editInputRef.current?.focus();
    editInputRef.current?.select();
  }, [editingCommentId]);
  // Whether this pin's delete is armed (two-step confirm). A small piece of
  // local UI state — NOT a modal — that turns the Delete trigger into a
  // Confirm/Cancel. Nothing is emitted until Confirm, so a pin and its whole
  // thread can never be destroyed by a single click.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Transient feedback for the "Copy link" share affordance (annotation-views
  // slice 3): flips the label to "Copied!" briefly after a successful copy (or
  // "Copy failed" if the clipboard write rejects). A tiny per-thread UI signal —
  // not a command, not synced.
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const subscribeToAnchorMotion = useCallback(
    (listener: () => void) => frameSignal?.subscribePresentedFrame(listener) ?? (() => {}),
    [frameSignal],
  );
  const {
    surfaceRef: popoverRef,
    placement,
    anchorHidden,
    anchorSeenVisible,
    maxSize,
  } = useFloatingSurfacePlacement({
    parentAnchor: true,
    coordinateSpace: "anchor",
    fallbackSize: { width: 240, height: 280 },
    subscribe: subscribeToAnchorMotion,
    focusFallbackElement: canvas,
    restoreFocusOnUnmount: true,
  });

  // The projected marker can leave the canvas while the thread is open (pan,
  // zoom, or a 3D camera move). Once the shared placement owner says the
  // marker's *painted button* is wholly clipped, close the declarative thread
  // state as well as hiding/inerting this frame. That clears aria-expanded on
  // the trigger and prevents an edge-clamped ghost dialog from staying active.
  useEffect(() => {
    if (anchorHidden && anchorSeenVisible) onClose();
  }, [anchorHidden, anchorSeenVisible, onClose]);

  const mine = pin.author === String(myId);
  const comments = pin.comments ?? [];

  // --- Copy a shareable deep-link to this pin (slice 3) ----------------------
  // Builds `<workspace-url>#a=<pinId>` from the live location and copies it to
  // the clipboard. A deep-link, NOT an access grant: it widens nothing — the
  // recipient still loads the workspace through the existing gate, and the
  // annotation lives in that workspace's document. Available to ANY viewer of
  // the pin (mirrors "Go to author's view"), not just the author.
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

  // --- @-mention autocomplete (issue #526) ----------------------------------
  // BOTH composers — the add box and the inline edit field — get identical
  // mention autocomplete from the SAME hook (see useMentionAutocomplete): it
  // derives the in-progress `@query` and matching candidates PURELY from the
  // draft (no open/closed flag, so the picker can't drift from what's typed) and
  // exposes a `pick` that rewrites the draft to `@<label> ` and refocuses the
  // input. A mention is just text, so picking only edits the draft — sending
  // stays the unchanged `add_comment` / `edit_comment`. Only one picker is ever
  // open: the edit composer mounts only while editing, and within it the picker
  // shows only for the comment being edited.
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
    // Escape is observed on the dialog container as it bubbles from the active
    // child control; the dialog itself is deliberately not a tab stop.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={popoverRef}
      id={`annot-thread-${pin.id}`}
      data-testid={`annot-thread-${pin.id}`}
      role="dialog"
      aria-label="Annotation discussion"
      className="thread-popover"
      data-floating-surface=""
      data-floating-safe-region
      data-anchor-hidden={anchorHidden ? "true" : undefined}
      hidden={anchorHidden}
      aria-hidden={anchorHidden || undefined}
      inert={anchorHidden || undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape" && editingCommentId === null && !confirmingDelete) onClose();
      }}
      style={{
        top: placement.top,
        left: placement.left,
        maxWidth: maxSize?.width,
        maxHeight: maxSize ? `min(17.5rem, ${maxSize.height}px)` : undefined,
      }}
    >
      <div className="thread-popover-header">
        <span>Thread{comments.length > 0 ? ` (${comments.length})` : ""}</span>
        <div className="thread-popover-actions">
          {/* "Copy link" — a shareable annotation DEEP-LINK
              (`<workspace-url>#a=<pinId>`) to the clipboard (annotation-views
              slice 3). Always present (any pin can be linked) and available to
              ANY viewer, not just the author. It is a deep-link, not an access
              grant: the recipient still loads the workspace through the existing
              gate. The label flips to transient feedback after a copy. */}
          <button
            data-testid={`pin-copy-link-${pin.id}`}
            onClick={copyLink}
            title="Copy a shareable link to this annotation"
            aria-label="Copy link to this annotation"
            className={`thread-action ${copyState === "failed" ? "danger" : "accent"}`}
          >
            {copyState === "copied"
              ? "Copied!"
              : copyState === "failed"
                ? "Copy failed"
                : "Copy link"}
          </button>
          {/* "Go to author's view" — the explicit, on-demand full restore of the
              view the author had when they dropped this pin (annotation-views
              slice 2). Rendered ONLY when the pin carries a captured `view`
              (older view-less pins show nothing here). Clicking it asks the host
              to restore the author's camera/z-t-c/display (LIGHT tier: local
              only, no dataset opening/hiding, no shared-layout broadcast). This
              is how a pin selected passively on the canvas — which stays a gentle
              recenter — opts into the author's framing. Anyone (not just the
              author) can use it. */}
          {pin.view && (
            <button
              data-testid={`pin-goto-author-view-${pin.id}`}
              onClick={() => onGoToAuthorView?.(pin.id)}
              title="Go to the view the author had when they placed this pin"
              aria-label="Go to author's view"
              className="thread-action accent"
            >
              Go to author&rsquo;s view
            </button>
          )}
          {/* Delete trigger — author-only. Activating it arms the confirm below
              (it does NOT emit), so a pin and its whole thread can never be
              removed in one click. A peer's pin renders no pin-delete-* control. */}
          {mine && (
            <button
              data-testid={`pin-delete-${pin.id}`}
              onClick={requestDeletePin}
              title="Delete pin"
              aria-label="Delete pin"
              className="thread-action danger"
            >
              Delete
            </button>
          )}
          <button
            onClick={onClose}
            aria-label="Close thread"
            className="thread-action close"
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
          className="thread-delete-confirm"
        >
          <span className="thread-delete-message">
            Delete this pin and its {comments.length} comment
            {comments.length === 1 ? "" : "s"}? This can&rsquo;t be undone.
          </span>
          <div className="thread-delete-actions">
            <button
              data-testid={`pin-delete-confirm-${pin.id}`}
              onClick={confirmDeletePin}
              aria-label={`Confirm delete pin and ${comments.length} comment${comments.length === 1 ? "" : "s"}`}
              className="thread-delete-button danger"
            >
              Delete {comments.length} comment{comments.length === 1 ? "" : "s"}
            </button>
            <button
              data-testid={`pin-delete-cancel-${pin.id}`}
              onClick={cancelDeletePin}
              aria-label="Cancel delete"
              className="thread-delete-button"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="thread-comment-list">
        {comments.length === 0 ? (
          <div className="thread-comment-empty">
            No comments yet. Start the discussion.
          </div>
        ) : (
          comments.map((c) => {
            const mineComment = c.author === String(myId);
            const isEditing = mineComment && editingCommentId === c.id;
            return (
              <div
                key={c.id}
                className="thread-comment-row"
              >
                {/* gh #801: a comment author is an opaque per-browser id (#777). Show
                    the SAME short, readable handle they're @-mentioned by
                    (deriveHandle) — never the raw UUID — and cap the width with an
                    ellipsis so a long name can never overflow the thread panel. Self
                    stays "you". `title` keeps the full handle on hover. */}
                <span
                  title={mineComment ? "you" : deriveHandle(c.author)}
                  className="thread-comment-author"
                >
                  {mineComment ? "you" : deriveHandle(c.author)}
                </span>
                {isEditing ? (
                  // Edit mode: a field seeded with the current text, with the
                  // SAME @-mention autocomplete as the add box (driven by the
                  // shared `editMention` hook above). Enter saves when the picker
                  // is closed (trimmed; empty rejected); Escape and blur cancel.
                  <>
                    {/* The edit input + its mention picker share this relatively
                        positioned wrapper so the picker floats just above the
                        field (mirroring the add composer). It flexes to fill the
                        comment row where the bare input used to. */}
                    <div className="thread-edit-field">
                      {/* Edit mention picker (issue #526): only ever open while
                          THIS comment is the one being edited AND a mention is in
                          progress with matches, so only one picker shows at a
                          time. Each option inserts `@label ` into the edit draft;
                          nothing here is a command — saving stays the unchanged
                          edit_comment. */}
                      {editMention.open && (
                        <div
                          id={`mention-picker-edit-${c.id}`}
                          data-testid={`mention-picker-edit-${c.id}`}
                          role="listbox"
                          aria-label="Mention a collaborator"
                          className="thread-mention-picker"
                        >
                          {editMention.matches.map((candidate) => (
                            <button
                              id={`mention-option-edit-${c.id}-${candidate.id}`}
                              key={candidate.id}
                              type="button"
                              role="option"
                              aria-selected={candidate.id === editMention.matches[0]?.id}
                              data-testid={`mention-option-${candidate.id}`}
                              // preventDefault on mousedown keeps focus on the
                              // edit input through the click, so its onBlur cancel
                              // doesn't fire and `pick`'s refocus lands on a live
                              // field — the picker reopens cleanly for the next
                              // mention.
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => editMention.pick(candidate.label)}
                              className="thread-mention-option"
                            >
                              <span className="thread-mention-mark">
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
                        role="combobox"
                        aria-autocomplete="list"
                        aria-expanded={editMention.open}
                        aria-controls={editMention.open ? `mention-picker-edit-${c.id}` : undefined}
                        aria-activedescendant={editMention.open
                          ? `mention-option-edit-${c.id}-${editMention.matches[0]?.id}`
                          : undefined}
                        aria-label="Edit comment"
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            // While the picker is open, Enter picks the top match
                            // and keeps editing; only with the picker CLOSED does
                            // Enter save (per contract, matching the add box).
                            if (editMention.open) {
                              e.preventDefault();
                              editMention.pick(editMention.matches[0].label);
                              return;
                            }
                            e.preventDefault();
                            saveEdit(c.id);
                          } else if (e.key === "Escape") {
                            if (editMention.open) {
                              // Escape first dismisses the picker (close the token
                              // with a trailing space) without cancelling the edit
                              // or losing the draft.
                              e.preventDefault();
                              setEditDraft((cur) => `${cur} `);
                              return;
                            }
                            e.preventDefault();
                            cancelEdit();
                          }
                        }}
                        onBlur={(e) => {
                          // Blur cancels the edit — UNLESS focus is moving to this
                          // comment's save control, in which case let the save's
                          // click commit it. (Picking a mention preventDefaults
                          // the option's mousedown, so blur never fires for it.)
                          const next = e.relatedTarget as HTMLElement | null;
                          if (
                            next?.dataset?.testid === `comment-edit-save-${c.id}`
                          ) {
                            return;
                          }
                          cancelEdit();
                        }}
                        className="thread-edit-input"
                      />
                    </div>
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
                      className="thread-action success"
                    >
                      ✓
                    </button>
                  </>
                ) : (
                  <>
                    {/* The comment text, with each `@mention` token highlighted
                        as a distinct chip and every other character rendered
                        verbatim. Both come from {@link splitMentionTokens}, which
                        carries the raw source substring per segment — so the chip
                        is pure styling and comment content is ALWAYS rendered as
                        TEXT (React escapes it), never injected as HTML. A comment
                        with no mention yields a single text segment, so it renders
                        no mention-chip at all. */}
                    <span className="thread-comment-text">
                      {splitMentionTokens(c.text).map((seg, i) =>
                        seg.kind === "mention" ? (
                          <span
                            key={i}
                            data-testid="mention-chip"
                            className="thread-mention-chip"
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
                          className="thread-action"
                        >
                          ✎
                        </button>
                        <button
                          onClick={() => removeComment(c.id)}
                          title="Remove comment"
                          aria-label="Remove comment"
                          className="thread-action"
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
      <div className="thread-composer">
        {/* @-mention picker (issue #526): rendered ONLY while a mention is being
            typed AND at least one candidate matches (an empty/no-match query
            renders nothing — the user can still send the raw text). It floats
            just above the composer (the popover clips its own overflow, so the
            picker escapes upward to stay readable). Each option inserts `@label `
            into the draft; nothing here is a command — sending stays the
            unchanged `add_comment`. */}
        {addMention.open && (
          <div
            id={`mention-picker-${pin.id}`}
            data-testid={`mention-picker-${pin.id}`}
            role="listbox"
            aria-label="Mention a collaborator"
            className="thread-mention-picker"
          >
            {addMention.matches.map((candidate) => (
              <button
                id={`mention-option-add-${pin.id}-${candidate.id}`}
                key={candidate.id}
                type="button"
                role="option"
                aria-selected={candidate.id === addMention.matches[0]?.id}
                data-testid={`mention-option-${candidate.id}`}
                // Keep focus on the input through the click: preventing the
                // mousedown default stops the input's blur, so `pick`'s refocus
                // lands on a still-focused field and the picker reopens cleanly
                // for the next mention.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addMention.pick(candidate.label)}
                className="thread-mention-option"
              >
                <span className="thread-mention-mark">@</span>
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
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={addMention.open}
          aria-controls={addMention.open ? `mention-picker-${pin.id}` : undefined}
          aria-activedescendant={addMention.open
            ? `mention-option-add-${pin.id}-${addMention.matches[0]?.id}`
            : undefined}
          aria-label="Add a comment"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // While the picker is open, Enter belongs to the picker, not to
              // sending: pick the first (top) match and keep typing. Only when
              // the picker is CLOSED does Enter send the comment (per contract).
              if (addMention.open) {
                e.preventDefault();
                addMention.pick(addMention.matches[0].label);
                return;
              }
              e.preventDefault();
              addComment();
            } else if (e.key === "Escape" && addMention.open) {
              // Escape dismisses the picker without sending or losing the draft:
              // append a space to close the active token (the picker derives
              // from the draft, so a trailing space ends the mention run).
              e.preventDefault();
              setDraft((cur) => `${cur} `);
            }
          }}
          className="thread-add-input"
        />
        <button
          data-testid={`comment-add-send-${pin.id}`}
          onClick={addComment}
          disabled={!draft.trim()}
          className="thread-send-button"
        >
          Send
        </button>
      </div>
    </div>
  );
}
