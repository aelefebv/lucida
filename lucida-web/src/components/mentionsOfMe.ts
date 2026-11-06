/**
 * Which comments in the current dataset @-mention the current user.
 *
 * "Me" is the identity-derived handle plus, when the user's roster row has one,
 * their display-name handle, since nothing links an opaque comment author to a
 * roster email. A match is an exact, case-insensitive token, and the user's own
 * comments count too.
 */
import type { Annotation } from "./annotationDocument.ts";
import { splitMentionTokens } from "./annotationMentions.ts";
import { deriveHandle, handleFromName, type MemberSource } from "./annotationParticipants.ts";

/** One comment that mentions the current user, with the pin that owns it. */
export interface MentionHit {
  pinId: string;
  commentId: string;
  text: string;
}

export interface MentionsOfMeInput {
  /** The current dataset's pins with nested `comments`. */
  annotations: readonly Annotation[];
  /** The `author` that rides the current user's comments. Its
   * {@link deriveHandle} is always one of "my" handles. */
  currentUserId: string;
  /** Used only to find the user's roster row, so a mention by their
   * display-name handle also counts. Null when unauthenticated. */
  currentUserEmail?: string | null;
  /** The workspace roster, best-effort. */
  members?: readonly MemberSource[];
}

/** The lower-cased handle names, without `@`, that mean "me". */
function buildMyHandles(
  currentUserId: string,
  currentUserEmail: string | null | undefined,
  members: readonly MemberSource[],
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

/** Every comment that mentions the current user, in document order. */
export function findMentionsOfMe({
  annotations,
  currentUserId,
  currentUserEmail,
  members = [],
}: MentionsOfMeInput): MentionHit[] {
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
}

/** How many of `hits` this viewer hasn't opened. */
export function countUnread(hits: readonly MentionHit[], viewed: ReadonlySet<string>): number {
  return hits.reduce((n, h) => (viewed.has(h.commentId) ? n : n + 1), 0);
}
