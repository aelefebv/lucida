/**
 * Derive the @-mention candidate list for annotation comments (issue #526).
 *
 * WHO can be mentioned is a graceful UNION of two sources, so the picker offers
 * real, stable names whenever we have them and never ends up empty:
 *  - WORKSPACE MEMBERS — the roster from `getWorkspaceSharing` (email +
 *    `display_name`). Available only when authed AND the caller may read sharing
 *    (it is owner-only server-side) — so this is best-effort: pass `[]` when the
 *    fetch is unavailable or fails. Members let you mention a collaborator by
 *    their REAL name even before they've touched this document.
 *  - DOCUMENT PARTICIPANTS — the distinct authors already in
 *    `scene.annotations(datasetId)`: every pin author AND every nested comment
 *    author. This is the offline floor: it works with no server, no roster, no
 *    network, and grows as people add pins/comments.
 *
 * LABELS / HANDLES — the heart of the fix. A mention rides `Comment.text` as
 * inline `@handle` (no structured storage — that is a deliberately deferred
 * slice), so a label must be (a) a valid mention TOKEN under the frozen grammar
 * (`@` + word chars — letters/digits/`_`, no spaces/punctuation), and (b) REAL,
 * STABLE, and identical for every viewer so a mention is matchable to a person:
 *  - a workspace member is handled by their `display_name`, slugified to a token
 *    (so "Ada Lovelace" → `@AdaLovelace`, the same for everyone who sees Ada);
 *  - everyone else — including the CURRENT USER — is handled by a deterministic
 *    handle derived from their opaque author identity ({@link deriveHandle}). The
 *    current user gets the SAME handle every other viewer derives for them from
 *    the author id that rides their comments — NEVER the viewer-relative "you" —
 *    so "@<handle>" means the same person to everybody, and a later
 *    "mentions of me" slice can recompute the current user's own handle the same
 *    way and string-match it in comment text.
 *
 * {@link deriveHandle} is therefore the single, reusable, deterministic source of
 * truth for "the @handle of an opaque identity"; the matchability of mentions
 * depends on every site (this builder today, "mentions of me" tomorrow) routing
 * through it.
 */
import type { MentionCandidate } from "./annotationMentions.ts";

/** The minimal shape we read off each annotation: its `author` and the authors
 * of its nested comments. Kept structural (not importing the full `Annotation`)
 * so this stays a tiny, dependency-light helper and is trivial to unit-check. */
export interface ParticipantSource {
  author?: string | null;
  comments?: { author?: string | null }[] | null;
}

/** The minimal shape we read off a workspace member: a stable `email` (identity)
 * and a human `display_name` (the source of the handle). Structural on purpose —
 * `WorkspaceMember` from `workspaceApi.ts` is assignable to it — so this module
 * needn't depend on the workspace API surface. */
export interface MemberSource {
  email: string;
  display_name?: string | null;
}

/** Width (in base-36 chars) of the deterministic hash suffix in a derived
 * handle. Eight base-36 chars ≈ 41 bits of the hash — wide enough that two
 * distinct identities are very unlikely to collide on a handle, yet compact in
 * the narrow picker. This is NOT a raw slice of the id (which would be both
 * collision-prone and leak the opaque id): it's a hash, so the handle is stable
 * but reveals nothing structural about the identity. */
const HANDLE_HASH_WIDTH = 8;

/**
 * A deterministic, token-safe @handle for an opaque author identity.
 *
 * THE contract (other slices depend on it):
 *  - PURE + STABLE: the same `identity` always yields the same handle, in any
 *    session, for any viewer — so the current user's handle is identical to the
 *    one every peer derives for them, and a future "mentions of me" can recompute
 *    it and match `@<handle>` in comment text;
 *  - TOKEN-SAFE: the result is `@`-mentionable under the frozen grammar — it is
 *    `user` + hash digits, all word characters (no spaces/punctuation), so the
 *    composer inserts it and the renderer chips it as one unit;
 *  - NOT a raw id slice: it hashes the whole identity (FNV-1a, folded to an
 *    unsigned 32-bit int, base-36), so it neither collides as readily as a short
 *    prefix nor exposes the opaque id.
 *
 * The `user` prefix keeps the handle readable and ensures a leading word char
 * even if the hash renders short.
 */
