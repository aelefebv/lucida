/**
 * "Mentions of me" inbox for annotation comments (issue #526, slice 2).
 *
 * A user can SEE every comment in the CURRENT dataset that @-mentions them and
 * JUMP to each. In-app only — a mention is just inline `@handle` text riding
 * `Comment.text` (the slice-1 grammar), so this reads the plain annotation data
 * already in hand and needs NO wire/command/Rust change.
 *
 * PURE with respect to product state: this component does not touch the scene or
 * network. It works off the `annotations` array (and identity props), with one
 * DOM anchor ref used only by the shared floating-surface placement contract.
 * Navigation reports through `onNavigate(pinId)`, so the host still owns the
 * actual "open the thread + recenter" effect.
 *
 * WHO IS "ME" — the handle set, computed exactly like the slice-1 candidate
 * builder so a mention is matchable to the same person everywhere:
 *  - ALWAYS {@link deriveHandle}`(currentUserId)` — the deterministic handle every
 *    viewer derives from the opaque author id that rides this user's comments, so
 *    it is the same string for everyone (never the viewer-relative "you");
 *  - PLUS, when `currentUserEmail` matches a roster row, that row's
 *    {@link handleFromName}`(display_name)` when non-null — so a collaborator who
 *    @-mentioned this user by their REAL name (before any id linkage exists) still
 *    counts. (No structured id ties an opaque comment author to a roster email —
 *    resolving that is the deferred structured-mention slice — so matching BOTH
 *    handles is the honest, non-lossy choice.)
 *
 * A comment mentions me iff its text contains a mention TOKEN (the SAME grammar
 * via {@link splitMentionTokens}) whose name equals one of my handles,
 * case-insensitive, as an EXACT token: `@user5xy9` matches `@user5xy9` but NOT
 * `@user5xy9more` (the tokenizer already bounds the token at word characters, so
 * the trailing run is a different token). My own comments that mention me DO
 * count — this is "who pointed at me", regardless of who typed it.
 */
import { useMemo, useState } from "react";
import type { Annotation } from "./annotationDocument.ts";
import { splitMentionTokens } from "./annotationMentions.ts";
import { deriveHandle, handleFromName } from "./annotationParticipants.ts";
import { FloatingPortalSurface } from "./FloatingSurface.tsx";

interface Props {
  /** The CURRENT dataset's pins (each with its nested `comments`), as plain data
   * read from the scene by the host — this component never reads the scene
   * itself. Scoping to one dataset is the host's job (it passes that dataset's
   * annotations); cross-dataset aggregation is deliberately out of scope. */
  annotations: Annotation[];
  /** The current user's stable annotation identity (the `author` that rides their
   * comments). Its {@link deriveHandle} is ALWAYS one of "my" handles. */
  currentUserId: string;
  /** The current user's email, used ONLY to find their roster row so a mention by
   * their display-name handle also counts. Optional/null when unauthenticated or
   * unknown — then only the identity-derived handle is "me". */
  currentUserEmail?: string | null;
  /** The workspace roster (best-effort; omitted/`[]` when unavailable). Used only
   * to resolve the current user's own display-name handle via `currentUserEmail`.
   * Structural shape so `WorkspaceMember` is assignable without a hard dep. */
  members?: { email: string; display_name?: string | null }[];
  /** Jump to a mentioning comment: the host opens that comment's pin thread AND
   * recenters on it. `pinId` is the id of the annotation OWNING the comment. */
  onNavigate: (pinId: string) => void;
  /** The comment ids the current viewer has already VIEWED (issue #803), owned +
   * persisted by the host (per-browser, per-dataset). The badge counts only ids
   * NOT in this list, and each item is marked `data-viewed` by its membership.
   * Defaults to `[]` (nothing viewed) so a host that hasn't adopted read-state —
   * and the slice-2 contract — behaves exactly as before. */
  viewedCommentIds?: string[];
  /** Mark a mention VIEWED. Called (alongside {@link onNavigate}) when its panel
   * item is clicked; the host persists it so it stays read across reloads. No-op
   * default keeps this optional and the component drop-in for hosts that don't
   * track read-state. */
  onMarkViewed?: (commentId: string) => void;
}

/** A flattened reference to one comment that mentions the current user, paired
 * with the id of the pin (annotation) that owns it — everything the list item
 * and its navigation need, with no re-derivation. */
interface MentionHit {
  /** The owning annotation's id — what {@link Props.onNavigate} receives. */
  pinId: string;
  /** The mentioning comment's id — the list item's stable key + testid suffix. */
  commentId: string;
  /** The comment's raw text, shown as the item's snippet. */
  text: string;
}

