import {
  accentPreference,
  canvasBackgroundPreference,
  densityPreference,
  themePreference,
  type ResolvedTheme,
} from "./appearance.ts";
import { setPreferenceDefaults } from "./preferences.ts";

/**
 * A deployment's theme (ADR 0066): defaults for the appearance preferences
 * and token overrides per preset, from the file the server's
 * `LUCIDA_THEME_FILE` names. It layers over the built-in defaults and under
 * the user's saved preferences.
 *
 * The server writes it into `index.html`, where the pre-paint script reads
 * it, so a first visit opens in the deployment's theme. The fetch is for a
 * page the server did not serve, such as the Vite dev server's.
 */

export const DEPLOYMENT_THEME_PATH = "/api/theme";
/** The data element the server writes in place of the marker in index.html. */
export const DEPLOYMENT_THEME_ELEMENT_ID = "lucida-deployment-theme";
const STYLE_ELEMENT_ID = "lucida-deployment-tokens";
/** Past this the page keeps the built-in theme rather than switch mid-use. */
const FETCH_TIMEOUT_MS = 3000;

const PRESETS: readonly ResolvedTheme[] = ["dark", "light"];

export interface DeploymentTheme {
  /** Raw values; each preference's parser rejects what it does not take. */
  readonly defaults: Readonly<Record<"theme" | "accent" | "density" | "canvasBackground", unknown>>;
  readonly tokens: Readonly<Record<ResolvedTheme, Readonly<Record<string, string>>>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the route's body. The server validated it at startup; this keeps
 * only what can go into a stylesheet as written, as the pre-paint script
 * does.
 */
export function parseDeploymentTheme(raw: unknown): DeploymentTheme {
  const body = isRecord(raw) ? raw : {};
  const defaults = isRecord(body.defaults) ? body.defaults : {};
  const tokens = isRecord(body.tokens) ? body.tokens : {};
  const presetTokens = (preset: ResolvedTheme): Record<string, string> => {
    const source = isRecord(tokens[preset]) ? tokens[preset] : {};
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(source)) {
      if (/^--lc-[\w-]+$/.test(name) && typeof value === "string" && !/[;{}<]/.test(value)) {
        out[name] = value;
      }
    }
    return out;
  };
  return {
    defaults: {
      theme: defaults.theme,
      accent: defaults.accent,
      density: defaults.density,
      canvasBackground: defaults.canvasBackground,
    },
    tokens: { dark: presetTokens("dark"), light: presetTokens("light") },
  };
}

/**
 * The overrides as a stylesheet. `html:root` outranks every selector in
 * tokens.css whichever loads first; the pre-paint script inserts this
 * before the bundle's stylesheet, and the dev server inserts tokens.css
 * after it.
 */
export function deploymentTokenCss(tokens: DeploymentTheme["tokens"]): string {
  let css = "";
  for (const preset of PRESETS) {
    const body = Object.entries(tokens[preset])
      .map(([name, value]) => `  ${name}: ${value};\n`)
      .join("");
    if (body) css += `html:root[data-theme="${preset}"] {\n${body}}\n`;
  }
  return css;
}

/** Layer the theme under the user's preferences and apply its overrides. */
export function applyDeploymentTheme(theme: DeploymentTheme): void {
  const defaults: Record<string, unknown> = {};
  const keys = [
    [themePreference.key, theme.defaults.theme],
    [accentPreference.key, theme.defaults.accent],
    [densityPreference.key, theme.defaults.density],
    [canvasBackgroundPreference.key, theme.defaults.canvasBackground],
  ] as const;
  for (const [key, value] of keys) if (value !== undefined) defaults[key] = value;
  setPreferenceDefaults(defaults);

  const css = deploymentTokenCss(theme.tokens);
  let style = document.getElementById(STYLE_ELEMENT_ID);
  if (!css) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

/** The theme the server wrote into the page, or undefined if it wrote none. */
function readInjected(): DeploymentTheme | undefined {
  const element = document.getElementById(DEPLOYMENT_THEME_ELEMENT_ID);
  if (!element) return undefined;
  try {
    return parseDeploymentTheme(JSON.parse(element.textContent ?? ""));
  } catch {
    return parseDeploymentTheme(null);
  }
}

/**
 * Apply the deployment's theme. Call once at startup, before
 * `installAppearance`. Never throws and never blocks: a failed or slow
 * fetch leaves the built-in defaults in place.
 */
export async function installDeploymentTheme(fetchImpl: typeof fetch = fetch): Promise<void> {
  const injected = readInjected();
  if (injected) {
    applyDeploymentTheme(injected);
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(DEPLOYMENT_THEME_PATH, { signal: controller.signal });
    if (!response.ok) return;
    const body: unknown = await response.json();
    if (isRecord(body) && body.configured === true) applyDeploymentTheme(parseDeploymentTheme(body));
  } catch {
    // Offline, timed out, or a server too old for the route, whose SPA
    // fallback answers with HTML: the built-in defaults stand.
  } finally {
    clearTimeout(timer);
  }
}
