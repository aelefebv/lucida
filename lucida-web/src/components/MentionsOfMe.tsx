/**
 * "Mentions of me" inbox: every comment in the current dataset that @-mentions
 * the current user, each a jump to its pin.
 *
 * Pure: it reads only its props and reports clicks through `onNavigate`, so the
 * host owns opening the thread and recentering. "Me" is the identity-derived
 * handle plus, when the user's roster row has one, their display-name handle,
 * since nothing links an opaque comment author to a roster email. A match is an
 * exact, case-insensitive token, and the user's own comments count too.
 */
import { AtIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Badge } from "../ui/Badge.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { Popover } from "../ui/Popover.tsx";
import type { Annotation } from "./annotationDocument.ts";
import { splitMentionTokens } from "./annotationMentions.ts";
import { deriveHandle, handleFromName } from "./annotationParticipants.ts";
import "./MentionsOfMe.css";

interface Props {
  /** The current dataset's pins with nested `comments`. Scoping to one dataset
   * is the host's job; cross-dataset aggregation is out of scope. */
  annotations: Annotation[];
  /** The `author` that rides the current user's comments. Its
   * {@link deriveHandle} is always one of "my" handles. */
  currentUserId: string;
  /** Used only to find the user's roster row, so a mention by their
   * display-name handle also counts. Null when unauthenticated. */
  currentUserEmail?: string | null;
  /** The workspace roster, best-effort. Structural so `WorkspaceMember` is
   * assignable without a dependency. */
  members?: { email: string; display_name?: string | null }[];
  /** The host opens the owning pin's thread and recenters on it. */
  onNavigate: (pinId: string) => void;
  /** Comment ids this viewer has viewed, owned and persisted by the host per
   * browser and dataset. The badge counts only ids not in this list. Defaults to
   * `[]` for hosts that don't track read-state. */
  viewedCommentIds?: string[];
  /** Called with {@link onNavigate} when an item is clicked; the host persists
   * it so the mention stays read across reloads. */
  onMarkViewed?: (commentId: string) => void;
}

/** One comment that mentions the current user, with the pin that owns it. */
interface MentionHit {
  pinId: string;
  commentId: string;
  text: string;
}

/** Snippet length before eliding. The full text stays in the item's title. */
const SNIPPET_MAX = 80;

/** Display only: matching runs on the full text, never on this. */
function snippet(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > SNIPPET_MAX ? `${oneLine.slice(0, SNIPPET_MAX - 1)}…` : oneLine;
}

/** The lower-cased handle names, without `@`, that mean "me". */
function buildMyHandles(
  currentUserId: string,
  currentUserEmail: string | null | undefined,
  members: { email: string; display_name?: string | null }[],
): Set<string> {
  const handles = new Set<string>();
  const own = deriveHandle(currentUserId);
  if (own) handles.add(own.toLowerCase());

  const email = currentUserEmail?.trim().toLowerCase();
  if (email) {
    for (const m of members) {
      if (m.email?.trim().toLowerCase() !== email) continue;
      const named = handleFromName(m.display_name);
      if (named) handles.add(named.toLowerCase());
      // No break: a roster may hold duplicate rows for one email.
    }
  }
  return handles;
}

/**
 * Whether `text` holds a mention token naming one of `myHandles`. Uses the same
 * tokenizer as the composer and chips and compares whole tokens, so
 * `@user5xy9more` never matches `@user5xy9`.
 */
function mentionsMe(text: string, myHandles: Set<string>): boolean {
  if (myHandles.size === 0) return false;
  for (const seg of splitMentionTokens(text)) {
    if (seg.kind !== "mention") continue;
    const name = seg.text.slice(1).toLowerCase();
    if (myHandles.has(name)) return true;
  }
  return false;
}

export function MentionsOfMe({
  annotations,
  currentUserId,
  currentUserEmail,
  members = [],
  onNavigate,
  viewedCommentIds = [],
  onMarkViewed,
}: Props) {
  const [open, setOpen] = useState(false);

  const [hideViewed, setHideViewed] = useState(false);

  const viewedSet = useMemo(() => new Set(viewedCommentIds), [viewedCommentIds]);

  // Document order: pins in order, comments within a pin in order.
  const hits = useMemo<MentionHit[]>(() => {
    const myHandles = buildMyHandles(currentUserId, currentUserEmail, members);
    if (myHandles.size === 0) return [];
    const out: MentionHit[] = [];
    for (const pin of annotations) {
      for (const c of pin.comments ?? []) {
        if (typeof c.text === "string" && mentionsMe(c.text, myHandles)) {
          out.push({ pinId: pin.id, commentId: c.id, text: c.text });
        }
      }
    }
    return out;
  }, [annotations, currentUserId, currentUserEmail, members]);

  const unviewedCount = useMemo(
    () => hits.reduce((n, h) => (viewedSet.has(h.commentId) ? n : n + 1), 0),
    [hits, viewedSet],
  );
  const count = unviewedCount;

  const visibleHits = useMemo(
    () => (hideViewed ? hits.filter((h) => !viewedSet.has(h.commentId)) : hits),
    [hits, hideViewed, viewedSet],
  );

  return (
    <Popover
      label="Comments that mention you"
      placement="bottom start"
      className="lc-mentions-popover"
      isOpen={open}
      onOpenChange={setOpen}
      trigger={
        <Button className="lc-mentions-trigger" icon={AtIcon} data-testid="mentions-of-me-badge">
          Mentions
          {/* Shows 0 too, so the trigger's text carries the count in every
              state. */}
          <Badge className="lc-mentions-count" tone={count > 0 ? "accent" : "neutral"}>
            {count}
          </Badge>
        </Button>
      }
    >
      <div className="lc-mentions" data-testid="mentions-of-me-panel">
        {/* Empty-state copy keys off whether any mention exists, not the unread
            count, so a fully read inbox doesn't claim no one ever mentioned
            you. */}
        <div className="lc-mentions-header">
          <span className="lc-mentions-summary">
            {hits.length === 0
              ? "No one has mentioned you here"
              : count === 0
                ? "All mentions read"
                : `${count} unread mention${count === 1 ? "" : "s"}`}
          </span>
          <IconButton
            size="sm"
            icon={EyeSlashIcon}
            label="Hide read mentions"
            tooltipPlacement="bottom"
            isSelected={hideViewed}
            onSelectedChange={setHideViewed}
            data-testid="mentions-of-me-hide-viewed-toggle"
          />
        </div>
        {hits.length === 0 ? (
          <p className="lc-mentions-empty">
            When a collaborator @-mentions you in a comment on this dataset, it shows up
            here.
          </p>
        ) : visibleHits.length === 0 ? (
          // Every mention is read and hidden: say why the list is empty.
          <p className="lc-mentions-empty">
            No unread mentions. Turn off “Hide read mentions” to see the read ones.
          </p>
        ) : (
          <ul className="lc-mentions-list">
            {visibleHits.map((hit) => {
              const isViewed = viewedSet.has(hit.commentId);
              return (
                <li key={hit.commentId}>
                  <button
                    type="button"
                    className="lc-mentions-item"
                    data-testid={`mention-of-me-item-${hit.commentId}`}
                    data-viewed={isViewed ? "true" : "false"}
                    onClick={() => {
                      // The popover would cover the thread this opens, so it
                      // closes first.
                      setOpen(false);
                      onNavigate(hit.pinId);
                      onMarkViewed?.(hit.commentId);
                    }}
                    title={hit.text}
                  >
                    <span className="lc-mentions-item-text">{snippet(hit.text)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Popover>
  );
}
