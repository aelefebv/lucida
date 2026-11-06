// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyAppearance,
  installAppearance,
  resolveAppearance,
  themePreference,
  accentPreference,
} from "./appearance.ts";
import { DEPLOYMENT_THEME_ELEMENT_ID, installDeploymentTheme } from "./deployment.ts";
import {
  PREFERENCES_STORAGE_KEY,
  PREFERENCES_VERSION,
  __resetPreferencesForTesting,
  setPreference,
} from "./preferences.ts";

/** A matchMedia stand-in whose light-scheme answer the test controls. */
function stubColorScheme(light: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    matches: light,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  window.matchMedia = ((query: string) => {
    if (query !== "(prefers-color-scheme: light)") throw new Error(`unexpected query ${query}`);
    return media;
  }) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      media.matches = next;
      for (const fn of [...listeners]) fn();
    },
  };
}

const ATTRIBUTES = ["data-theme", "data-density", "data-accent", "data-canvas"];

function snapshot(el: HTMLElement): Record<string, string | null> {
  const out: Record<string, string | null> = { accentVar: el.style.getPropertyValue("--lc-accent") || null };
  for (const name of ATTRIBUTES) out[name] = el.getAttribute(name);
  return out;
}

const TOKEN_STYLE_ID = "lucida-deployment-tokens";

function tokenCss(): string | null {
  return document.getElementById(TOKEN_STYLE_ID)?.textContent ?? null;
}

function resetRoot(): void {
  const root = document.documentElement;
  for (const name of ATTRIBUTES) root.removeAttribute(name);
  root.removeAttribute("style");
  document.getElementById(DEPLOYMENT_THEME_ELEMENT_ID)?.remove();
  document.getElementById(TOKEN_STYLE_ID)?.remove();
}

const indexHtml = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const inlineScript = /<script>([\s\S]*?)<\/script>/.exec(indexHtml)?.[1] ?? "";

function runInlineScript(): void {
  new Function(inlineScript)();
}

beforeEach(() => {
  localStorage.clear();
  resetRoot();
});

afterEach(() => {
  localStorage.clear();
  resetRoot();
  window.history.replaceState({}, "", "/");
  __resetPreferencesForTesting();
});

describe("applyAppearance", () => {
  it("writes the attributes tokens.css keys on", () => {
    const el = document.createElement("div");
    applyAppearance(el, { theme: "light", accent: "teal", density: "compact", canvasBackground: "white" });
    expect(snapshot(el)).toEqual({
      "data-theme": "light",
      "data-density": "compact",
      "data-accent": "teal",
      "data-canvas": "white",
      accentVar: null,
    });
  });

  it("sets a custom accent inline and clears it for a preset", () => {
    const el = document.createElement("div");
    applyAppearance(el, { theme: "dark", accent: "#3a7bd5", density: "comfortable", canvasBackground: "black" });
    expect(el.dataset.accent).toBe("custom");
    expect(el.style.getPropertyValue("--lc-accent")).toBe("#3a7bd5");
    applyAppearance(el, { theme: "dark", accent: "rose", density: "comfortable", canvasBackground: "black" });
    expect(el.dataset.accent).toBe("rose");
    expect(el.style.getPropertyValue("--lc-accent")).toBe("");
  });
});

