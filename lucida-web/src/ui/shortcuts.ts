import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * The one registry for keyboard shortcuts. A component binds a key with
 * `useShortcut`; one window listener dispatches. Keys never fire while focus
 * is in a text field, an editable element, or an open overlay (which handles
 * its own keys). A combo already taken in the same scope throws in
 * development, so two features can never silently share a key.
 */

type Letter =
  | "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L" | "M"
  | "N" | "O" | "P" | "Q" | "R" | "S" | "T" | "U" | "V" | "W" | "X" | "Y" | "Z";
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type NamedKey =
  | "Escape" | "Enter" | "Space" | "Tab" | "Backspace" | "Delete"
  | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
  | "PageUp" | "PageDown" | "Home" | "End"
  | "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7" | "F8" | "F9" | "F10" | "F11" | "F12";
/** Keys whose character already says whether Shift was held, so Shift is not written. */
type SymbolKey = "?" | "," | "." | "/" | "[" | "]" | "+" | "-" | "=" | ";" | "'" | "`" | "\\";

type Mods = "" | "Mod+" | "Alt+" | "Shift+" | "Mod+Alt+" | "Mod+Shift+" | "Alt+Shift+" | "Mod+Alt+Shift+";
type SymbolMods = "" | "Mod+" | "Alt+" | "Mod+Alt+";

/**
 * A key combination: modifiers in the order Mod, Alt, Shift, then one key.
 * `Mod` is ⌘ on Apple platforms and Ctrl elsewhere. Letters are written in
 * capitals and match either case; `Shift+A` is a separate combo from `A`.
 */
export type KeyCombo = `${Mods}${Letter | Digit | NamedKey}` | `${SymbolMods}${SymbolKey}`;

/** Headings of the shortcut sheet, in its order. */
export const SHORTCUT_GROUPS = [
  "General",
  "Panels",
  "View",
  "Dimensions",
  "Channels",
  "Tools",
  "Annotations",
  "Fly camera",
  "Appearance",
  "Developer",
] as const;
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number];

export interface ShortcutOptions {
  /** Stable and unique, e.g. `view.toggleMode`. */
  id: string;
  /** One combo, or several that do the same thing. */
  keys: KeyCombo | readonly KeyCombo[];
  /** Says what the key does, e.g. "Switch 2D and 3D". */
  label: string;
  group: ShortcutGroup;
  onTrigger: (event: KeyboardEvent) => void;
  /** Checked on each press; when false the key falls through as if unbound. */
  when?: () => boolean;
  /**
   * A scope's shortcuts take precedence over global ones while the scope is
   * active (`useShortcutScope`), and may reuse their keys. Default `global`.
   */
  scope?: string;
  /** Fire on auto-repeat while the key is held. Default false. */
  repeat?: boolean;
  /** Register only while true. Default true. */
  enabled?: boolean;
}

/** What the shortcut sheet lists. */
export interface ShortcutInfo {
  readonly id: string;
  readonly keys: readonly KeyCombo[];
  readonly label: string;
  readonly group: ShortcutGroup;
  readonly scope: string;
}

const GLOBAL = "global";

interface Registration extends ShortcutInfo {
  readonly options: { current: ShortcutOptions };
}

const byId = new Map<string, Registration>();
const byScope = new Map<string, Map<KeyCombo, Registration>>();
/** In activation order, the latest winning; each entry counts its activations. */
const activeScopes = new Map<string, number>();
const listListeners = new Set<() => void>();
let listSnapshot: readonly ShortcutInfo[] = [];

function notifyList(): void {
  listSnapshot = [...byId.values()].map(({ id, keys, label, group, scope }) => ({
    id,
    keys,
    label,
    group,
    scope,
  }));
  for (const listener of [...listListeners]) listener();
}

function reportConflict(message: string): void {
  if (import.meta.env.DEV) throw new Error(message);
  console.error(`[shortcuts] ${message}; the later registration is ignored`);
}

