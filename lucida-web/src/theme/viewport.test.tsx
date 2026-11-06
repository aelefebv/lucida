// @vitest-environment happy-dom

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  POINTER_COARSE_MEDIA,
  VIEWPORT_MEDIA,
  getViewportClass,
  usePointerCoarse,
  useViewportClass,
  type ViewportClass,
} from "./viewport.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Evaluates the range forms VIEWPORT_MEDIA uses at a given width. */
function widthMatches(query: string, width: number): boolean {
  const m = /^\((?:(\d+)px (<=|<) )?width(?: (<|<=|>=|>) (\d+)px)?\)$/.exec(query);
  if (!m) throw new Error(`not a width range: ${query}`);
  const [, low, lowOp, highOp, high] = m;
  if (low !== undefined && !(lowOp === "<" ? +low < width : +low <= width)) return false;
  if (high === undefined) return true;
  return { "<": width < +high, "<=": width <= +high, ">": width > +high, ">=": width >= +high }[highOp]!;
}

describe("the width classes", () => {
  const classes: ViewportClass[] = ["phone", "tablet", "desktop"];

  it.each([320, 390, 639, 639.5, 640, 820, 1023, 1023.9, 1024, 1280, 1600])(
    "put %spx in exactly one class",
    (width) => {
      const matching = classes.filter((name) => widthMatches(VIEWPORT_MEDIA[name], width));
      expect(matching).toHaveLength(1);
      expect(widthMatches(VIEWPORT_MEDIA.belowDesktop, width)).toBe(matching[0] !== "desktop");
    },
  );

  it.each([
    [390, "phone"],
    [820, "tablet"],
    [1280, "desktop"],
  ] as const)("read %spx as %s through the browser's own query matching", (width, expected) => {
    (window as unknown as { happyDOM: { setViewport(size: { width: number; height: number }): void } }).happyDOM.setViewport(
      { width, height: 800 },
    );
    expect(getViewportClass()).toBe(expected);
    expect(classes.filter((name) => matchMedia(VIEWPORT_MEDIA[name]).matches)).toEqual([expected]);
  });
});

describe("media queries in the stylesheets", () => {
  // CSS cannot import viewport.ts, so a stylesheet that writes its own
  // breakpoint would drift from the hook. Every width and pointer query
  // has to be one of the shared strings.
  const root = resolve(process.cwd(), "src");
  const sheets = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".css"));
  const allowedWidths = new Set<string>(Object.values(VIEWPORT_MEDIA));

  it("use only the shared width and pointer queries", () => {
    expect(sheets.length).toBeGreaterThan(10);
    const strays: string[] = [];
    for (const sheet of sheets) {
      const css = readFileSync(join(root, sheet), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [, prelude] of css.matchAll(/@media([^{]+)\{/g)) {
        for (const [feature] of prelude.matchAll(/\([^()]*\)/g)) {
          const normalized = feature.replace(/\s+/g, " ");
          if (/width/.test(normalized) && !allowedWidths.has(normalized)) strays.push(`${sheet}: ${normalized}`);
          if (/pointer/.test(normalized) && normalized !== POINTER_COARSE_MEDIA) strays.push(`${sheet}: ${normalized}`);
        }
      }
    }
    expect(strays, "add the query to VIEWPORT_MEDIA, or use one that is there").toEqual([]);
  });
});

/** A matchMedia whose answers the test sets, firing change as they flip. */
function stubMedia(initial: Record<string, boolean>) {
  const answers = new Map(Object.entries(initial));
  const listeners = new Map<string, Set<() => void>>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() {
      return answers.get(query) ?? false;
    },
    addEventListener: (_: string, listener: () => void) => {
      if (!listeners.has(query)) listeners.set(query, new Set());
      listeners.get(query)!.add(listener);
    },
    removeEventListener: (_: string, listener: () => void) => listeners.get(query)?.delete(listener),
  }));
  return (query: string, value: boolean) => {
    answers.set(query, value);
    act(() => listeners.get(query)?.forEach((listener) => listener()));
  };
}

function Probe() {
  return (
    <output>
      {useViewportClass()} {usePointerCoarse() ? "coarse" : "fine"}
    </output>
  );
}

describe("useViewportClass and usePointerCoarse", () => {
  it("follow the queries as they change, each on its own", () => {
    const set = stubMedia({ [VIEWPORT_MEDIA.desktop]: true });
    render(<Probe />);
    expect(screen.getByRole("status").textContent).toBe("desktop fine");

    set(POINTER_COARSE_MEDIA, true);
    expect(screen.getByRole("status").textContent).toBe("desktop coarse");

    set(VIEWPORT_MEDIA.desktop, false);
    expect(screen.getByRole("status").textContent).toBe("tablet coarse");

    set(VIEWPORT_MEDIA.phone, true);
    set(POINTER_COARSE_MEDIA, false);
    expect(screen.getByRole("status").textContent).toBe("phone fine");
  });
});
