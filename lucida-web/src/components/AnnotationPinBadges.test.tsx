// @vitest-environment happy-dom

import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CommentCountBadge, OffContextHelptext } from "./AnnotationPinBadges.tsx";
import type { Annotation } from "./annotationDocument.ts";

afterEach(() => {
  cleanup();
});

describe("CommentCountBadge", () => {
  it("renders nothing for an empty thread", () => {
    const { container } = render(<CommentCountBadge count={0} onToggleThread={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the count with a singular aria-label at one comment", () => {
    render(<CommentCountBadge count={1} onToggleThread={() => {}} />);
    const badge = screen.getByLabelText("1 comment");
    expect(badge.textContent).toBe("1");
  });

  it("pluralizes the aria-label past one comment", () => {
    render(<CommentCountBadge count={3} onToggleThread={() => {}} />);
    const badge = screen.getByLabelText("3 comments");
    expect(badge.textContent).toBe("3");
  });

  it("clicking the badge fires the thread toggle", () => {
    const onToggleThread = vi.fn();
    render(<CommentCountBadge count={2} onToggleThread={onToggleThread} />);
    fireEvent.click(screen.getByLabelText("2 comments"));
    expect(onToggleThread).toHaveBeenCalledTimes(1);
  });
});

describe("OffContextHelptext", () => {
  function pin(overrides: Partial<Annotation> = {}): Annotation {
    return { id: "pin-a", position: [1, 2], author: "7", kind: "point", ...overrides };
  }

  it("carries the pin-scoped testid and names the pin's own Z/T/C in contract form", () => {
    render(<OffContextHelptext pin={pin({ z: 12, t: 3, c: 1 })} />);
    const el = screen.getByTestId("annot-offcontext-pin-a");
    expect(el.textContent).toBe("slice 12 · t=3 · ch=1");
  });

  it("defaults absent z/t/c to 0 (an older pin still gets a full locator)", () => {
    render(<OffContextHelptext pin={pin()} />);
    expect(screen.getByTestId("annot-offcontext-pin-a").textContent).toBe("slice 0 · t=0 · ch=0");
  });
});
