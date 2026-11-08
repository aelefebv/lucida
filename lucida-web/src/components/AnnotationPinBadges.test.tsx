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

  it("shows the count, hidden from assistive technology since the marker's name says it", () => {
    const { container } = render(<CommentCountBadge count={3} onToggleThread={() => {}} />);
    const badge = container.firstChild as HTMLElement;
    expect(badge.textContent).toBe("3");
    expect(badge.getAttribute("aria-hidden")).toBe("true");
  });

  it("clicking the badge fires the thread toggle", () => {
    const onToggleThread = vi.fn();
    const { container } = render(<CommentCountBadge count={2} onToggleThread={onToggleThread} />);
    fireEvent.click(container.firstChild as HTMLElement);
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
    expect(el.textContent).toBe("Z 13 · T 4 · Channel 2");
  });

  it("defaults absent z/t/c to 0 (an older pin still gets a full locator)", () => {
    render(<OffContextHelptext pin={pin()} />);
    expect(screen.getByTestId("annot-offcontext-pin-a").textContent).toBe("Z 1 · T 1 · Channel 1");
  });
});