export function deriveHandle(identity: string): string {
  // FNV-1a over the UTF-16 code units: tiny, dependency-free, well-distributed
  // for short strings, and identical across runtimes (only `*` and `>>>`), so the
  // handle is the same everywhere. `>>> 0` keeps it an unsigned 32-bit int.
  let hash = 0x811c9dc5;
  for (let i = 0; i < identity.length; i++) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const suffix = (hash >>> 0).toString(36).padStart(HANDLE_HASH_WIDTH, "0");
  return `user${suffix}`;
}

/**
 * Slugify a human name into a token-safe @handle: keep only word characters
 * (letters, digits, `_`) so the result is `@`-mentionable as ONE token under the
 * frozen grammar — "Ada Lovelace" → "AdaLovelace", "J. Doe" → "JDoe". Stable and
 * pure: the same name always yields the same handle, so every viewer who sees
 * this member mentions them with the same `@handle`.
 *
 * Returns null when nothing usable remains (an all-punctuation/empty name), so
 * the caller can fall back to an identity-derived handle rather than emit an
 * empty mention.
 */
export function handleFromName(name: string | null | undefined): string | null {
  if (name == null) return null;
  const slug = name.replace(/\W+/g, "");
  return slug.length > 0 ? slug : null;
}

/**
 * Build the deduped, ordered mention-candidate list for a document.
 *
 * Inputs (all but `currentUserId` optional so the offline floor is one call):
 *  - `annotations`: the pins (each with nested `comments`) as read from the
 *    scene — every pin/comment author becomes a participant candidate;
 *  - `currentUserId`: the current user's stable annotation identity — ALWAYS
 *    included (even with zero annotations and no roster) so you can mention
 *    yourself and the list is never empty-by-construction;
 *  - `members`: the workspace roster (best-effort; `[]` when unavailable) — each
 *    becomes a candidate handled by their `display_name`;
 *  - `currentUserEmail`: the current user's email, used ONLY to drop their own
 *    roster entry (the sharing roster includes the caller) so they appear once,
 *    as their identity-derived handle — not also as a `display_name` the rest of
 *    the world can't match them by.
 *
 * Output — one {@link MentionCandidate} per distinct candidate, ordered:
 *   1. the current user (top option), handled by {@link deriveHandle};
 *   2. the other DOCUMENT PARTICIPANTS, first-seen order, identity-handled;
 *   3. the remaining WORKSPACE MEMBERS, roster order, name-handled.
 * Candidate `id`s are namespaced by source (`author:<id>` vs `member:<email>`)
 * so the two keyspaces never false-merge; within each, an author/member that
 * recurs is de-duped. (A member who has ALSO commented appears in both lists —
 * there is no id linking an opaque comment author to a roster email, so we
 * cannot know they are the same person; resolving that is the deferred
 * structured-mention slice. Listing both is the honest, non-lossy choice.)
 *
 * Never throws and never returns empty: the worst case is `[currentUser]`.
 */
export function deriveMentionCandidates(options: {
  annotations: ParticipantSource[];
  currentUserId: string;
  members?: MemberSource[];
  currentUserEmail?: string | null;
}): MentionCandidate[] {
  const { annotations, currentUserId, members = [], currentUserEmail } = options;

  const candidates: MentionCandidate[] = [];

  // --- Participants (by opaque author id) -----------------------------------
  // Insertion-ordered de-dupe; the current user seeds the set so they sort first
  // and are always mentionable, even in an empty document.
  const seenAuthors = new Set<string>();
  const addAuthor = (raw: string | null | undefined) => {
    if (raw == null) return;
    const id = raw.trim();
    if (id.length === 0 || seenAuthors.has(id)) return;
    seenAuthors.add(id);
    candidates.push({ id: `author:${id}`, label: deriveHandle(id) });
  };

  addAuthor(currentUserId);
  for (const a of annotations) {
    addAuthor(a.author);
    for (const c of a.comments ?? []) addAuthor(c.author);
  }

  // --- Workspace members (by email) -----------------------------------------
  // Each member is handled by their display_name (slugified to a token), falling
  // back to a deterministic handle from their email when the name has no usable
  // characters. The current user's own roster row is skipped — they are already
  // listed above by the identity that rides their comments, and labelling them by
  // a display_name no peer can match them by would split their identity.
  const selfEmail = currentUserEmail?.trim().toLowerCase();
  const seenMembers = new Set<string>();
  for (const m of members) {
    const email = m.email?.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (key === selfEmail || seenMembers.has(key)) continue;
    seenMembers.add(key);
    const label = handleFromName(m.display_name) ?? deriveHandle(email);
    candidates.push({ id: `member:${key}`, label });
  }

  return candidates;
}
