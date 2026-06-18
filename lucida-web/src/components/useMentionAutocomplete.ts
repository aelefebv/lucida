/**
 * The shared @-mention autocomplete behavior for an annotation-comment composer
 * (issue #526) — the ONE place the picker logic lives so BOTH composers in
 * {@link ThreadPopover} (the add-a-comment box AND the inline edit-a-comment
 * field) get identical autocomplete from a single implementation.
 *
 * It owns no draft text of its own: each composer keeps its own draft `useState`
 * (the add draft and the edit draft are separate and must stay separate), and
 * passes that value + its setter in. The hook is a PURE function of that draft —
 * it derives the in-progress `@query` (via {@link activeMentionQuery}) and the
 * matching candidates (via {@link matchMentionCandidates}) from the current text,
 * with no separate open/closed flag: when no query is open or nothing matches,
 * `matches` is empty and `open` is false, so the picker can never drift out of
 * sync with what's typed. All the token grammar stays in annotationMentions.ts —
 * this hook only wires it to a draft + an input ref; it does NOT reimplement it.
 *
 * Because a mention is just inline text, picking one ONLY rewrites the draft (via
 * {@link applyMentionSelection}); nothing here emits a command. Sending stays the
 * caller's unchanged `add_comment` / `edit_comment`.
 */
import { useCallback, type RefObject } from "react";
import {
  activeMentionQuery,
  applyMentionSelection,
  matchMentionCandidates,
  type MentionCandidate,
} from "./annotationMentions.ts";

/** What a composer needs to render + drive its mention picker. */
export interface MentionAutocomplete {
  /** Candidates whose label matches the active `@query`, in candidate order. The
   * picker renders one option per entry (testid `mention-option-<id>`). Empty
   * whenever no mention is being typed or nothing matches. */
  matches: MentionCandidate[];
  /** Whether the picker should be shown — true iff `matches` is non-empty. A
   * convenience mirror of `matches.length > 0` so call sites read clearly. */
  open: boolean;
  /** Apply a candidate: replace the active `@query` in the draft with `@<label> `
   * (one trailing space) and return focus to the composer's input so typing
   * continues. The rewrite re-derives the query — now closed by the trailing
   * space — so the picker closes on its own with no extra flag. A no-op on the
   * draft if no mention is active (a stale call can never corrupt the text). */
  pick: (label: string) => void;
}

/**
 * Wire mention autocomplete to one composer.
 *
 * @param value the composer's current draft text.
 * @param setValue the draft's state setter (used to splice in a picked mention).
 * @param candidates the people who may be @-mentioned in this thread.
 * @param inputRef the composer's input element, refocused after a pick so the
 *   caret stays in the field and the picker can reopen for the next mention.
 */
export function useMentionAutocomplete(
  value: string,
  setValue: (updater: (cur: string) => string) => void,
  candidates: MentionCandidate[],
  inputRef: RefObject<HTMLInputElement | null>,
): MentionAutocomplete {
  const query = activeMentionQuery(value);
  const matches =
    query !== null ? matchMentionCandidates(candidates, query.query) : [];
  const open = matches.length > 0;

  const pick = useCallback(
    (label: string) => {
      setValue((cur) => applyMentionSelection(cur, label));
      // Restore focus after React applies the new value. The input never unmounts
      // on a pick, so this just re-focuses the live element.
      inputRef.current?.focus();
    },
    [setValue, inputRef],
  );

  return { matches, open, pick };
}
