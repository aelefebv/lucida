import { describe, it, expect } from "vitest";
import {
  deriveHandle,
  handleFromName,
  deriveMentionCandidates,
  type ParticipantSource,
} from "./annotationParticipants.ts";
import { splitMentionTokens, activeMentionQuery } from "./annotationMentions.ts";

/**
 * Pure-logic tests for the mention candidate SOURCE + handle derivation
 * (issue #526): the union of workspace members and document participants, deduped
 * by a stable identity, each labelled by a stable, viewer-independent, TOKEN-SAFE
 * @handle, with a never-empty fallback. These guard the properties the rest of
 * the feature depends on — especially that a handle is matchable (a future
 * "mentions of me" can recompute it) and is a valid `@`-mention token.
 */

/** `@<handle>` must parse back as a SINGLE mention token under the frozen grammar
 * — otherwise the composer would insert text the renderer can't chip and a
 * "mentions of me" couldn't string-match. */
function isTokenSafe(handle: string): boolean {
  const segs = splitMentionTokens(`@${handle}`);
  return (
    segs.length === 1 && segs[0].kind === "mention" && segs[0].text === `@${handle}`
  );
}

describe("deriveHandle — deterministic, token-safe id handle", () => {
  it("is pure: the same identity always yields the same handle", () => {
    const id = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    expect(deriveHandle(id)).toBe(deriveHandle(id));
  });

  it("different identities get different handles (no trivial collision)", () => {
    expect(deriveHandle("alice-uuid")).not.toBe(deriveHandle("bob-uuid"));
  });

  it("is NOT a raw prefix of the id (it hashes, not slices)", () => {
    const id = "abcdef0123456789";
    // The old approach was `id.slice(0, 6)` → "abcdef"; the handle must not be a
    // literal leading slice of the opaque id.
    expect(deriveHandle(id)).not.toBe("abcdef");
    expect(deriveHandle(id).includes(id.slice(0, 6))).toBe(false);
  });

  it("is token-safe: `@<handle>` is one mention chip", () => {
    for (const id of [
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "author-xyz",
      "",
      "with spaces and !punct",
    ]) {
      expect(isTokenSafe(deriveHandle(id))).toBe(true);
    }
  });

  it("the handle, inserted as `@handle `, opens then cleanly closes a query", () => {
    // Inserted with the contract's trailing space, the token is closed (no active
    // query) — i.e. it is a complete, well-formed mention.
    const h = deriveHandle("someone");
    expect(activeMentionQuery(`@${h} `)).toBeNull();
    // …and without the space it IS the active query (round-trips to itself).
    expect(activeMentionQuery(`@${h}`)).toEqual({ query: h, at: 0 });
  });
});

describe("handleFromName — slugify a display name to a token", () => {
  it("strips spaces so a multi-word name is one token", () => {
    expect(handleFromName("Ada Lovelace")).toBe("AdaLovelace");
    expect(isTokenSafe("AdaLovelace")).toBe(true);
  });

  it("drops punctuation that would break the token", () => {
    expect(handleFromName("J. Doe")).toBe("JDoe");
    expect(handleFromName("o'brien")).toBe("obrien");
  });

  it("keeps digits and underscores (they are word chars)", () => {
    expect(handleFromName("user_42")).toBe("user_42");
  });

  it("returns null for an empty/all-punctuation/nullish name", () => {
    expect(handleFromName("")).toBeNull();
    expect(handleFromName("   ")).toBeNull();
    expect(handleFromName("!!!")).toBeNull();
    expect(handleFromName(null)).toBeNull();
    expect(handleFromName(undefined)).toBeNull();
  });
});

/** A point pin authored by `author`, optionally with comment authors. */
function pin(author: string, commentAuthors: string[] = []): ParticipantSource {
  return { author, comments: commentAuthors.map((a) => ({ author: a })) };
}

