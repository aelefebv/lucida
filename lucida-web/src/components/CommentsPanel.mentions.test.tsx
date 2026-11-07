// @vitest-environment happy-dom
//
// The Comments panel: its threads, newest first, and the mentions-of-me list
// folded into it, with read state the host owns:
//
//   1. unread counts only unviewed mentions;
//   2. picking a mention fires both onNavigate(pinId) and onMarkViewed(cid);
//   3. each mention carries data-viewed reflecting its read state;
//   4. the hide-viewed toggle drops viewed mentions from the list;
//   5. opening a thread marks its mentions read.
//
// Fixtures use the real handle derivation so a comment really mentions me.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useMemo, useState } from "react";
import { CommentsPanel, type CommentsPanelProps } from "./CommentsPanel.tsx";
import type { Annotation } from "./annotationDocument.ts";
import { deriveHandle } from "./annotationParticipants.ts";
import { countUnread, findMentionsOfMe } from "./mentionsOfMe.ts";

// The segmented control's selection indicator animates; happy-dom lacks the API.
if (!("getAnimations" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "getAnimations", { value: () => [] });
}

afterEach(() => cleanup());

const MY_ID = "author-me-stable";
const MY_HANDLE = deriveHandle(MY_ID);

/** Two pins, each with one comment that @-mentions me (c-1 on pin-1, c-2 on
 * pin-2), and a third pin with no mention. */
function pins(): Annotation[] {
  return [
    {
      id: "pin-1",
      kind: "point",
      author: "peer",
      position: [0, 0],
      comments: [{ id: "c-1", author: "peer", text: `look here @${MY_HANDLE}` }],
    },
    {
      id: "pin-2",
      kind: "box",
      author: "peer",
      position: [0, 0],
      z: 4,
      comments: [{ id: "c-2", author: "peer", text: `and here @${MY_HANDLE}` }],
    },
    {
      id: "pin-3",
      kind: "line",
      author: MY_ID,
      position: [0, 0],
      comments: [{ id: "c-3", author: MY_ID, text: "a note to self" }],
    },
  ];
}

function Host({
  viewed: initialViewed = [],
  ...overrides
}: Partial<CommentsPanelProps> & { viewed?: string[] }) {
  const annotations = pins();
  const mentions = useMemo(
    () => findMentionsOfMe({ annotations, currentUserId: MY_ID }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fixtures are stable per render.
    [],
  );
  const [viewed, setViewed] = useState<string[]>(initialViewed);
  return (
    <>
      <output data-testid="unread">{countUnread(mentions, new Set(viewed))}</output>
      <CommentsPanel
        visible
        annotations={annotations}
        mentions={mentions}
        viewedCommentIds={viewed}
        currentUserId={MY_ID}
        extents={{ z: 8, t: 1 }}
        onNavigate={() => {}}
        onMarkViewed={(id) => setViewed((v) => (v.includes(id) ? v : [...v, id]))}
        {...overrides}
      />
    </>
  );
}

function showMentions(): void {
  fireEvent.click(screen.getByRole("radio", { name: /mentions/i }));
}

describe("CommentsPanel threads", () => {
  it("lists threads newest first, with their first comment and where they are", () => {
    render(<Host viewed={["c-1", "c-2"]} />);
    const rows = screen.getAllByTestId(/^comment-thread-/);
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      "comment-thread-pin-3",
      "comment-thread-pin-2",
      "comment-thread-pin-1",
    ]);
    expect(within(rows[0]).getByText("a note to self")).toBeTruthy();
    expect(within(rows[0]).getByText(/^you · 1 comment/)).toBeTruthy();
    expect(within(rows[1]).getByText(/Z 5$/)).toBeTruthy();
  });

  it("navigates to a thread and marks its mentions read", () => {
    const onNavigate = vi.fn();
    render(<Host onNavigate={onNavigate} />);
    expect(screen.getByTestId("unread").textContent).toBe("2");

    // Unread mentions open the mentions list first; go back to the threads.
    fireEvent.click(screen.getByRole("radio", { name: /all threads/i }));
    expect(screen.getByTestId("comment-thread-pin-2").dataset.unread).toBeDefined();
    fireEvent.click(screen.getByTestId("comment-thread-pin-2"));
    expect(onNavigate).toHaveBeenCalledWith("pin-2");
    expect(screen.getByTestId("unread").textContent).toBe("1");
  });
});

