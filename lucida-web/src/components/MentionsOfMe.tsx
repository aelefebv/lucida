/**
 * "Mentions of me" inbox for annotation comments (issue #526, slice 2).
 *
 * A user can SEE every comment in the CURRENT dataset that @-mentions them and
 * JUMP to each. In-app only — a mention is just inline `@handle` text riding
 * `Comment.text` (the slice-1 grammar), so this reads the plain annotation data
 * already in hand and needs NO wire/command/Rust change.
 *
 * PURE by construction: this component does not touch the scene, the network, or
 * any ref. It works entirely off the `annotations` array (and the identity props)
 * passed in, and reports navigation back through `onNavigate(pinId)` — so the
 * host owns the actual "open the thread + recenter" effect (the seam), and this
 * stays trivially testable and re-renderable.
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
import type { Annotation } from "./AnnotationOverlay.tsx";
import { splitMentionTokens } from "./annotationMentions.ts";
import { deriveHandle, handleFromName } from "./annotationParticipants.ts";

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
}: Props) {
  // Whether the panel is shown. The badge is ALWAYS rendered (it shows the count
  // even at zero); the panel only appears after a click on the badge, and a
  // second click hides it again — the contract's toggle.
  const [open, setOpen] = useState(false);

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

  const count = hits.length;

  return (
    <div style={{ position: "relative", display: "inline-flex" }}>
      {/* The always-present badge. Its textContent includes the integer count of
          comments that mention me (0 when none), so a glance tells the user
          whether anyone has pointed at them. Clicking toggles the panel. */}
      <button
        type="button"
        data-testid="mentions-of-me-badge"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={
          count === 0
            ? "Mentions of me: none"
            : `Mentions of me: ${count} comment${count === 1 ? "" : "s"}`
        }
        title={
          count === 0
            ? "No comments mention you in this dataset"
            : `${count} comment${count === 1 ? "" : "s"} mention you — click to view`
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
          background: open ? "#646cff" : count > 0 ? "#1f6feb" : undefined,
          color: open || count > 0 ? "#fff" : undefined,
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
      {/* The panel — only after a click (toggled by the badge). One item per
          mentioning comment, in document order; an item shows the comment's
          snippet and, on click, navigates to its pin thread. Zero mentions → the
          empty-state line (and NO mention-of-me-item-* nodes). */}
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
          <div
            style={{
              padding: "8px 10px",
              borderBottom: "1px solid #30363d",
              fontWeight: 600,
            }}
          >
            {count === 0
              ? "No one has mentioned you here"
              : `${count} comment${count === 1 ? "" : "s"} mention you`}
          </div>
          {count === 0 ? (
            <div style={{ padding: "10px", color: "#8b949e" }}>
              When a collaborator @-mentions you in a comment on this dataset, it
              shows up here.
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: "4px 0" }}>
              {hits.map((hit) => (
                <li key={hit.commentId}>
                  <button
                    type="button"
                    data-testid={`mention-of-me-item-${hit.commentId}`}
                    // Jump: the host opens this comment's pin thread and recenters
                    // on it. A mention is identified by the pin that owns the
                    // comment, so navigation targets the pin.
                    onClick={() => onNavigate(hit.pinId)}
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
                      color: "#e6edf3",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {snippet(hit.text)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