describe("deriveMentionCandidates — source, dedupe, fallback", () => {
  it("empty source still yields exactly the current user (never empty)", () => {
    const out = deriveMentionCandidates({ annotations: [], currentUserId: "me" });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("author:me");
    expect(out[0].label).toBe(deriveHandle("me"));
    // The current user is NOT labelled "you" — it is their stable handle.
    expect(out[0].label).not.toBe("you");
  });

  it("includes pin AND nested comment authors as participants", () => {
    const out = deriveMentionCandidates({
      annotations: [pin("alice", ["bob", "carol"])],
      currentUserId: "me",
    });
    expect(out.map((c) => c.id)).toEqual([
      "author:me",
      "author:alice",
      "author:bob",
      "author:carol",
    ]);
  });

  it("dedupes a participant who authored many pins/comments to ONE entry", () => {
    const out = deriveMentionCandidates({
      annotations: [pin("alice", ["alice", "alice"]), pin("alice")],
      currentUserId: "me",
    });
    expect(out.map((c) => c.id)).toEqual(["author:me", "author:alice"]);
  });

  it("puts the current user FIRST and skips empty/whitespace authors", () => {
    const out = deriveMentionCandidates({
      annotations: [pin("  ", [""]), pin("bob")],
      currentUserId: "me",
    });
    expect(out.map((c) => c.id)).toEqual(["author:me", "author:bob"]);
  });

  it("derives the current user's handle the SAME way it derives anyone's", () => {
    // The contract behind "mentions of me": the current user's own handle is
    // exactly deriveHandle(theirId), so a later slice can recompute it and match.
    const out = deriveMentionCandidates({
      annotations: [],
      currentUserId: "my-stable-id",
    });
    expect(out[0].label).toBe(deriveHandle("my-stable-id"));
  });
});

describe("deriveMentionCandidates — union with workspace members", () => {
  it("unions members (display-name handles) after participants", () => {
    const out = deriveMentionCandidates({
      annotations: [pin("alice")],
      currentUserId: "me",
      members: [
        { email: "ada@x.io", display_name: "Ada Lovelace" },
        { email: "grace@x.io", display_name: "Grace Hopper" },
      ],
    });
    expect(out.map((c) => c.id)).toEqual([
      "author:me",
      "author:alice",
      "member:ada@x.io",
      "member:grace@x.io",
    ]);
    // Members are handled by their slugified display name.
    expect(out.find((c) => c.id === "member:ada@x.io")?.label).toBe("AdaLovelace");
  });

  it("falls back to an email-derived handle when a member name is unusable", () => {
    const out = deriveMentionCandidates({
      annotations: [],
      currentUserId: "me",
      members: [{ email: "bot@x.io", display_name: "   " }],
    });
    const member = out.find((c) => c.id === "member:bot@x.io");
    expect(member?.label).toBe(deriveHandle("bot@x.io"));
    expect(isTokenSafe(member!.label)).toBe(true);
  });

  it("skips the current user's OWN roster row (matched by email, case-insensitive)", () => {
    // The sharing roster includes the caller; they must appear once — as their
    // participant identity handle — not also as a display-name no peer can match.
    const out = deriveMentionCandidates({
      annotations: [],
      currentUserId: "me",
      currentUserEmail: "Me@Example.com",
      members: [
        { email: "me@example.com", display_name: "Me Myself" },
        { email: "other@x.io", display_name: "Other Person" },
      ],
    });
    expect(out.map((c) => c.id)).toEqual(["author:me", "member:other@x.io"]);
    // No member entry leaked the current user's display name.
    expect(out.some((c) => c.label === "MeMyself")).toBe(false);
  });

  it("dedupes repeated member emails (case-insensitive) to one entry", () => {
    const out = deriveMentionCandidates({
      annotations: [],
      currentUserId: "me",
      members: [
        { email: "dup@x.io", display_name: "First" },
        { email: "DUP@x.io", display_name: "Second" },
      ],
    });
    expect(out.filter((c) => c.id.startsWith("member:"))).toHaveLength(1);
  });

  it("namespaces ids so a member email can't collide with an author id", () => {
    // A participant author string equal to a member email stays a DISTINCT
    // candidate — the two keyspaces are namespaced, so neither shadows the other.
    const out = deriveMentionCandidates({
      annotations: [pin("ada@x.io")],
      currentUserId: "me",
      members: [{ email: "ada@x.io", display_name: "Ada" }],
    });
    expect(out.map((c) => c.id)).toEqual([
      "author:me",
      "author:ada@x.io",
      "member:ada@x.io",
    ]);
  });

  it("every produced label is a valid @-mention token", () => {
    const out = deriveMentionCandidates({
      annotations: [pin("uuid-1", ["uuid-2"])],
      currentUserId: "me",
      members: [
        { email: "a@x.io", display_name: "Ada Lovelace" },
        { email: "b@x.io", display_name: "!!!" },
      ],
    });
    for (const c of out) expect(isTokenSafe(c.label)).toBe(true);
  });
});
