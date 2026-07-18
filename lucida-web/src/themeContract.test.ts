import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const css = read("./index.css");

function componentCssSources(
  directory = new URL("./", import.meta.url),
  prefix = "",
): Array<[string, string]> {
  const sources: Array<[string, string]> = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      sources.push(...componentCssSources(
        new URL(`${entry.name}/`, directory),
        `${prefix}${entry.name}/`,
      ));
    } else if (entry.name.endsWith(".css") && entry.name !== "index.css") {
      sources.push([`${prefix}${entry.name}`, readFileSync(new URL(entry.name, directory), "utf8")]);
    }
  }
  return sources;
}

const presentationSources = new Map([
  ...componentCssSources(),
  ["App.tsx", read("./App.tsx")],
  ["WorkspaceDashboard.tsx", read("./WorkspaceDashboard.tsx")],
  ["WorkspaceSharingDialog.tsx", read("./WorkspaceSharingDialog.tsx")],
  ["ProfileMenu.tsx", read("./auth/ProfileMenu.tsx")],
  ["UnauthLanding.tsx", read("./auth/UnauthLanding.tsx")],
  ["DebugPanel.tsx", read("./debug/DebugPanel.tsx")],
  ["ConfigTab.tsx", read("./debug/ConfigTab.tsx")],
  ["LoadingViewBanner.tsx", read("./components/LoadingViewBanner.tsx")],
  ["ImportWarningBanner.tsx", read("./components/ImportWarningBanner.tsx")],
  ["ShareToolbarButton.tsx", read("./components/ShareToolbarButton.tsx")],
  ["MentionsOfMe.tsx", read("./components/MentionsOfMe.tsx")],
  ["CollectionSelector.tsx", read("./components/CollectionSelector.tsx")],
  ["FlyCameraHint.tsx", read("./components/FlyCameraHint.tsx")],
  ["FpsCounter.tsx", read("./components/FpsCounter.tsx")],
]);

function token(name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match?.[1]) throw new Error(`missing six-digit color token --${name}`);
  return match[1];
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function themeSnapshot(osPreference: "light" | "dark") {
  return {
    osPreference,
    nativeScheme: "dark",
    canvas: { background: token("surface-canvas"), text: token("text-primary") },
    panel: { background: token("surface-1"), text: token("text-secondary") },
    raised: { background: token("surface-raised"), text: token("text-primary") },
    muted: token("text-muted"),
    accent: token("accent"),
    focus: token("focus-ring"),
    danger: { background: token("danger-surface"), text: token("danger-text") },
    warning: { background: token("warning-surface"), text: token("warning-text") },
    success: { background: token("success-surface"), text: token("success-text") },
  };
}

describe("web theme contract", () => {
  it("intentionally exposes one complete forced-dark native-control theme", () => {
    expect(css).toMatch(/color-scheme:\s*dark;/);
    expect(css).not.toMatch(/color-scheme:\s*light\s+dark/);
    expect([...presentationSources.values()].join("\n")).not.toMatch(/prefers-color-scheme/);
  });

  it("keeps stable component presentation on semantic tokens", () => {
    for (const [name, source] of presentationSources) {
      const presentation = withoutComments(source);
      expect(
        presentation,
        `${name} contains a component-local color literal; add/reuse a :root token`,
      ).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    }
    expect(presentationSources.get("debug/DebugPanel.css")).toMatch(
      /\.debug-more\s*\{[^}]*color:\s*var\(--text-muted\)/s,
    );
  });

  it("resolves representative surfaces identically under light and dark OS preference", () => {
    expect([themeSnapshot("light"), themeSnapshot("dark")]).toMatchInlineSnapshot(`
      [
        {
          "accent": "#8c92ff",
          "canvas": {
            "background": "#101318",
            "text": "#f3f5f7",
          },
          "danger": {
            "background": "#3a1b20",
            "text": "#ffc4ca",
          },
          "focus": "#b8bcff",
          "muted": "#a0aab7",
          "nativeScheme": "dark",
          "osPreference": "light",
          "panel": {
            "background": "#171b22",
            "text": "#c0c8d2",
          },
          "raised": {
            "background": "#252b35",
            "text": "#f3f5f7",
          },
          "success": {
            "background": "#183321",
            "text": "#9be9aa",
          },
          "warning": {
            "background": "#4a330d",
            "text": "#ffe0a8",
          },
        },
        {
          "accent": "#8c92ff",
          "canvas": {
            "background": "#101318",
            "text": "#f3f5f7",
          },
          "danger": {
            "background": "#3a1b20",
            "text": "#ffc4ca",
          },
          "focus": "#b8bcff",
          "muted": "#a0aab7",
          "nativeScheme": "dark",
          "osPreference": "dark",
          "panel": {
            "background": "#171b22",
            "text": "#c0c8d2",
          },
          "raised": {
            "background": "#252b35",
            "text": "#f3f5f7",
          },
          "success": {
            "background": "#183321",
            "text": "#9be9aa",
          },
          "warning": {
            "background": "#4a330d",
            "text": "#ffe0a8",
          },
        },
      ]
    `);
  });

  it.each([
    ["text-primary", "surface-canvas"],
    ["text-primary", "surface-1"],
    ["text-primary", "surface-2"],
    ["text-secondary", "surface-canvas"],
    ["text-secondary", "surface-1"],
    ["text-muted", "surface-1"],
    ["text-muted", "surface-2"],
    ["text-link", "surface-canvas"],
    ["info-text", "surface-1"],
    ["success-text", "success-surface"],
    ["danger-text", "danger-surface"],
    ["warning-text", "warning-surface"],
    ["personal-text", "surface-1"],
    ["proposal-text", "surface-1"],
    ["accent-contrast", "accent"],
    ["accent-contrast", "accent-strong"],
  ])("keeps --%s readable on --%s at WCAG AA normal-text contrast", (foreground, background) => {
    expect(contrast(token(foreground), token(background))).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["focus-ring", "surface-canvas"],
    ["focus-ring", "surface-1"],
    ["focus-ring", "surface-2"],
    ["accent", "surface-canvas"],
    ["accent", "surface-1"],
  ])("keeps essential --%s graphics distinct from --%s", (foreground, background) => {
    expect(contrast(token(foreground), token(background))).toBeGreaterThanOrEqual(3);
  });
});