/** Max characters of comment text shown in a list item before eliding, so a long
 * comment stays a one-line snippet in the narrow panel. The FULL text is still
 * the item's title (hover) so nothing is lost. */
const SNIPPET_MAX = 80;

/** A one-line snippet of comment text: whitespace collapsed and elided past
 * {@link SNIPPET_MAX}. Pure presentation — the match decision uses the full,
 * untrimmed text (the tokenizer), never this. */
function snippet(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > SNIPPET_MAX ? `${oneLine.slice(0, SNIPPET_MAX - 1)}…` : oneLine;
}

/**
 * Build the set of lower-cased handle names (the `@` stripped) that mean "me".
 *
 * ALWAYS includes the identity-derived handle; ADDS the current user's roster
 * display-name handle when their email matches a member row (and that row yields
 * a non-null handle). Lower-cased so the later comparison is case-insensitive;
 * a Set so membership is O(1) per token regardless of roster size.
 */
function buildMyHandles(
  currentUserId: string,
  currentUserEmail: string | null | undefined,
  members: { email: string; display_name?: string | null }[],
): Set<string> {
  const handles = new Set<string>();
  // The deterministic, viewer-independent handle is always "me" — even with no
  // email, no roster, and no annotations.
  const own = deriveHandle(currentUserId);
  if (own) handles.add(own.toLowerCase());

  // If we know the current user's email, their own roster row (matched
  // case-insensitively) may contribute a display-name handle — so a mention
  // typed by their real name also counts as "me".
  const email = currentUserEmail?.trim().toLowerCase();
  if (email) {
    for (const m of members) {
      if (m.email?.trim().toLowerCase() !== email) continue;
      const named = handleFromName(m.display_name);
      if (named) handles.add(named.toLowerCase());
      // Don't break: tolerate a roster with duplicate rows for the same email by
      // collecting every usable display-name handle they expose.
    }
  }
  return handles;
}

/**
 * Whether `text` contains a mention TOKEN naming one of `myHandles`.
 *
 * Routes through {@link splitMentionTokens} — the SAME grammar the composer and
 * chip renderer use — so what counts as "a mention of me" is exactly what the
 * rest of the feature treats as a mention: an `@` opened on a word boundary, then
 * word characters. The token's `@` is stripped and the remainder compared
 * case-insensitively for an EXACT match, so `@user5xy9more` (a different,
 * longer token) never matches `@user5xy9`, and an email's `@` (no boundary) is
 * never even a token.
 */
