import { describe, it, expect } from "vitest";
import {
  activeMentionQuery,
  applyMentionSelection,
  matchMentionCandidates,
  splitMentionTokens,
  type MentionCandidate,
} from "./annotationMentions.ts";

/**
 * Pure-logic tests for the shared @-mention token rules (issue #526). These pin
 * the grammar the composer (live `@query`) and the rendered comment (chip
 * segmentation) BOTH ride — so the two can never drift — and the guarantees the
 * UI leans on: a mid-word `@` (an email) is not a mention, whitespace closes a
 * token, an empty query lists everyone, and splitting is lossless.
 */

describe("activeMentionQuery — the live @query token rule", () => {
  it("returns null when there is no @ at all", () => {
    expect(activeMentionQuery("just some text")).toBeNull();
    expect(activeMentionQuery("")).toBeNull();
  });

  it("opens a query when @ is at the start of the string", () => {
    expect(activeMentionQuery("@ali")).toEqual({ query: "ali", at: 0 });
  });

  it("opens a query when @ is immediately after whitespace", () => {
    // The `@` follows a space — a fresh token — so the run after it is the query.
    expect(activeMentionQuery("hey @bo")).toEqual({ query: "bo", at: 4 });
  });

  it("a bare @ (empty query) is valid and opens the picker", () => {
    // Right after typing `@` the query is "" — which the matcher treats as
    // "match everyone", so the picker lists all candidates.
    expect(activeMentionQuery("@")).toEqual({ query: "", at: 0 });
    expect(activeMentionQuery("hello @")).toEqual({ query: "", at: 6 });
  });

  it("a mid-word @ (email local part) does NOT open a query", () => {
    // `a@b.com` — the `@` has a word char immediately before it, so it is not a
    // mention. The whole address is plain text, picker stays closed.
    expect(activeMentionQuery("a@b.com")).toBeNull();
    expect(activeMentionQuery("mail me at alice@example.com")).toBeNull();
  });

  it("whitespace after the @ closes the token (no active query)", () => {
    // A space anywhere in the run ends the mention — you've moved past it.
    expect(activeMentionQuery("@alice ")).toBeNull();
    expect(activeMentionQuery("@alice and")).toBeNull();
    expect(activeMentionQuery("@alice \t")).toBeNull();
  });

  it("uses the LAST @ — a second fresh @ starts a new query", () => {
    // The earlier mention is already closed by its trailing space; the run from
    // the last (fresh) `@` is the active query.
    expect(activeMentionQuery("@alice hi @bo")).toEqual({ query: "bo", at: 10 });
  });
});

describe("applyMentionSelection — replacing the active @query", () => {
  it("replaces the open query with `@<label> ` (one trailing space)", () => {
    expect(applyMentionSelection("hey @al", "Alice")).toBe("hey @Alice ");
  });

  it("replaces a bare @ with the picked label", () => {
    expect(applyMentionSelection("@", "Bob")).toBe("@Bob ");
  });

  it("preserves text before the mention exactly", () => {
    expect(applyMentionSelection("ping @alice @bo", "Bob")).toBe(
      "ping @alice @Bob ",
    );
  });

  it("returns the text unchanged when no mention is active (stale pick)", () => {
    // No open token (trailing space closed it) → a pick must not corrupt the
    // draft.
    expect(applyMentionSelection("@alice ", "Bob")).toBe("@alice ");
    expect(applyMentionSelection("nothing here", "Bob")).toBe("nothing here");
  });
});

describe("matchMentionCandidates — filtering by query", () => {
  const candidates: MentionCandidate[] = [
    { id: "1", label: "Alice" },
    { id: "2", label: "Bob" },
    { id: "3", label: "alfred" },
  ];

  it("an empty query matches ALL candidates (typing a bare @)", () => {
    expect(matchMentionCandidates(candidates, "")).toEqual(candidates);
  });

  it("matches case-insensitively on a label substring", () => {
    expect(matchMentionCandidates(candidates, "al").map((c) => c.id)).toEqual([
      "1",
      "3",
    ]);
    expect(matchMentionCandidates(candidates, "BO").map((c) => c.id)).toEqual([
      "2",
    ]);
  });

  it("preserves input order in the result", () => {
    expect(matchMentionCandidates(candidates, "a").map((c) => c.id)).toEqual([
      "1",
      "3",
    ]);
  });

  it("returns [] when nothing matches", () => {
    expect(matchMentionCandidates(candidates, "zzz")).toEqual([]);
  });
});

describe("splitMentionTokens — chip segmentation is lossless", () => {
  /** The core round-trip invariant: concatenating every segment's `text`
   * reproduces the input verbatim — nothing dropped, reordered, or rewritten. */
  const rejoin = (text: string) =>
    splitMentionTokens(text)
      .map((s) => s.text)
      .join("");

  it("a comment with NO mention yields a single text segment (no chip)", () => {
    const segs = splitMentionTokens("just a plain comment");
    expect(segs).toEqual([{ kind: "text", text: "just a plain comment" }]);
    expect(segs.some((s) => s.kind === "mention")).toBe(false);
  });

  it("a leading mention chips only the @token, keeping the rest text", () => {
    expect(splitMentionTokens("@alice hi")).toEqual([
      { kind: "mention", text: "@alice" },
      { kind: "text", text: " hi" },
    ]);
  });

  it("a mid-sentence mention keeps the leading space as text, not in the chip", () => {
    expect(splitMentionTokens("hey @bob there")).toEqual([
      { kind: "text", text: "hey " },
      { kind: "mention", text: "@bob" },
      { kind: "text", text: " there" },
    ]);
  });

  it("an email is NOT chipped (no boundary before the @)", () => {
    const segs = splitMentionTokens("write a@b.com now");
    expect(segs.some((s) => s.kind === "mention")).toBe(false);
    expect(rejoin("write a@b.com now")).toBe("write a@b.com now");
  });

  it("a lone @ with no word chars stays plain text", () => {
    expect(splitMentionTokens("price @ 5").some((s) => s.kind === "mention")).toBe(
      false,
    );
  });

  it("multiple mentions all chip, and the join round-trips", () => {
    const text = "cc @alice and @bob_jr please";
    const segs = splitMentionTokens(text);
    expect(segs.filter((s) => s.kind === "mention").map((s) => s.text)).toEqual([
      "@alice",
      "@bob_jr",
    ]);
    expect(segs.map((s) => s.text).join("")).toBe(text);
  });

  it("round-trips a variety of inputs exactly", () => {
    for (const text of [
      "",
      "plain",
      "@only",
      "@a @b @c",
      "leading @x trailing",
      "punct, @y! and email z@w.com",
      "  spaced  @z  ",
    ]) {
      expect(rejoin(text)).toBe(text);
    }
  });
});
