/**
 * @-mention token rules for annotation comments.
 *
 * A mention is plain comment text (`@name` in `Comment.text`), so it rides the
 * existing `add_comment` broadcast and persistence with no wire change. The
 * composer's picker and the rendered chips both read the rule from here, so what
 * the picker completes is exactly what later renders as a chip. The rule: `@`
 * plus word characters, opened at start-of-string or after whitespace.
 */

/** A candidate a comment may mention. `id` is the stable key (option testid and
 * React key); `label` is shown in the picker and inserted after `@`. */
export interface MentionCandidate {
  id: string;
  label: string;
}

/**
 * The in-progress mention query at the end of `text`, or null when none is open.
 *
 * The last `@` must open a token (index 0 or after whitespace, so `foo@bar`
 * never opens one) and the run after it must hold no whitespace. The query is
 * "" right after `@`, which matches every candidate. The `@` index comes back
 * too so the caller can splice the token in place.
 */
export function activeMentionQuery(
  text: string,
): { query: string; at: number } | null {
  const at = text.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(text[at - 1])) return null;
  const query = text.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { query, at };
}

/**
 * Replace the active `@query` at the end of `text` with `@<label> `. Returns the
 * text unchanged when no mention is active, so a stale pick can't corrupt the
 * draft. The trailing space closes the token so it renders as a chip.
 */
export function applyMentionSelection(text: string, label: string): string {
  const active = activeMentionQuery(text);
  if (!active) return text;
  return `${text.slice(0, active.at)}@${label} `;
}

/** Candidates whose label contains `query`, case-insensitive. An empty query
 * matches all. Input order is preserved. */
export function matchMentionCandidates(
  candidates: MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const needle = query.toLowerCase();
  if (needle.length === 0) return candidates;
  return candidates.filter((c) => c.label.toLowerCase().includes(needle));
}

/** A run of rendered comment text: plain, or an `@mention` chip. `text` is the
 * exact source substring, so joining every segment reproduces the comment. */
export interface MentionSegment {
  kind: "text" | "mention";
  text: string;
}

/** Same boundary rule as {@link activeMentionQuery}. Group 1 captures the
 * boundary instead of using a lookbehind, so the whitespace before a mention
 * stays plain text and only the `@name` token becomes a chip. */
const MENTION_TOKEN = /(^|\s)(@\w+)/g;

/**
 * Split `text` into ordered plain and `@mention` segments; joining their `text`
 * reproduces the input. Callers render every segment as text, never HTML, so
 * comment content can't inject markup.
 */
export function splitMentionTokens(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let lastIndex = 0;
  for (const m of text.matchAll(MENTION_TOKEN)) {
    const matchStart = m.index ?? 0;
    const boundary = m[1] ?? "";
    const token = m[2] ?? "";
    const tokenStart = matchStart + boundary.length;
    // The boundary stays in the plain run.
    if (tokenStart > lastIndex) {
      segments.push({ kind: "text", text: text.slice(lastIndex, tokenStart) });
    }
    segments.push({ kind: "mention", text: token });
    lastIndex = tokenStart + token.length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIndex) });
  }
  // Empty input still yields one text segment so callers can map uniformly.
  if (segments.length === 0) {
    segments.push({ kind: "text", text });
  }
  return segments;
}
