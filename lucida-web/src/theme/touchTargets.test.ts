import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Under a coarse pointer the control height and --lc-target-min are 44px
 * (tokens.css), and a rule reaches that size only by referencing one of them.
 * Every control a stylesheet draws a focus ring for has to, on its own box or
 * on a pseudo-element hit area around it, as in ColormapPicker.css.
 */

const SRC = resolve(process.cwd(), "src");

/** Controls sized some other way, each for a reason a reader can check. */
const EXEMPT: Readonly<Record<string, string>> = {
  ".lc-accent-custom": "also an .lc-accent-swatch",
  ".lc-select-trigger": "also an .lc-input-group",
  ".lc-slider-thumb": "the slider's track takes the press",
  ".lc-navigator-cell": "a panel sizes its cells to the target (CollectionSelector.tsx); over the canvas they shrink to fit",
  ".lc-saved-view-visibility-option input": "its whole label takes the press",
  ".lc-toast": "a whole toast",
  ".lc-ws-card-link": "a whole dashboard card",
};

/** Controls that fall short under a finger. Take one out once it is sized. */
const SHORT: ReadonlySet<string> = new Set<string>();

const FOCUS = /:focus-visible|\[data-focus-visible\]/;
const SIZED = /--lc-target-min|--lc-control-h/;

interface Rule {
  sheet: string;
  selector: string;
  body: string;
}

function rules(): Rule[] {
  const sheets = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".css"));
  return sheets.flatMap((sheet) => {
    const css = readFileSync(join(SRC, sheet), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // Innermost blocks only, so a rule inside @media is read as itself.
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, prelude]) => !prelude.trim().startsWith("@"))
      .flatMap(([, prelude, body]) =>
        prelude.split(",").map((s) => ({ sheet, selector: s.trim().replace(/\s+/g, " "), body })),
      );
  });
}

/**
 * The control a focus-ring selector draws on: the last class of the compound
 * that takes focus, or the selector up to a classless one. A selector with no
 * class at all is a global ring, not a control.
 */
function controlOf(selector: string): string | null {
  const compounds = selector.split(/ ?[>+~ ] ?/);
  const at = compounds.findIndex((c) => FOCUS.test(c));
  const classes = compounds[at].match(/\.[\w-]+/g);
  if (classes) return classes[classes.length - 1];
  if (!/\./.test(selector)) return null;
  return [...compounds.slice(0, at), compounds[at].replace(/[:[].*$/, "")].join(" ");
}

function isSized(control: string, all: readonly Rule[]): boolean {
  const escaped = control.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The control itself, in any state or context, or its pseudo-element.
  const target = new RegExp(`${escaped}(?![\\w-])(?:\\[[^\\]]*\\]|:[\\w-]+(?:\\([^)]*\\))?)*(?:::(?:before|after))?$`);
  return all.some((r) => target.test(r.selector) && SIZED.test(r.body));
}

describe("touch targets in the stylesheets", () => {
  const all = rules();
  const controls = new Map<string, string>();
  for (const { sheet, selector } of all) {
    if (!FOCUS.test(selector)) continue;
    const control = controlOf(selector);
    if (control !== null && !controls.has(control)) controls.set(control, sheet);
  }

  it("size every focusable control for a finger", () => {
    expect(controls.size).toBeGreaterThan(20);
    const strays = [...controls]
      .filter(([control]) => !(control in EXEMPT) && !SHORT.has(control) && !isSized(control, all))
      .map(([control, sheet]) => `${sheet.replace(/\\/g, "/")}: ${control}`);
    expect(
      strays,
      "size it with max(own, var(--lc-target-min)) or a ::before hit area, or exempt it with a reason",
    ).toEqual([]);
  });

  it("list only controls the stylesheets still draw, and short ones still short", () => {
    const stale = [...Object.keys(EXEMPT), ...SHORT].filter((control) => !controls.has(control));
    expect(stale, "take it out of the list").toEqual([]);
    const fixed = [...SHORT].filter((control) => isSized(control, all));
    expect(fixed, "take it out of SHORT").toEqual([]);
  });

  it("find the control a focus ring is drawn on", () => {
    expect(controlOf(".lc-a:focus-visible")).toBe(".lc-a");
    expect(controlOf(".lc-a[data-focus-visible] .lc-b")).toBe(".lc-a");
    expect(controlOf(".lc-wrap .lc-a.lc-b[data-focus-visible]")).toBe(".lc-b");
    expect(controlOf(".lc-a input:focus-visible")).toBe(".lc-a input");
    expect(controlOf(":focus-visible")).toBeNull();
  });

  it("count a control sized on itself or on a hit area around it", () => {
    const rule = (selector: string, body: string): Rule => ({ sheet: "a.css", selector, body });
    expect(isSized(".lc-a", [rule(".lc-a", "min-height: max(24px, var(--lc-target-min));")])).toBe(true);
    expect(isSized(".lc-a", [rule(".lc-a::before", "inset: min(0px, calc(16px - var(--lc-target-min)));")])).toBe(true);
    expect(isSized(".lc-a", [rule(".lc-panel .lc-a[data-size=sm]", "height: var(--lc-control-h-sm);")])).toBe(true);
    expect(isSized(".lc-a", [rule(".lc-a-icon", "height: var(--lc-control-h);")])).toBe(false);
    expect(isSized(".lc-a", [rule(".lc-a .lc-b", "height: var(--lc-control-h);")])).toBe(false);
    expect(isSized(".lc-a", [rule(".lc-a", "height: 24px;")])).toBe(false);
  });
});