function register(options: { current: ShortcutOptions }): () => void {
  const { id, label, group } = options.current;
  const scope = options.current.scope ?? GLOBAL;
  const keys: readonly KeyCombo[] =
    typeof options.current.keys === "string" ? [options.current.keys] : options.current.keys;

  if (byId.has(id)) {
    reportConflict(`Shortcut id "${id}" is already registered`);
    return () => {};
  }
  const combos = byScope.get(scope) ?? new Map<KeyCombo, Registration>();
  for (const combo of keys) {
    const taken = combos.get(combo);
    if (taken) {
      reportConflict(`"${combo}" is already bound to "${taken.id}" in scope "${scope}"; cannot bind it to "${id}"`);
      return () => {};
    }
  }

  const registration: Registration = { id, keys, label, group, scope, options };
  byId.set(id, registration);
  for (const combo of keys) combos.set(combo, registration);
  byScope.set(scope, combos);
  syncListener();
  notifyList();

  return () => {
    if (byId.get(id) !== registration) return;
    byId.delete(id);
    for (const combo of keys) combos.delete(combo);
    if (combos.size === 0) byScope.delete(scope);
    syncListener();
    notifyList();
  };
}

/**
 * Register a shortcut outside React. Returns the unregister function.
 * Components use `useShortcut`.
 */
export function registerShortcut(options: ShortcutOptions): () => void {
  return register({ current: options });
}

/**
 * Bind a key while the component is mounted. The handler and condition may
 * change on every render without re-registering.
 */
export function useShortcut(options: ShortcutOptions): void {
  const ref = useRef(options);
  useEffect(() => {
    ref.current = options;
  });
  const enabled = options.enabled ?? true;
  const keySignature = typeof options.keys === "string" ? options.keys : options.keys.join(" ");
  useEffect(() => {
    if (!enabled) return;
    return register(ref);
    // Re-register only when what the registry indexes or lists changes.
  }, [enabled, options.id, keySignature, options.scope, options.label, options.group]);
}

/** Make a scope's shortcuts take precedence until the returned function runs. */
export function activateShortcutScope(scope: string): () => void {
  activeScopes.set(scope, (activeScopes.get(scope) ?? 0) + 1);
  return () => {
    const count = (activeScopes.get(scope) ?? 0) - 1;
    if (count > 0) activeScopes.set(scope, count);
    else activeScopes.delete(scope);
  };
}

/** Make a scope's shortcuts take precedence while `active`. */
export function useShortcutScope(scope: string, active: boolean): void {
  useEffect(() => (active ? activateShortcutScope(scope) : undefined), [scope, active]);
}

/** Every registered shortcut, in registration order. */
export function listShortcuts(): readonly ShortcutInfo[] {
  return listSnapshot;
}

/** `listShortcuts`, re-rendering as shortcuts come and go. */
export function useShortcutList(): readonly ShortcutInfo[] {
  return useSyncExternalStore(
    (listener) => {
      listListeners.add(listener);
      return () => listListeners.delete(listener);
    },
    () => listSnapshot,
  );
}

// ---------------------------------------------------------------------------
// Matching

export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const NAMED_KEYS = new Set<string>([
  "Escape", "Enter", "Tab", "Backspace", "Delete",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "PageUp", "PageDown", "Home", "End",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
]);
const SYMBOL_KEYS = new Set<string>(["?", ",", ".", "/", "[", "]", "+", "-", "=", ";", "'", "`", "\\"]);
const CODE_SYMBOLS: Readonly<Record<string, string>> = {
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Minus: "-",
  Equal: "=",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Backslash: "\\",
};

/**
 * The key part of a combo for an event, or null. `event.key` is used first so
 * letters follow the keyboard layout. When it is not a bindable key, as with
 * Option on macOS (Option+[ types “) or Shift on a digit, the physical key
 * from `event.code` stands in.
 */
function keyOf(event: KeyboardEvent, alt: boolean): { key: string; symbol: boolean } | null {
  const k = event.key;
  if (k === " " || k === "Spacebar") return { key: "Space", symbol: false };
  if (k === "Esc") return { key: "Escape", symbol: false };
  if (/^[a-z]$/i.test(k)) return { key: k.toUpperCase(), symbol: false };
  if (/^[0-9]$/.test(k)) return { key: k, symbol: false };
  if (NAMED_KEYS.has(k)) return { key: k, symbol: false };
  if (SYMBOL_KEYS.has(k) && !alt) return { key: k, symbol: true };
  const code = event.code;
  let m: RegExpExecArray | null;
  if ((m = /^Key([A-Z])$/.exec(code))) return { key: m[1], symbol: false };
  if ((m = /^(?:Digit|Numpad)([0-9])$/.exec(code))) return { key: m[1], symbol: false };
  if (code in CODE_SYMBOLS) return { key: CODE_SYMBOLS[code], symbol: true };
  return null;
}