describe("the pre-paint script in index.html", () => {
  const lightDeployment = {
    configured: true,
    defaults: { theme: "light", accent: "#0f8278", density: "compact", canvasBackground: "white" },
    tokens: { dark: {}, light: {} },
  };
  const cases: {
    name: string;
    values?: unknown;
    raw?: string;
    light?: boolean;
    search?: string;
    /** The theme the server writes into the page, as JSON or raw text. */
    deployment?: unknown;
  }[] = [
    { name: "nothing stored" },
    {
      name: "every preference set",
      values: {
        "appearance.theme": "light",
        "appearance.accent": "amber",
        "appearance.density": "compact",
        "appearance.canvasBackground": "dark-gray",
      },
    },
    { name: "a custom accent", values: { "appearance.accent": "#12ab9f" } },
    { name: "System on a light OS", values: { "appearance.theme": "system" }, light: true },
    { name: "System on a dark OS", values: { "appearance.theme": "system" }, light: false },
    {
      name: "invalid values",
      values: {
        "appearance.theme": "sepia",
        "appearance.accent": "#12ab9",
        "appearance.density": 3,
        "appearance.canvasBackground": null,
      },
    },
    { name: "corrupt storage", raw: "{oops" },
    {
      name: "the capture surface",
      values: { "appearance.theme": "light", "appearance.canvasBackground": "white" },
      search: "?render=1",
    },
    { name: "deployment defaults", deployment: lightDeployment },
    {
      name: "deployment defaults under stored values",
      values: { "appearance.theme": "dark", "appearance.accent": "rose" },
      deployment: lightDeployment,
    },
    {
      name: "a deployment default under an invalid stored value",
      values: { "appearance.accent": "#12ab9", "appearance.canvasBackground": "red" },
      deployment: { ...lightDeployment, defaults: { accent: "teal", canvasBackground: "theme" } },
    },
    {
      name: "invalid deployment defaults",
      deployment: { ...lightDeployment, defaults: { theme: "sepia", accent: 7, density: null } },
    },
    {
      name: "a System deployment default on a light OS",
      deployment: { ...lightDeployment, defaults: { theme: "system" } },
      light: true,
    },
    {
      name: "deployment token overrides",
      deployment: {
        ...lightDeployment,
        tokens: {
          dark: { "--lc-bg": "#101014", "--lc-font": '"Inter", system-ui' },
          light: { "--lc-surface-1": "rgb(250 250 250)", "--lc-text": "red; color: blue", color: "red" },
        },
      },
    },
    {
      name: "a deployment on the capture surface",
      values: { "appearance.theme": "dark" },
      search: "?render=1",
      deployment: lightDeployment,
    },
    { name: "a corrupt deployment element", deployment: "{oops" },
  ];

  it.each(cases)("matches the TypeScript: $name", async ({ values, raw, light = false, search = "", deployment }) => {
    stubColorScheme(light);
    window.history.replaceState({}, "", `/${search}`);
    if (raw !== undefined) localStorage.setItem(PREFERENCES_STORAGE_KEY, raw);
    else if (values !== undefined) {
      localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({ version: PREFERENCES_VERSION, values }));
    }
    if (deployment !== undefined) {
      const element = document.createElement("script");
      element.type = "application/json";
      element.id = DEPLOYMENT_THEME_ELEMENT_ID;
      element.textContent = typeof deployment === "string" ? deployment : JSON.stringify(deployment);
      document.head.appendChild(element);
    }

    runInlineScript();
    const fromScript = snapshot(document.documentElement);
    const scriptCss = tokenCss();
    document.getElementById(TOKEN_STYLE_ID)?.remove();

    __resetPreferencesForTesting();
    await installDeploymentTheme(() => Promise.reject(new Error("the page carries the theme")));
    const el = document.createElement("div");
    applyAppearance(el, resolveAppearance());
    expect(fromScript).toEqual(snapshot(el));
    expect(scriptCss).toEqual(tokenCss());
  });
});

describe("installAppearance", () => {
  it("applies a preference change at once", () => {
    stubColorScheme(false);
    __resetPreferencesForTesting();
    const uninstall = installAppearance();
    try {
      expect(document.documentElement.dataset.theme).toBe("dark");
      setPreference(themePreference, "light");
      expect(document.documentElement.dataset.theme).toBe("light");
      setPreference(accentPreference, "#ff8800");
      expect(document.documentElement.style.getPropertyValue("--lc-accent")).toBe("#ff8800");
    } finally {
      uninstall();
    }
  });

  it("follows the OS setting live under System", () => {
    const scheme = stubColorScheme(false);
    __resetPreferencesForTesting();
    setPreference(themePreference, "system");
    const uninstall = installAppearance();
    try {
      expect(document.documentElement.dataset.theme).toBe("dark");
      scheme.set(true);
      expect(document.documentElement.dataset.theme).toBe("light");
      scheme.set(false);
      expect(document.documentElement.dataset.theme).toBe("dark");
    } finally {
      uninstall();
    }
  });

  it("ignores the OS setting under an explicit theme", () => {
    const scheme = stubColorScheme(false);
    __resetPreferencesForTesting();
    setPreference(themePreference, "dark");
    const uninstall = installAppearance();
    try {
      scheme.set(true);
      expect(document.documentElement.dataset.theme).toBe("dark");
    } finally {
      uninstall();
    }
  });
});
