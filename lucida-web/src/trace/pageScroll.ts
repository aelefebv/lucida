import type { PageScrollReading } from "./types.ts";

/**
 * Where `doc` is scrolled, and its scroll size against the viewport it
 * scrolls in. The scrolling element's client box is that viewport less any
 * scrollbar, so a scroll size larger than it is a scroll range whether or
 * not the page hides its overflow: a hidden overflow still scrolls to a
 * focus or a script.
 */
export function readPageScroll(doc: Document = document): PageScrollReading {
  const root = doc.scrollingElement ?? doc.documentElement;
  return {
    scrollX: doc.defaultView?.scrollX ?? root.scrollLeft,
    scrollY: doc.defaultView?.scrollY ?? root.scrollTop,
    scrollWidth: root.scrollWidth,
    scrollHeight: root.scrollHeight,
    viewportWidth: root.clientWidth,
    viewportHeight: root.clientHeight,
  };
}
