/**
 * Shared @-mention text logic for annotation comments (issue #526).
 *
 * A mention is JUST inline comment text — an `@name` token living in
 * `Comment.text` — so it rides the existing `add_comment` broadcast +
 * persistence for free: NO new wire command, no new field, no Rust change. This
 * module is the ONE place the two token rules live, so the composer (which
 * detects the in-progress `@query` to drive the picker and rewrites it on pick)
 * and the rendered comment (which highlights each posted `@mention` as a chip)
 * agree on exactly what an `@mention` is — used by {@link ThreadPopover}, which
 * both the 2D ({@link AnnotationOverlay}) and 3D ({@link AnnotationOverlay3D})
 * overlays render, so the behavior holds in both views at once.
 *
 * The two operations, kept in lockstep here on purpose:
 *  - {@link activeMentionQuery}: the live query the user is typing. It is the run
 *    from the LAST `@` to the end of the draft, but ONLY when that `@` opens a
 *    fresh token — it sits at start-of-string or immediately after whitespace —
 *    and the run after it contains no whitespace. The query is the text after the
 *    `@` (empty right after typing `@`). Returns null when no such token is open,
 *    so the picker shows only while a mention is genuinely in progress.
 *  - {@link splitMentionTokens}: tokenize posted text into plain segments and
 *    `@mention` tokens (`@` + following word characters) for rendering each
 *    mention as a distinct, highlighted chip while every other character stays
 *    plain TEXT — never HTML — so comment content can't inject markup.
 *
 * Both share one definition of "a mention is `@` + word characters, opened at
 * start-of-string or after whitespace" (the `\w` class: letters, digits, `_`),
 * so what the picker completes is exactly what later renders as a chip: pick
 * Alice → the draft gains `@Alice ` → the posted comment shows an `@Alice` chip.
 */

/** A single candidate a comment may mention, as supplied to the overlays (and
 * threaded to {@link ThreadPopover}). `id` is the stable key (the option testid +
 * React key); `label` is the human-readable name shown in the picker and inserted
 * — preceded by `@` — into the draft. */
export interface MentionCandidate {
  id: string;
  label: string;
}

/**
 * The in-progress mention query at the END of `text`, or null when none is open.
 *
 * Contract (the picker shows iff this is non-null AND something matches):
 *  - look at the LAST `@` in the text;
 *  - it must open a token: be at index 0 OR have whitespace immediately before it
 *    (so an email's `@`, or a `foo@bar`, never opens a mention);
 *  - the run from just after that `@` to the end must contain NO whitespace
 *    (typing a space ends the token);
 *  - the query is that run (the text after `@`), which is "" right after `@` —
 *    an empty query is valid and matches every candidate.
 *
 * Returned together with the `@`'s index so a caller can splice the token in
 * place (replace `@`+query) without re-deriving the bounds.
 */
export function activeMentionQuery(
  text: string,
): { query: string; at: number } | null {
  const at = text.lastIndexOf("@");
  if (at < 0) return null;
  // The `@` must start a token: at the very start, or right after whitespace.
  // Anything else (a letter/digit/punctuation directly before it, e.g. an email
  // local part) means this `@` is not opening a mention.
  if (at > 0 && !/\s/.test(text[at - 1])) return null;
  const query = text.slice(at + 1);
  // A whitespace anywhere in the run closes the token — the mention is no longer
  // being typed, so there's no active query.
  if (/\s/.test(query)) return null;
  return { query, at };
}

/**
 * Replace the active `@query` at the end of `text` with `@<label> ` (one trailing
 * space), returning the new draft. If no mention is active (e.g. a stale call),
 * the text is returned unchanged so a pick can never corrupt the draft. The
 * single trailing space both closes the just-completed token (so it renders as a
 * chip) and leaves the caret ready to keep typing after the mention.
 */
export function applyMentionSelection(text: string, label: string): string {
  const active = activeMentionQuery(text);
  if (!active) return text;
  return `${text.slice(0, active.at)}@${label} `;
}

/** The candidates whose label CONTAINS `query` (case-insensitive). An empty query
 * matches all — typing a bare `@` lists everyone. Order is preserved from the
 * input so the caller controls candidate ordering. */
export function matchMentionCandidates(
  candidates: MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const needle = query.toLowerCase();
  if (needle.length === 0) return candidates;
  return candidates.filter((c) => c.label.toLowerCase().includes(needle));
}

/** A run of rendered comment text: either a plain stretch (rendered verbatim as
 * text) or a `@mention` token (rendered as a highlighted chip). `text` is the
 * exact source substring for both, so concatenating every segment's `text`
 * reproduces the original comment — nothing is dropped or rewritten. */
export interface MentionSegment {
  kind: "text" | "mention";
  text: string;
}

/** Matches a mention token: `@` opened at start-of-string or after whitespace,
 * followed by one or more WORD characters (letters, digits, `_`) — the same
 * "`@` + word chars, opened on a boundary" rule {@link activeMentionQuery} uses.
 * The leading boundary is a lookbehind-free capture (group 1) so we can keep the
 * preceding whitespace as plain text and only chip the `@…` itself. Global +
 * sticky-free so we can walk every match. */
const MENTION_TOKEN = /(^|\s)(@\w+)/g;

/**
 * Split `text` into ordered {@link MentionSegment}s: plain stretches and
 * `@mention` tokens. A comment with no mention yields a single text segment (so
 * the caller renders NO chip); a comment with mentions interleaves text and
 * mention segments such that joining their `text` reproduces the input exactly.
 *
 * The token rule matches {@link activeMentionQuery}: an `@` only starts a mention
 * at start-of-string or right after whitespace, and the token is `@` + word
 * characters — so `foo@bar` (no boundary) and a lone `@` (no word chars) stay
 * plain text and never become a chip. Every segment carries the raw source text;
 * the caller renders it as TEXT (a chip is styling, never HTML), so comment
 * content can never inject markup.
 */
export function splitMentionTokens(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let lastIndex = 0;
  // `matchAll` with the boundary-capturing regex: group 1 is the leading
  // boundary (start-of-string → "" or the whitespace char), group 2 the `@…`
  // token. We keep the boundary as plain text and chip only the token, so the
  // whitespace before a mention isn't swallowed into the chip.
  for (const m of text.matchAll(MENTION_TOKEN)) {
    const matchStart = m.index ?? 0;
    const boundary = m[1] ?? "";
    const token = m[2] ?? "";
    const tokenStart = matchStart + boundary.length;
    // Everything from the previous match up to (and including) the boundary is
    // plain text.
    if (tokenStart > lastIndex) {
      segments.push({ kind: "text", text: text.slice(lastIndex, tokenStart) });
    }
    segments.push({ kind: "mention", text: token });
    lastIndex = tokenStart + token.length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIndex) });
  }
  // An all-empty input still returns a single (empty) text segment so callers can
  // map uniformly; in practice comment text is non-empty (trimmed before send).
  if (segments.length === 0) {
    segments.push({ kind: "text", text });
  }
  return segments;
}
