import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Every color in the UI is a token (ADR 0066). This holds the line: a color
 * written as a literal anywhere in src fails here, outside the token file and
 * the few files that define a palette on purpose.
 */

const SRC = resolve(process.cwd(), "src");

/** Files allowed to spell colors, each for a reason a reader can check. */
const ALLOWED: Readonly<Record<string, string>> = {
  "theme/tokens.css": "the token file",
  "theme/AccentPicker.css": "the custom accent swatch draws the hue wheel a custom accent picks from",
  "theme/AccentPicker.tsx": "the custom accent's starting value",
  "ui/gallery/UiGallery.css": "the review page's stand-in for image data, which is never themed",
  "ui/gallery/UiGallery.tsx": "sample presence and channel colors on the review page",
};

// The CSS named colors, less the keywords that are not a color of their own.
const NAMED = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown " +
    "burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan " +
    "darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
    "darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
    "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro " +
    "ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow " +
    "lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine " +
    "mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise " +
    "mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab " +
    "orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru " +
    "pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
    "seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan " +
    "teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
  ).split(" "),
);

// A functional color with a literal first channel. `rgba(${r}, …)` formats a
// resolved token and `oklch(from var(--x) …)` derives from one, so neither counts.
const FUNCTIONAL = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*(?:[\d.]|#|from\s+#)/gi;
// In CSS any hex is a color. In a script `#899` is as likely an issue number in
// prose, so a short hex counts when it has a letter, is a whole string, or
// follows a border style.
const CSS_HEX = /#[0-9a-f]{3,8}\b/gi;
const SCRIPT_HEX =
  /#(?:[0-9a-f]{8}|[0-9a-f]{6})\b|#(?=\d*[a-f])[0-9a-f]{3,4}\b|["'`]#[0-9a-f]{3,4}["'`]|(?:solid|dashed|dotted|double)\s+#[0-9a-f]{3,4}\b/gi;
// A named color as a CSS value: in a stylesheet, or in a script as a style
// property, a canvas paint, or an SVG attribute.
const CSS_VALUE = /(?:^|[{;])\s*[\w-]+\s*:([^;{}]*)/g;
const STYLE_VALUE =
  /\b(?:color|background\w*|border\w*|outline\w*|fill|stroke|stopColor|boxShadow|textShadow|caretColor|accentColor|fillStyle|strokeStyle|shadowColor)\s*[:=]\s*(["'`])([^"'`]*)\1/g;

function stripComments(source: string, css: boolean): string {
  // Keep newlines so reported line numbers stay right.
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  const block = source.replace(/\/\*[\s\S]*?\*\//g, blank);
  return css ? block : block.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

function namedIn(value: string): string | null {
  // Words in var(...) are token names, and words in ${...} are code.
  const words = value.replace(/var\([^)]*\)|\$\{[^}]*\}/g, "").toLowerCase().match(/[a-z]+/g) ?? [];
  return words.find((w) => NAMED.has(w)) ?? null;
}

/** Every color literal in a source file, as `line: text`. */
function colorLiterals(source: string, file: string): string[] {
  const css = file.endsWith(".css");
  const code = stripComments(source, css);
  const found: { index: number; text: string }[] = [];
  const add = (index: number, text: string) => found.push({ index, text });
  for (const m of code.matchAll(FUNCTIONAL)) add(m.index, m[0]);
  for (const m of code.matchAll(css ? CSS_HEX : SCRIPT_HEX)) add(m.index, m[0]);
  if (css) {
    for (const m of code.matchAll(CSS_VALUE)) {
      const name = namedIn(m[1]);
      if (name) add(m.index, name);
    }
  } else {
    for (const m of code.matchAll(STYLE_VALUE)) {
      const name = namedIn(m[2]);
      if (name) add(m.index, name);
    }
  }
  return found
    .sort((a, b) => a.index - b.index)
    .map(({ index, text }) => `${code.slice(0, index).split("\n").length}: ${text.trim()}`);
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(css|tsx?)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("color literals", () => {
  const files = sources(SRC).map((path) => ({
    file: relative(SRC, path).replace(/\\/g, "/"),
    literals: colorLiterals(readFileSync(path, "utf8"), path),
  }));

  it("appear only in the token file and explicit palette definitions", () => {
    const offenders = files
      .filter(({ file, literals }) => literals.length > 0 && !(file in ALLOWED))
      .map(({ file, literals }) => `${file}\n  ${literals.join("\n  ")}`);
    expect(offenders, "use a --lc-* token, or add one to theme/tokens.css with a dark and a light value").toEqual([]);
  });

  it("keep every allowed file on the list for a literal it still has", () => {
    const stale = Object.keys(ALLOWED).filter((file) => !files.some((f) => f.file === file && f.literals.length > 0));
    expect(stale).toEqual([]);
  });
});

describe("the color literal scan", () => {
  it("finds hex, functional, and named colors in a stylesheet", () => {
    const css = ".a { color: #fff; background: rgba(0, 0, 0, 0.5); border: 1px solid white; }";
    expect(colorLiterals(css, "a.css")).toEqual(["1: #fff", "1: rgba(0", "1: white"]);
  });

  it("finds them in style objects, canvas paints, and SVG attributes", () => {
    const tsx = [
      'const style = { color: "black", boxShadow: "0 0 0 1px #00000040" };',
      'ctx.fillStyle = "#336699";',
      '<rect fill="red" stroke="#888" />',
      'const edge = { border: "1px solid #888", outline: "2px solid #abc" };',
    ].join("\n");
    expect(colorLiterals(tsx, "a.tsx")).toEqual([
      "1: black",
      "1: #00000040",
      "2: #336699",
      "3: red",
      '3: "#888"',
      "4: solid #888",
      "4: solid #abc",
    ]);
  });

  it("passes tokens, derived colors, comments, keywords, and prose", () => {
    const css = [
      "/* text on a white canvas */",
      ".a { color: var(--lc-text); white-space: nowrap; border-color: transparent; }",
      ".b { color: oklch(from var(--peer-color) 0.2 0 0); fill: currentColor; }",
      '[data-canvas="white"] { --x: var(--lc-canvas-bg); }',
    ].join("\n");
    const ts = [
      "// see #899 for the threshold",
      'const why = "#1066 measured it";',
      "const css = `rgba(${r}, ${g}, ${b}, ${a})`;",
      'const style = { background: "var(--lc-surface-1)", color: "inherit" };',
    ].join("\n");
    expect(colorLiterals(css, "a.css")).toEqual([]);
    expect(colorLiterals(ts, "a.ts")).toEqual([]);
  });
});