describe("CommentsPanel mentions", () => {
  it("counts only unviewed mentions", () => {
    render(<Host viewed={["c-1"]} />);
    expect(screen.getByTestId("unread").textContent).toBe("1");
    expect(screen.getByRole("radio", { name: /mentions \(1\)/i })).toBeTruthy();
  });

  it("picking a mention calls BOTH onNavigate(pinId) and onMarkViewed(commentId)", () => {
    const onNavigate = vi.fn();
    const onMarkViewed = vi.fn();
    render(<Host onNavigate={onNavigate} onMarkViewed={onMarkViewed} />);
    showMentions();
    fireEvent.click(screen.getByTestId("mention-of-me-item-c-1"));
    expect(onNavigate).toHaveBeenCalledWith("pin-1");
    expect(onMarkViewed).toHaveBeenCalledWith("c-1");
  });

  it("each mention carries data-viewed reflecting its read state", () => {
    render(<Host viewed={["c-1"]} />);
    showMentions();
    expect(screen.getByTestId("mention-of-me-item-c-1").getAttribute("data-viewed")).toBe("true");
    expect(screen.getByTestId("mention-of-me-item-c-2").getAttribute("data-viewed")).toBe("false");
  });

  it("hide-viewed lists all when off, only unviewed when engaged", () => {
    render(<Host viewed={["c-1"]} />);
    showMentions();
    expect(screen.getByTestId("mention-of-me-item-c-1")).toBeTruthy();
    expect(screen.getByTestId("mention-of-me-item-c-2")).toBeTruthy();

    fireEvent.click(screen.getByTestId("mentions-of-me-hide-viewed-toggle"));
    expect(screen.queryByTestId("mention-of-me-item-c-1")).toBeNull();
    expect(screen.getByTestId("mention-of-me-item-c-2")).toBeTruthy();
  });

  it("all read with hide-viewed engaged lists no mentions and says why", () => {
    render(<Host viewed={["c-1", "c-2"]} />);
    showMentions();
    expect(screen.getByTestId("mentions-of-me-summary").textContent).toBe("All mentions read");
    fireEvent.click(screen.getByTestId("mentions-of-me-hide-viewed-toggle"));
    const panel = screen.getByTestId("mentions-of-me-panel");
    expect(within(panel).queryByTestId(/^mention-of-me-item-/)).toBeNull();
    expect(within(panel).getByText(/no unread mentions/i)).toBeTruthy();
  });

  it("a pick marks the mention read and the count drops", () => {
    render(<Host />);
    expect(screen.getByTestId("unread").textContent).toBe("2");
    fireEvent.click(screen.getByTestId("mention-of-me-item-c-1"));
    expect(screen.getByTestId("unread").textContent).toBe("1");
    expect(screen.getByTestId("mention-of-me-item-c-1").getAttribute("data-viewed")).toBe("true");
  });

  it("with no mentions at all, the list is empty", () => {
    render(
      <CommentsPanel
        visible
        annotations={[]}
        mentions={[]}
        viewedCommentIds={[]}
        currentUserId={MY_ID}
        onNavigate={() => {}}
        onMarkViewed={() => {}}
      />,
    );
    expect(screen.getByText(/no comments on this dataset yet/i)).toBeTruthy();
    showMentions();
    expect(screen.getByTestId("mentions-of-me-summary").textContent).toMatch(/no one has mentioned you/i);
    expect(screen.queryByTestId(/^mention-of-me-item-/)).toBeNull();
  });
});