function mentionsMe(text: string, myHandles: Set<string>): boolean {
  if (myHandles.size === 0) return false;
  for (const seg of splitMentionTokens(text)) {
    if (seg.kind !== "mention") continue;
    // seg.text is "@name"; drop the leading "@" and compare case-insensitively.
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
  const [anchorElement, setAnchorElement] = useState<HTMLButtonElement | null>(null);
  // Whether the panel is shown. The badge is ALWAYS rendered (it shows the count
  // even at zero); the panel only appears after a click on the badge, and a
  // second click hides it again — the contract's toggle.
  const [open, setOpen] = useState(false);

  // Whether the panel hides already-viewed mentions (issue #803). Off by
  // default, so the panel lists EVERY mentioning comment (viewed ones simply
  // marked); when engaged it drops viewed items, leaving an unread-only inbox.
  const [hideViewed, setHideViewed] = useState(false);

  // O(1) membership for "is this comment id viewed?" — built from the prop so
  // the host stays the single owner of read-state. Recomputed only when the id
  // list identity changes.
  const viewedSet = useMemo(() => new Set(viewedCommentIds), [viewedCommentIds]);

  // The mentioning comments, in document order (pins in order, comments within a
  // pin in order). Recomputed only when the data or identity changes — pure, so
  // it never reads the scene/network. A comment is scanned ONCE; the first token
  // that names me makes it a hit (mentionsMe short-circuits).
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

  // The badge counts only UNVIEWED mentions (issue #803): comments that mention
  // me whose id is NOT in the viewed set. 0 when every mention is viewed (or
  // there are none) — so the pill clears once the inbox is read.
  const unviewedCount = useMemo(
    () => hits.reduce((n, h) => (viewedSet.has(h.commentId) ? n : n + 1), 0),
    [hits, viewedSet],
  );
  const count = unviewedCount;

  // The mentions actually rendered as items: all of them, or only the unviewed
  // ones when the hide-viewed toggle is engaged. Viewed items that survive are
  // still marked via `data-viewed` so "read" stays visible.
  const visibleHits = useMemo(
    () => (hideViewed ? hits.filter((h) => !viewedSet.has(h.commentId)) : hits),
    [hits, hideViewed, viewedSet],
  );

  return (
    <div style={{ position: "relative", display: "inline-flex" }}>
      {/* The always-present badge. Its textContent includes the integer count of
          UNREAD comments that mention me (0 when all read / none), so a glance
          tells the user whether anyone is waiting on them. Clicking toggles the
          panel. */}
      <button
        type="button"
        data-testid="mentions-of-me-badge"
        onClick={(event) => {
          if (open) {
            setOpen(false);
            setAnchorElement(null);
          } else {
            setAnchorElement(event.currentTarget);
            setOpen(true);
          }
        }}
        aria-expanded={open}
        aria-controls="mentions-of-me-panel"
        aria-haspopup="dialog"
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
          // Tint when there ARE mentions (and again when the panel is open) so
          // "someone mentioned you" reads at a glance, matching the accent the
          // sibling toolbar toggles use.
          background: open ? "var(--accent)" : count > 0 ? "var(--accent-strong)" : undefined,
          color: open || count > 0 ? "var(--accent-contrast)" : undefined,
        }}
      >
        <span aria-hidden="true">@</span>
        <span>Mentions</span>
        {/* A small count pill, like a notification badge. Always shows the
            integer (including 0) so the testid's textContent carries the count
            in every state. */}
        <span
          style={{
            minWidth: 16,
            height: 16,
            padding: "0 4px",
            borderRadius: 8,
            background: count > 0 ? "var(--badge-danger)" : "var(--surface-3)",
            color: "var(--text-primary)",
            fontSize: 11,
            lineHeight: "16px",
            textAlign: "center",
            fontWeight: 700,
          }}
        >
          {count}
        </span>
      </button>
      {/* The panel — only after a click (toggled by the badge). One item per
          mentioning comment, in document order; an item shows the comment's
          snippet and, on click, navigates to its pin thread. Zero mentions → the
          empty-state line (and NO mention-of-me-item-* nodes). */}
      {open && (
        <FloatingPortalSurface
          anchorElement={anchorElement}
          fallbackSize={{ width: 320, height: 360 }}
          id="mentions-of-me-panel"
          data-testid="mentions-of-me-panel"
          role="dialog"
          aria-label="Comments that mention you"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              setAnchorElement(null);
              anchorElement?.focus();
            }
          }}
          style={{
            width: "min(320px, calc(100vw - 1rem))",
            maxHeight: 360,
            overflowY: "auto",
            background: "var(--overlay-panel-strong)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 8,
            boxShadow: "var(--shadow-raised)",
            fontSize: 12,
          }}
        >
          {/* Header: the headline tracks UNVIEWED ("4 unread"), the slice-803
              read/unread framing, while the row beneath carries the hide-viewed
              toggle. Empty-state copy keys off whether ANY mention exists at all
              (not the unviewed count), so a fully-read inbox still explains
              itself rather than claiming no one ever mentioned you. */}
          <div
            style={{
              padding: "8px 10px",
              borderBottom: "1px solid var(--border-subtle)",
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
            {/* Hide-viewed toggle (issue #803). Always present while the panel is
                open so it's testable in every state; when engaged the list below
                renders only UNVIEWED items. aria-pressed + label reflect current
                state for a screen reader. */}
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
                border: "1px solid var(--border-subtle)",
                cursor: "pointer",
                background: hideViewed ? "var(--accent)" : "transparent",
                color: hideViewed ? "var(--accent-contrast)" : "var(--text-muted)",
              }}
            >
              {hideViewed ? "Unread only" : "Hide read"}
            </button>
          </div>
          {hits.length === 0 ? (
            <div style={{ padding: "10px", color: "var(--text-muted)" }}>
              When a collaborator @-mentions you in a comment on this dataset, it
              shows up here.
            </div>
          ) : visibleHits.length === 0 ? (
            // There ARE mentions, but hide-viewed is engaged and every one is
            // read: list NO items (contract #5) and say why.
            <div style={{ padding: "10px", color: "var(--text-muted)" }}>
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
                      // Each item declares its read-state so "read" is visible +
                      // testable (contract #3).
                      data-viewed={isViewed ? "true" : "false"}
                      // Click does BOTH (contract #2): jump to the comment's pin
                      // thread (host recenters) AND mark this mention viewed so
                      // it drops out of the unread count (and, with hide-viewed
                      // engaged, out of the list).
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
                        borderBottom: "1px solid var(--border-subtle)",
                        // Read items recede (dimmed, normal weight); unread stay
                        // bright + bold so the unread ones pop in a mixed list.
                        color: isViewed ? "var(--text-muted)" : "var(--text-primary)",
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
        </FloatingPortalSurface>
      )}
    </div>
  );
}
