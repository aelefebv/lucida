// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCENT_PRESETS,
  CANVAS_BACKGROUNDS,
  DENSITIES,
  THEME_OPTIONS,
  accentPreference,
  resolveAppearance,
  themePreference,
} from "./appearance.ts";
import {
  DEPLOYMENT_THEME_ELEMENT_ID,
  DEPLOYMENT_THEME_PATH,
  applyDeploymentTheme,
  deploymentTokenCss,
  installDeploymentTheme,
  parseDeploymentTheme,
} from "./deployment.ts";
import {
  __resetPreferencesForTesting,
  getPreference,
  resetPreference,
  setPreference,
} from "./preferences.ts";
import { TOKEN_NAMES } from "./tokens.ts";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("the server's theme validation", () => {
  // The server validates the theme file against its own copy of these
  // lists, since its image is built without lucida-web.
  const rust = read("../lucida-server/src/deployment_theme.rs");
  const rustConst = (name: string): string => {
    const m = new RegExp(`const ${name}: [^=]+= ([^;]+);`).exec(rust);
    if (!m) throw new Error(`${name} not found in deployment_theme.rs`);
    return m[1];
  };
  const rustList = (name: string): string[] =>
    [...rustConst(name).matchAll(/"([^"]*)"/g)].map((m) => m[1]);

  it("knows the same tokens and preference values as the client", () => {
    expect(rustList("TOKEN_NAMES")).toEqual([...TOKEN_NAMES]);
    expect(rustList("THEME_OPTIONS")).toEqual([...THEME_OPTIONS]);
    expect(rustList("ACCENT_PRESETS")).toEqual([...ACCENT_PRESETS]);
    expect(rustList("DENSITIES")).toEqual([...DENSITIES]);
    expect(rustList("CANVAS_BACKGROUNDS")).toEqual([...CANVAS_BACKGROUNDS]);
  });

  it("refuses exactly the tokens a user setting decides", () => {
    // Tokens that tokens.css sets per accent, density, or canvas
    // background, or under a media query. A per-preset override of one
    // would beat the user's choice.
    const css = read("src/theme/tokens.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const decided = new Set<string>();
    const names = (text: string) => [...text.matchAll(/(--lc-[\w-]+)\s*:/g)].map((m) => m[1]);
    const rest = css.replace(/@media[^{]*\{([^{}]*\{[^{}]*\})*\s*\}/g, (block) => {
      for (const name of names(block)) decided.add(name);
      return "";
    });
    for (const [, selector, body] of rest.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/data-(accent|density|canvas)/.test(selector)) for (const name of names(body)) decided.add(name);
    }
    const refused = [...rustConst("PREFERENCE_TOKENS").matchAll(/\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(refused.sort()).toEqual([...decided].sort());
  });

  it("writes the element the client reads, at the marker in index.html", () => {
    expect(rustList("ELEMENT_ID")).toEqual([DEPLOYMENT_THEME_ELEMENT_ID]);
    expect(rustList("ROUTE_PATH")).toEqual([DEPLOYMENT_THEME_PATH]);
    const [marker] = rustList("INDEX_MARKER");
    const html = read("index.html");
    expect(html.split(marker)).toHaveLength(2);
    expect(html.indexOf(marker)).toBeLessThan(html.indexOf("<script>"));
  });
});

const body = (theme: object) => ({ configured: true, defaults: {}, tokens: { dark: {}, light: {} }, ...theme });

function cleanDocument(): void {
  document.getElementById(DEPLOYMENT_THEME_ELEMENT_ID)?.remove();
  document.getElementById("lucida-deployment-tokens")?.remove();
}

beforeEach(() => {
  localStorage.clear();
  cleanDocument();
  __resetPreferencesForTesting();
});

afterEach(() => {
  localStorage.clear();
  cleanDocument();
  vi.useRealTimers();
  __resetPreferencesForTesting();
});

describe("applyDeploymentTheme", () => {
  it("layers its defaults over the built-in ones and under the user's", () => {
    applyDeploymentTheme(parseDeploymentTheme(body({ defaults: { theme: "light", accent: "#0f8278" } })));
    expect(resolveAppearance()).toMatchObject({ theme: "light", accent: "#0f8278", density: "comfortable" });

    setPreference(themePreference, "dark");
    setPreference(accentPreference, "rose");
    expect(resolveAppearance()).toMatchObject({ theme: "dark", accent: "rose" });

    resetPreference(themePreference);
    expect(getPreference(themePreference)).toBe("light");
  });

  it("ignores a default its preference does not take", () => {
    applyDeploymentTheme(parseDeploymentTheme(body({ defaults: { theme: "sepia", density: "compact" } })));
    expect(resolveAppearance()).toMatchObject({ theme: "dark", density: "compact" });
  });

  it("outranks every rule in tokens.css", () => {
    // The overrides' `html:root[data-theme]` ranks (0,2,1). A tokens.css
    // selector of `:root`, one attribute, or both ranks at most (0,2,0).
    const css = read("src/theme/tokens.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)]
      .flatMap((m) => m[1].split(","))
      .map((s) => s.trim())
      .filter((s) => !s.startsWith("@"));
    expect(selectors.length).toBeGreaterThan(10);
    for (const selector of selectors) expect(selector).toMatch(/^(:root)?(\[data-[\w-]+="[\w-]+"\])?$/);
  });

  it("writes each override under its own preset only", () => {
    applyDeploymentTheme(parseDeploymentTheme(body({ tokens: { light: { "--lc-bg": "#fafafa" } } })));
    const css = document.getElementById("lucida-deployment-tokens")?.textContent;
    expect(css).toBe('html:root[data-theme="light"] {\n  --lc-bg: #fafafa;\n}\n');
    expect(css).not.toContain('data-theme="dark"');
  });

  it("removes the stylesheet when a later theme has no overrides", () => {
    applyDeploymentTheme(parseDeploymentTheme(body({ tokens: { dark: { "--lc-bg": "#000000" } } })));
    applyDeploymentTheme(parseDeploymentTheme(body({})));
    expect(document.getElementById("lucida-deployment-tokens")).toBeNull();
  });
});

describe("parseDeploymentTheme", () => {
  it("keeps only overrides that fit a declaration", () => {
    const theme = parseDeploymentTheme(
      body({ tokens: { dark: { "--lc-bg": "#111", "--lc-text": "red; color: blue", color: "red", "--lc-border": 3 } } }),
    );
    expect(theme.tokens.dark).toEqual({ "--lc-bg": "#111" });
    expect(deploymentTokenCss(theme.tokens)).toBe('html:root[data-theme="dark"] {\n  --lc-bg: #111;\n}\n');
  });

  it("reads anything else as no theme", () => {
    for (const raw of [null, "theme", [], { defaults: 3, tokens: "x" }]) {
      expect(deploymentTokenCss(parseDeploymentTheme(raw).tokens)).toBe("");
    }
  });
});

describe("installDeploymentTheme", () => {
  const respond = (json: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(json), { headers: { "content-type": "application/json" } }));

  it("uses the theme the server wrote into the page, without a fetch", async () => {
    const element = document.createElement("script");
    element.type = "application/json";
    element.id = DEPLOYMENT_THEME_ELEMENT_ID;
    element.textContent = JSON.stringify(body({ defaults: { theme: "light" } }));
    document.head.appendChild(element);
    const fetchImpl = respond(body({ defaults: { theme: "dark" } }));

    await installDeploymentTheme(fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getPreference(themePreference)).toBe("light");
  });

  it("fetches the theme when the page carries none", async () => {
    const fetchImpl = respond(body({ defaults: { theme: "light" } }));
    await installDeploymentTheme(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(DEPLOYMENT_THEME_PATH, expect.anything());
    expect(getPreference(themePreference)).toBe("light");
  });

  it("keeps the built-in defaults when nothing is configured", async () => {
    await installDeploymentTheme(respond({ configured: false, defaults: {}, tokens: { dark: {}, light: {} } }));
    expect(getPreference(themePreference)).toBe("dark");
    expect(document.getElementById("lucida-deployment-tokens")).toBeNull();
  });

  it("keeps the built-in defaults when the fetch fails", async () => {
    await installDeploymentTheme(vi.fn(async () => Promise.reject(new TypeError("offline"))));
    await installDeploymentTheme(vi.fn(async () => new Response("<!doctype html>")));
    await installDeploymentTheme(vi.fn(async () => new Response("", { status: 500 })));
    expect(getPreference(themePreference)).toBe("dark");
  });

  it("gives up on a slow fetch", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fetchImpl = vi.fn(
      (_: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const done = installDeploymentTheme(fetchImpl as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(aborted).toBe(true);
    expect(getPreference(themePreference)).toBe("dark");
  });
});
