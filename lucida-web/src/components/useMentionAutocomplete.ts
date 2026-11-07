/**
 * @-mention autocomplete for a comment composer, shared by the add and edit
 * composers in {@link ThreadPopover}.
 *
 * Each composer keeps its own draft and passes it in. The picker state is
 * derived from the draft with no separate open flag, so it can't drift from
 * what's typed. Picking only rewrites the draft; nothing here sends a command.
 */
import { useCallback, type RefObject } from "react";
import {
  activeMentionQuery,
  applyMentionSelection,
  matchMentionCandidates,
  type MentionCandidate,
} from "./annotationMentions.ts";

export interface MentionAutocomplete {
  /** Candidates matching the active `@query`, in candidate order. Empty when no
   * mention is being typed. */
  matches: MentionCandidate[];
  /** `matches.length > 0`. */
  open: boolean;
  /** Replace the active `@query` with `@<label> ` and refocus the input. The
   * trailing space closes the query, so the picker closes on its own. */
  pick: (label: string) => void;
}

/**
 * Wire mention autocomplete to one composer.
 *
 * @param inputRef refocused after a pick so the picker can reopen for the next
 *   mention.
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
      // The input never unmounts on a pick, so this refocuses the live element.
      inputRef.current?.focus();
    },
    [setValue, inputRef],
  );

  return { matches, open, pick };
}
