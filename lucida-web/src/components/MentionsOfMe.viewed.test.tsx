// @vitest-environment happy-dom
//
// Behavior tests for the read/unread inbox added in issue #803, layered on top
// of the slice-2 "mentions of me" indicator. These drive the REAL <MentionsOfMe>
// with plain annotation data and assert the EXACT interaction contract:
//
//   1. the badge counts only UNVIEWED mentions;
//   2. clicking an item fires BOTH onNavigate(pinId) and onMarkViewed(cid);
//   3. each item carries data-viewed reflecting its read-state;
//   4. the hide-viewed toggle drops viewed items from the list;
//   5. zero unviewed -> badge 0, and with hide-viewed engaged the panel lists
//      no items.
//
// Slice-2 behavior (handle matching, jump-to-pin) is exercised indirectly: the
// fixtures rely on the real handle derivation so a comment "mentions me".

import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { MentionsOfMe } from "./MentionsOfMe.tsx";
import type { Annotation } from "./AnnotationOverlay.tsx";
import { deriveHandle } from "./annotationParticipants.ts";

afterEach(() => cleanup());

const MY_ID = "author-me-stable";
const MY_HANDLE = deriveHandle(MY_ID);

/** Two pins, each with one comment that @-mentions me (c-1 on pin-1, c-2 on
 * pin-2). The text routes through the real tokenizer so these are genuine
 * matches, exactly as a peer's mention would arrive. */
function twoMentions(): Annotation[] {
  return [
    {
      id: "pin-1",
      comments: [{ id: "c-1", author: "peer", text: `look here @${MY_HANDLE}` }],
    },
    {
      id: "pin-2",
      comments: [{ id: "c-2", author: "peer", text: `and here @${MY_HANDLE}` }],
    },
  ] as unknown as Annotation[];
}

function badgeText(): string {
  return screen.getByTestId("mentions-of-me-badge").textContent ?? "";
}

function openPanel(): void {
  fireEvent.click(screen.getByTestId("mentions-of-me-badge"));
}

describe("MentionsOfMe read/unread inbox (#803)", () => {
  it("badge counts only UNVIEWED mentions", () => {
    const { rerender } = render(
      <MentionsOfMe
        annotations={twoMentions()}
        currentUserId={MY_ID}
        onNavigate={() => {}}
        viewedCommentIds={[]}
      />,
    );
    // Nothing viewed yet -> both unread.
    expect(badgeText()).toContain("2");

    // One viewed -> one unread.
    rerender(
      <MentionsOfMe
        annotations={twoMentions()}
        currentUserId={MY_ID}
        onNavigate={() => {}}
        viewedCommentIds={["c-1"]}
      />,
    );
    expect(badgeText()).toContain("1");

    // All viewed -> zero unread (contract #5).
    rerender(
      <MentionsOfMe
        annotations={twoMentions()}
        currentUserId={MY_ID}
        onNavigate={() => {}}
        viewedCommentIds={["c-1", "c-2"]}
      />,
    );
    expect(badgeText()).toContain("0");
  });

  it("clicking an item calls BOTH onNavigate(pinId) and onMarkViewed(commentId)", () => {
    const onNavigate = vi.fn();
    const onMarkViewed = vi.fn();
    render(
      <MentionsOfMe
        annotations={twoMentions()}
        currentUserId={MY_ID}
        onNavigate={onNavigate}
        onMarkViewed={onMarkViewed}
        viewedCommentIds={[]}
      />,
    );
    openPanel();
    fireEvent.click(screen.getByTestId("mention-of-me-item-c-1"));

    // Navigation targets the OWNING pin (unchanged slice-2 contract) ...
    expect(onNavigate).toHaveBeenCalledWith("pin-1");
    // ... AND the comment is marked viewed.
    expect(onMarkViewed).toHaveBeenCalledWith("c-1");
  });

  it("each item carries data-viewed reflecting its read-state (#3)", () => {
    render(
      <MentionsOfMe
        annotations={twoMentions()}
        currentUserId={MY_ID}
        onNavigate={() => {}}
        viewedCommentIds={["c-1"]}
      />,
    );
    openPanel();
    expect(
      screen.getByTestId("mention-of-me-item-c-1").getAttribute("data-viewed"),
    ).toBe("true");
    expect(
      screen.getByTestId("mention-of-me-item-c-2").getAttribute("data-viewed"),
    ).toBe("false");
  });

  it("hide-viewed toggle: lists all when off, only unviewed when engaged (#4)", () => {
    render(
      <MentionsOfMe
        annotations={twoMentions()}
        currentUserId={MY_ID}
        onNavigate={() => {}}
        viewedCommentIds={["c-1"]}
      />,
    );
    openPanel();
    // Off: both items listed (the viewed one marked, per #3).
    expect(screen.getByTestId("mention-of-me-item-c-1")).toBeTruthy();
    expect(screen.getByTestId("mention-of-me-item-c-2")).toBeTruthy();

    // Engage hide-viewed: the viewed item (c-1) is gone, the unviewed remains.
    fireEvent.click(screen.getByTestId("mentions-of-me-hide-viewed-toggle"));
    expect(screen.queryByTestId("mention-of-me-item-c-1")).toBeNull();
    expect(screen.getByTestId("mention-of-me-item-c-2")).toBeTruthy();
  });

  it("zero unviewed + hide-viewed engaged: badge 0 and the panel lists NO items (#5)", () => {
    render(
      <MentionsOfMe
        annotations={twoMentions()}
        currentUserId={MY_ID}
        onNavigate={() => {}}
        viewedCommentIds={["c-1", "c-2"]}
      />,
    );
    expect(badgeText()).toContain("0");
    openPanel();
    // All read; the panel still opens but lists no mention items once hidden.
    fireEvent.click(screen.getByTestId("mentions-of-me-hide-viewed-toggle"));
    const panel = screen.getByTestId("mentions-of-me-panel");
    expect(
      within(panel).queryByTestId("mention-of-me-item-c-1"),
    ).toBeNull();
    expect(
      within(panel).queryByTestId("mention-of-me-item-c-2"),
    ).toBeNull();
  });

  it("end-to-end with a host that owns viewed-state: click marks read, count drops", () => {
    // Mirror App's ownership: the host holds the viewed set and passes it down;
    // a click composes onNavigate with the host's markViewed.
    const onNavigate = vi.fn();
    function Host() {
      const [viewed, setViewed] = useState<string[]>([]);
      return (
        <MentionsOfMe
          annotations={twoMentions()}
          currentUserId={MY_ID}
          onNavigate={onNavigate}
          viewedCommentIds={viewed}
          onMarkViewed={(id) => setViewed((v) => (v.includes(id) ? v : [...v, id]))}
        />
      );
    }
    render(<Host />);
    expect(badgeText()).toContain("2");

    openPanel();
    fireEvent.click(screen.getByTestId("mention-of-me-item-c-1"));

    // The host marked it read: count drops and the item now reads as viewed.
    expect(onNavigate).toHaveBeenCalledWith("pin-1");
    expect(badgeText()).toContain("1");
    expect(
      screen.getByTestId("mention-of-me-item-c-1").getAttribute("data-viewed"),
    ).toBe("true");
  });

  it("with no mentions at all, badge is 0 and the panel shows no items", () => {
    render(
      <MentionsOfMe
        annotations={[]}
        currentUserId={MY_ID}
        onNavigate={() => {}}
        viewedCommentIds={[]}
      />,
    );
    expect(badgeText()).toContain("0");
    openPanel();
    expect(screen.queryByTestId(/^mention-of-me-item-/)).toBeNull();
  });
});
