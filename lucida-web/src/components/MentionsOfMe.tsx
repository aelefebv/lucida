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
import { useMemo, useState } from "react";
import type { Annotation } from "./annotationDocument.ts";
import { splitMentionTokens } from "./annotationMentions.ts";
import { deriveHandle, handleFromName } from "./annotationParticipants.ts";

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
    <div style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        data-testid="mentions-of-me-badge"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={
          count === 0
            ? "Mentions of me: no unread"
            : `Mentions of me: ${count} unread comment${count === 1 ? "" : "s"}`
        }
        title={
          count === 0
            ? "No unread mentions in this dataset"
            : `${count} unread comment${count === 1 ? "" : "s"} mention you — click to view`
        }
        style={{
          padding: "0.375rem 0.75rem",
          fontSize: "0.875rem",
          whiteSpace: "nowrap",
          display: "inline-flex",
          alignItems: "center",
          gap: "0.35rem",
          // Same accent as the sibling toolbar toggles.
          background: open ? "#646cff" : count > 0 ? "#1f6feb" : undefined,
          color: open || count > 0 ? "#fff" : undefined,
        }}
      >
        <span aria-hidden="true">@</span>
        <span>Mentions</span>
        {/* Shows 0 too, so the badge's textContent carries the count in every
            state. */}
        <span
          style={{
            minWidth: 16,
            height: 16,
            padding: "0 4px",
            borderRadius: 8,
            background: count > 0 ? "#da3633" : "rgba(255,255,255,0.18)",
            color: "#fff",
            fontSize: 11,
            lineHeight: "16px",
            textAlign: "center",
            fontWeight: 700,
          }}
        >
          {count}
        </span>
      </button>
      {open && (
        <div
          data-testid="mentions-of-me-panel"
          role="dialog"
          aria-label="Comments that mention you"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            width: 320,
            maxHeight: 360,
            overflowY: "auto",
            background: "rgba(22,27,34,0.98)",
            color: "#e6edf3",
            border: "1px solid #30363d",
            borderRadius: 8,
            boxShadow: "0 6px 18px rgba(0,0,0,0.6)",
            zIndex: 50,
            fontSize: 12,
          }}
        >
          {/* Empty-state copy keys off whether any mention exists, not the
              unread count, so a fully read inbox doesn't claim no one ever
              mentioned you. */}
          <div
            style={{
              padding: "8px 10px",
              borderBottom: "1px solid #30363d",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span>
              {hits.length === 0
                ? "No one has mentioned you here"
                : count === 0
                  ? "All mentions read"
                  : `${count} unread mention${count === 1 ? "" : "s"}`}
            </span>
            <button
              type="button"
              data-testid="mentions-of-me-hide-viewed-toggle"
              onClick={() => setHideViewed((v) => !v)}
              aria-pressed={hideViewed}
              aria-label={hideViewed ? "Show viewed mentions" : "Hide viewed mentions"}
              title={hideViewed ? "Show viewed mentions" : "Hide viewed mentions"}
              style={{
                padding: "2px 8px",
                fontSize: 11,
                fontWeight: 600,
                whiteSpace: "nowrap",
                borderRadius: 6,
                border: "1px solid #30363d",
                cursor: "pointer",
                background: hideViewed ? "#646cff" : "transparent",
                color: hideViewed ? "#fff" : "#8b949e",
              }}
            >
              {hideViewed ? "Unread only" : "Hide read"}
            </button>
          </div>
          {hits.length === 0 ? (
            <div style={{ padding: "10px", color: "#8b949e" }}>
              When a collaborator @-mentions you in a comment on this dataset, it
              shows up here.
            </div>
          ) : visibleHits.length === 0 ? (
            // Every mention is read and hidden: say why the list is empty.
            <div style={{ padding: "10px", color: "#8b949e" }}>
              No unread mentions. Toggle off “Hide read” to see read ones.
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: "4px 0" }}>
              {visibleHits.map((hit) => {
                const isViewed = viewedSet.has(hit.commentId);
                return (
                  <li key={hit.commentId}>
                    <button
                      type="button"
                      data-testid={`mention-of-me-item-${hit.commentId}`}
                      data-viewed={isViewed ? "true" : "false"}
                      onClick={() => {
                        onNavigate(hit.pinId);
                        onMarkViewed?.(hit.commentId);
                      }}
                      title={hit.text}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "7px 10px",
                        fontSize: 12,
                        lineHeight: 1.4,
                        background: "none",
                        border: "none",
                        borderBottom: "1px solid rgba(48,54,61,0.6)",
                        color: isViewed ? "#8b949e" : "#e6edf3",
                        fontWeight: isViewed ? 400 : 600,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {snippet(hit.text)}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
