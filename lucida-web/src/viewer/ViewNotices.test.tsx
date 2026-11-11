// @vitest-environment happy-dom
/**
 * A view's notices behind one icon: a new notice opens the list for a few
 * seconds, a press or Escape closes it, and a notice seen before waits
 * behind the icon when it comes back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { __resetEscapeLayersForTesting, escapeTopLayer } from "../ui/escape.ts";
import { NEW_NOTICE_OPEN_MS, ViewNotices } from "./ViewNotices.tsx";
import type { ViewNotice } from "./viewNotices.ts";

const COVERAGE: ViewNotice = { key: "coverage", severity: "warning", message: "This view shows less detail." };
const PLACE: ViewNotice = { key: "link-position", severity: "note", message: "The linked position is outside this view's data." };

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  __resetEscapeLayersForTesting();
});

const list = (root: HTMLElement) => root.querySelector(".lc-view-notices-list") as HTMLElement;
const icon = (root: HTMLElement) => root.querySelector(".lc-view-notices button") as HTMLElement;

describe("ViewNotices", () => {
  it("shows nothing without notices", () => {
    const { container } = render(<ViewNotices notices={[]} />);
    expect(container.querySelector(".lc-view-notices")).toBeNull();
  });

  it("opens the list when a notice first appears, then closes it on its own", () => {
    const { container } = render(<ViewNotices notices={[COVERAGE]} />);
    expect(list(container).hidden).toBe(false);
    expect(list(container).textContent).toBe(COVERAGE.message);
    act(() => vi.advanceTimersByTime(NEW_NOTICE_OPEN_MS));
    expect(list(container).hidden).toBe(true);
  });

  it("stays open while the pointer is over it", () => {
    const { container } = render(<ViewNotices notices={[COVERAGE]} />);
    fireEvent.pointerEnter(container.querySelector(".lc-view-notices")!);
    act(() => vi.advanceTimersByTime(NEW_NOTICE_OPEN_MS * 2));
    expect(list(container).hidden).toBe(false);
    fireEvent.pointerLeave(container.querySelector(".lc-view-notices")!);
    act(() => vi.advanceTimersByTime(NEW_NOTICE_OPEN_MS));
    expect(list(container).hidden).toBe(true);
  });

  it("opens and closes on a press, and closes on Escape", () => {
    const { container } = render(<ViewNotices notices={[COVERAGE]} />);
    fireEvent.click(icon(container));
    expect(list(container).hidden).toBe(true);
    expect(icon(container).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(icon(container));
    expect(list(container).hidden).toBe(false);
    // Opened by hand, it waits for the person.
    act(() => vi.advanceTimersByTime(NEW_NOTICE_OPEN_MS * 2));
    expect(list(container).hidden).toBe(false);
    act(() => {
      escapeTopLayer();
    });
    expect(list(container).hidden).toBe(true);
  });

  it("leaves a notice seen before behind the icon when it comes back", () => {
    const { container, rerender } = render(<ViewNotices notices={[COVERAGE]} />);
    act(() => vi.advanceTimersByTime(NEW_NOTICE_OPEN_MS));
    rerender(<ViewNotices notices={[]} />);
    rerender(<ViewNotices notices={[COVERAGE]} />);
    expect(list(container).hidden).toBe(true);
    // Another kind is new, so it opens the list again, the warning first.
    rerender(<ViewNotices notices={[COVERAGE, PLACE]} />);
    expect(list(container).hidden).toBe(false);
    expect([...list(container).children].map((item) => item.textContent)).toEqual([COVERAGE.message, PLACE.message]);
  });

  it("wears the most severe notice, counts several, and names both", () => {
    const { container, rerender } = render(<ViewNotices notices={[PLACE]} />);
    expect(container.querySelector(".lc-view-notices")!.getAttribute("data-severity")).toBe("note");
    expect(icon(container).textContent).toBe("");
    rerender(<ViewNotices notices={[COVERAGE, PLACE]} />);
    expect(container.querySelector(".lc-view-notices")!.getAttribute("data-severity")).toBe("warning");
    expect(icon(container).textContent).toBe("2");
    expect(icon(container).getAttribute("aria-label")).toBe(`2 notices: ${COVERAGE.message}`);
  });
});