/** The combo an event spells, or null when it cannot be bound. */
export function comboFromEvent(event: KeyboardEvent, apple = isApplePlatform()): KeyCombo | null {
  // AltGr reports as Ctrl+Alt on Windows; the character it typed is the key.
  const altGraph =
    !apple && event.ctrlKey && event.altKey && (event.getModifierState?.("AltGraph") ?? false);
  const alt = event.altKey && !altGraph;
  const key = keyOf(event, alt);
  if (!key) return null;
  // A modifier the combo grammar cannot write (Ctrl on Apple, the Windows
  // key elsewhere) means the press is not ours.
  if (apple ? event.ctrlKey : event.metaKey) return null;
  const mod = !altGraph && (apple ? event.metaKey : event.ctrlKey);
  let combo = "";
  if (mod) combo += "Mod+";
  if (alt) combo += "Alt+";
  if (event.shiftKey && !key.symbol) combo += "Shift+";
  return (combo + key.key) as KeyCombo;
}

const NON_TEXT_INPUTS = new Set([
  "checkbox", "radio", "range", "button", "submit", "reset", "color", "file", "image",
]);

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(target.type);
}

/** Attribute the overlay primitives put on their roots. */
export const OVERLAY_ATTRIBUTE = "data-lc-overlay";

function isInOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${OVERLAY_ATTRIBUTE}]`) !== null;
}

function find(combo: KeyCombo): Registration | null {
  const scopes = [...activeScopes.keys()].reverse();
  scopes.push(GLOBAL);
  for (const scope of scopes) {
    const registration = byScope.get(scope)?.get(combo);
    if (!registration) continue;
    const { when } = registration.options.current;
    if (!when || when()) return registration;
  }
  return null;
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing) return;
  if (isTypingTarget(event.target) || isInOverlay(event.target)) return;
  const combo = comboFromEvent(event);
  if (!combo) return;
  const registration = find(combo);
  if (!registration) return;
  event.preventDefault();
  if (event.repeat && !registration.options.current.repeat) return;
  registration.options.current.onTrigger(event);
}

let listening = false;

function syncListener(): void {
  if (typeof window === "undefined") return;
  const want = byId.size > 0;
  if (want === listening) return;
  listening = want;
  if (want) window.addEventListener("keydown", onKeyDown);
  else window.removeEventListener("keydown", onKeyDown);
}

// ---------------------------------------------------------------------------
// Display

const APPLE_MODIFIERS: Readonly<Record<string, string>> = { Mod: "⌘", Alt: "⌥", Shift: "⇧" };
const OTHER_MODIFIERS: Readonly<Record<string, string>> = { Mod: "Ctrl", Alt: "Alt", Shift: "Shift" };
const KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Backspace: "⌫",
  Delete: "Del",
  Enter: "↵",
};

function split(combo: KeyCombo): { mods: string[]; key: string } {
  const parts = combo.split("+");
  // A trailing "+" key splits into two empty strings.
  if (combo.endsWith("+")) return { mods: parts.slice(0, -2), key: "+" };
  return { mods: parts.slice(0, -1), key: parts[parts.length - 1] };
}

/** The keycaps to draw for a combo, in this platform's words. */
export function formatKeyCombo(combo: KeyCombo, apple = isApplePlatform()): string[] {
  const { mods, key } = split(combo);
  const names = apple ? APPLE_MODIFIERS : OTHER_MODIFIERS;
  return [...mods.map((m) => names[m]), KEY_LABELS[key] ?? key];
}

/** A `shortcut` prop or option as a list, empty when absent. */
export function combosOf(keys: KeyCombo | readonly KeyCombo[] | undefined): readonly KeyCombo[] {
  if (keys === undefined) return [];
  return typeof keys === "string" ? [keys] : keys;
}

/** The combo as an `aria-keyshortcuts` value. */
export function ariaKeyShortcut(combo: KeyCombo, apple = isApplePlatform()): string {
  const { mods, key } = split(combo);
  const names: Record<string, string> = { Mod: apple ? "Meta" : "Control", Alt: "Alt", Shift: "Shift" };
  return [...mods.map((m) => names[m]), key].join("+");
}

/** Clear every registration and scope. Tests only. */
export function __resetShortcutsForTesting(): void {
  byId.clear();
  byScope.clear();
  activeScopes.clear();
  syncListener();
  notifyList();
}
