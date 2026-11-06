/**
 * The comment-thread popover for one annotation pin, shared by the 2D
 * ({@link AnnotationOverlay}) and 3D ({@link AnnotationOverlay3D}) overlays so
 * the thread UI and its testids hold in both views.
 *
 * Every mutation applies locally and sends (`applyDocumentCommand`), because the
 * server leaves the sender out of its rebroadcast; client-supplied ids make both
 * paths converge. State here is per-thread only: hosts key the popover by pin id,
 * so switching pins remounts it and clears drafts. Hosts move it with its pin,
 * and it keeps itself on screen beside it.
 */
import {
  CheckIcon,
  FrameCornersIcon,
  LinkIcon,
  PencilSimpleIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { applyDocumentCommand } from "../applyAndSend.ts";
import { useThreadPlacement } from "./threadPlacement.ts";
import type { Annotation, Comment } from "./annotationDocument.ts";
import {
  splitMentionTokens,
  type MentionCandidate,
} from "./annotationMentions.ts";
import { useMentionAutocomplete } from "./useMentionAutocomplete.ts";
import { deriveHandle } from "./annotationParticipants.ts";
import { buildAnnotationLink } from "../savedView/urlSync.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { useShortcut, useShortcutScope } from "../ui/shortcuts.ts";
import { TextField } from "../ui/TextField.tsx";
import { toast } from "../ui/toastQueue.ts";
import "./ThreadPopover.css";

/** Takes precedence over global shortcuts while a thread is open. */
const THREAD_SHORTCUT_SCOPE = "annotation-thread";

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
  /** Open with the delete confirm already showing, when a delete was asked
   * for outside the thread. */
  armDelete?: boolean;
  /** Open with the comment field focused, for a pin made to comment on. */
  focusComposer?: boolean;
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
  armDelete = false,
  focusComposer = false,
}: Props) {
  const [draft, setDraft] = useState("");
  // A mention pick returns focus here so typing continues.
  const addInputRef = useRef<HTMLInputElement>(null);
  // Only one comment edits at a time.
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // One edit field mounts at a time, so one shared ref always points at it.
  const editInputRef = useRef<HTMLInputElement>(null);
  const mine = pin.author === String(myId);
  // Nothing is emitted until Confirm, so one click can never destroy a pin and
  // its thread.
  const [confirmingDelete, setConfirmingDelete] = useState(armDelete && mine);
  const rootRef = useRef<HTMLDivElement>(null);
  useThreadPlacement(rootRef);

  // A frame late, once the menu that asked for it has let go of focus;
  // autoFocus would lose to the closing menu's focus containment.
  useEffect(() => {
    if (!focusComposer) return;
    const frame = requestAnimationFrame(() => addInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusComposer]);

  const comments = pin.comments ?? [];

  // Copies `<workspace-url>#a=<pinId>`. A deep link, not an access grant: the
  // recipient still loads the workspace through the existing gate. Any viewer
  // can copy it.
  const copyLink = async () => {
    const link = buildAnnotationLink(pin.id);
    try {
      await navigator.clipboard.writeText(link);
      toast({ title: "Link copied", tone: "success" });
    } catch (e) {
      toast({
        title: "Couldn't copy the link",
        description: e instanceof Error ? e.message : String(e),
        tone: "danger",
      });
    }
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

  // Escape closes the thread wherever focus is. With focus inside, the root
  // catches it below; elsewhere this binding does, ahead of any global Escape.
  useShortcutScope(THREAD_SHORTCUT_SCOPE, true);
  useShortcut({
    id: "annotations.closeThread",
    keys: "Escape",
    label: "Close the comment thread",
    group: "Annotations",
    scope: THREAD_SHORTCUT_SCOPE,
    onTrigger: onClose,
  });

  const commentCount = `${comments.length} comment${comments.length === 1 ? "" : "s"}`;

  return (
    <div
      ref={rootRef}
      className="lc-thread"
      data-testid={`annot-thread-${pin.id}`}
      role="dialog"
      aria-label="Comment thread"
      // Marks an open overlay, so app shortcuts stay quiet while focus is here.
      data-lc-overlay=""
      onKeyDown={(e) => {
        // The fields handle their own Escape (closing the picker, cancelling an
        // edit), so only an unhandled one closes the thread.
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        onClose();
      }}
    >
      <div className="lc-thread-header">
        <span className="lc-thread-title">Thread</span>
        {comments.length > 0 && <Badge>{comments.length}</Badge>}
        <div className="lc-thread-actions">
          <Button
            size="sm"
            variant="ghost"
            icon={LinkIcon}
            onPress={copyLink}
            data-testid={`pin-copy-link-${pin.id}`}
          >
            Copy link
          </Button>
          {pin.view && (
            <IconButton
              size="sm"
              icon={FrameCornersIcon}
              label="Go to author’s view"
              onPress={() => onGoToAuthorView?.(pin.id)}
              data-testid={`pin-goto-author-view-${pin.id}`}
            />
          )}
          {mine && (
            <IconButton
              size="sm"
              icon={TrashIcon}
              label="Delete pin"
              onPress={requestDeletePin}
              data-testid={`pin-delete-${pin.id}`}
            />
          )}
          <IconButton size="sm" icon={XIcon} label="Close thread" shortcut="Escape" onPress={onClose} />
        </div>
      </div>
      {/* Names the blast radius, the pin and its comments, before committing. */}
      {mine && confirmingDelete && (
        <div
          className="lc-thread-confirm"
          role="alertdialog"
          aria-label={`Delete this pin and its ${commentCount}?`}
        >
          <p className="lc-thread-confirm-text">
            Delete this pin and its {commentCount}? This can&rsquo;t be undone.
          </p>
          <div className="lc-thread-confirm-actions">
            <Button size="sm" onPress={cancelDeletePin} data-testid={`pin-delete-cancel-${pin.id}`}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              onPress={confirmDeletePin}
              data-testid={`pin-delete-confirm-${pin.id}`}
            >
              Delete {commentCount}
            </Button>
          </div>
        </div>
      )}
      <div className="lc-thread-comments">
        {comments.length === 0 ? (
          <p className="lc-thread-empty">No comments yet. Start the discussion.</p>
        ) : (
          comments.map((c) => {
            const mineComment = c.author === String(myId);
            const isEditing = mineComment && editingCommentId === c.id;
            // An author is an opaque per-browser id, so show the handle they are
            // @-mentioned by, never the raw id. Self stays "you".
            const authorName = mineComment ? "you" : deriveHandle(c.author);
            return (
              <div key={c.id} className="lc-thread-comment">
                <div className="lc-thread-comment-head">
                  <span className="lc-thread-author" title={authorName}>
                    {authorName}
                  </span>
                  {mineComment && !isEditing && (
                    <span className="lc-thread-comment-actions">
                      <IconButton
                        size="sm"
                        icon={PencilSimpleIcon}
                        label="Edit comment"
                        onPress={() => startEdit(c)}
                        data-testid={`comment-edit-${c.id}`}
                      />
                      <IconButton
                        size="sm"
                        icon={TrashIcon}
                        label="Remove comment"
                        onPress={() => removeComment(c.id)}
                      />
                    </span>
                  )}
                </div>
                {isEditing ? (
                  // Same @-mention autocomplete as the add box. Enter saves when
                  // the picker is closed; Escape and blur cancel.
                  <div className="lc-thread-composer">
                    {editMention.open && (
                      <MentionPicker
                        testId={`mention-picker-edit-${c.id}`}
                        matches={editMention.matches}
                        onPick={editMention.pick}
                      />
                    )}
                    <TextField
                      className="lc-thread-composer-field"
                      label="Edit comment"
                      labelPosition="hidden"
                      value={editDraft}
                      onChange={setEditDraft}
                      autoFocus
                      inputRef={editInputRef}
                      data-testid={`comment-edit-input-${c.id}`}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          // With the picker open, Enter picks the top match; it
                          // saves only with the picker closed.
                          e.preventDefault();
                          if (editMention.open) editMention.pick(editMention.matches[0].label);
                          else saveEdit(c.id);
                        } else if (e.key === "Escape") {
                          // Escape first dismisses the picker (a trailing space
                          // closes the token) without cancelling the edit.
                          e.preventDefault();
                          if (editMention.open) setEditDraft((cur) => `${cur} `);
                          else cancelEdit();
                        }
                      }}
                      onBlur={(e) => {
                        // Blur cancels unless focus is moving to this comment's
                        // save control. Mention picks prevent the mousedown
                        // default, so they never blur.
                        const next = e.relatedTarget as HTMLElement | null;
                        if (next?.dataset?.testid === `comment-edit-save-${c.id}`) return;
                        cancelEdit();
                      }}
                    />
                    <IconButton
                      icon={CheckIcon}
                      label="Save comment"
                      onPress={() => saveEdit(c.id)}
                      data-testid={`comment-edit-save-${c.id}`}
                    />
                  </div>
                ) : (
                  // Chips are styling only: every segment renders as text, never
                  // HTML.
                  <p className="lc-thread-text">
                    {splitMentionTokens(c.text).map((seg, i) =>
                      seg.kind === "mention" ? (
                        <span key={i} className="lc-thread-mention" data-testid="mention-chip">
                          {seg.text}
                        </span>
                      ) : (
                        <span key={i}>{seg.text}</span>
                      ),
                    )}
                  </p>
                )}
              </div>
            );
          })
        )}
      </div>
      <div className="lc-thread-composer lc-thread-footer">
        {/* Floats above the composer because the popover clips its own
            overflow. */}
        {addMention.open && (
          <MentionPicker
            testId={`mention-picker-${pin.id}`}
            matches={addMention.matches}
            onPick={addMention.pick}
          />
        )}
        <TextField
          className="lc-thread-composer-field"
          label="Add a comment"
          labelPosition="hidden"
          placeholder="Add a comment…"
          value={draft}
          onChange={setDraft}
          inputRef={addInputRef}
          data-testid={`comment-add-input-${pin.id}`}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // With the picker open, Enter picks the top match; it sends only
              // with the picker closed.
              e.preventDefault();
              if (addMention.open) addMention.pick(addMention.matches[0].label);
              else addComment();
            } else if (e.key === "Escape") {
              // The field keeps its keys to itself, so it handles the thread's
              // Escape too. With the picker open, a trailing space closes the
              // token and keeps the draft.
              e.preventDefault();
              if (addMention.open) setDraft((cur) => `${cur} `);
              else onClose();
            }
          }}
        />
        <Button
          variant="primary"
          onPress={addComment}
          isDisabled={!draft.trim()}
          data-testid={`comment-add-send-${pin.id}`}
        >
          Send
        </Button>
      </div>
    </div>
  );
}

/**
 * The @-mention picker above a composer. Options keep focus in the field
 * (mousedown is prevented), so typing continues and an edit field's blur never
 * cancels the edit.
 */
function MentionPicker({
  testId,
  matches,
  onPick,
}: {
  testId: string;
  matches: MentionCandidate[];
  onPick: (label: string) => void;
}) {
  return (
    <div className="lc-thread-picker" data-testid={testId} role="listbox" aria-label="Mention a collaborator">
      {matches.map((candidate, i) => (
        <button
          key={candidate.id}
          type="button"
          role="option"
          // Enter picks the top match, so it reads as the selected one.
          aria-selected={i === 0}
          className="lc-thread-picker-option"
          data-testid={`mention-option-${candidate.id}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(candidate.label)}
        >
          <span className="lc-thread-picker-at">@</span>
          {candidate.label}
        </button>
      ))}
    </div>
  );
}
