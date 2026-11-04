/**
 * The @-mention candidate list for annotation comments.
 *
 * Candidates are the union of workspace members (best-effort: the sharing roster
 * is owner-only, so pass `[]` when unavailable) and the authors already in the
 * document, which works offline. A mention is plain `@handle` text, so a handle
 * must be one word-character token and the same for every viewer. The current
 * user is handled by {@link deriveHandle}, never a viewer-relative "you", so
 * "mentions of me" can recompute their handle and match it in comment text.
 */
import type { MentionCandidate } from "./annotationMentions.ts";

/** The fields read off each annotation. Structural so this helper doesn't depend
 * on the full `Annotation` type. */
export interface ParticipantSource {
  author?: string | null;
  comments?: { author?: string | null }[] | null;
}

/** The fields read off a workspace member. `WorkspaceMember` is assignable to
 * it, so this module needn't depend on the workspace API. */
export interface MemberSource {
  email: string;
  display_name?: string | null;
}

/** Base-36 width of the hash suffix in a derived handle: about 41 bits, enough
 * to make collisions unlikely while staying short in the picker. */
const HANDLE_HASH_WIDTH = 8;

/**
 * A deterministic, token-safe @handle for an opaque author identity.
 *
 * Every mention match depends on this being pure and stable across sessions and
 * viewers, so all sites must route through it. It hashes the whole identity
 * rather than slicing it, so the handle neither collides like a short prefix nor
 * exposes the id. The `user` prefix guarantees a leading word character.
 */
export function deriveHandle(identity: string): string {
  // FNV-1a over UTF-16 code units. Only `Math.imul` and `>>>`, so it is
  // identical across runtimes.
  let hash = 0x811c9dc5;
  for (let i = 0; i < identity.length; i++) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const suffix = (hash >>> 0).toString(36).padStart(HANDLE_HASH_WIDTH, "0");
  return `user${suffix}`;
}

/**
 * Slugify a name into a one-token @handle by keeping only word characters
 * ("J. Doe" becomes "JDoe"). Returns null when nothing remains, so the caller
 * falls back to an identity-derived handle instead of an empty mention.
 */
export function handleFromName(name: string | null | undefined): string | null {
  if (name == null) return null;
  const slug = name.replace(/\W+/g, "");
  return slug.length > 0 ? slug : null;
}

/**
 * Build the deduped mention-candidate list for a document: the current user
 * first, then other document authors in first-seen order, then the remaining
 * workspace members in roster order. Never returns empty.
 *
 * `currentUserEmail` only drops the user's own roster row, so they appear once
 * under the handle peers can match. Ids are namespaced (`author:` vs `member:`).
 * A member who has also commented appears twice, because nothing links an
 * opaque comment author to a roster email.
 */
export function deriveMentionCandidates(options: {
  annotations: ParticipantSource[];
  currentUserId: string;
  members?: MemberSource[];
  currentUserEmail?: string | null;
}): MentionCandidate[] {
  const { annotations, currentUserId, members = [], currentUserEmail } = options;

  const candidates: MentionCandidate[] = [];

  // The current user seeds the set so they sort first, even in an empty document.
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

  // Skip the current user's roster row: a display_name handle is one no peer
  // could match them by.
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
