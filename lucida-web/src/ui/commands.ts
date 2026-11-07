import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  SHORTCUT_GROUPS,
  registerShortcut,
  useShortcut,
  type KeyCombo,
  type ShortcutGroup,
} from "./shortcuts.ts";

/**
 * The command registry behind the command palette. Feature code registers
 * what a person can do with `useCommand`; the palette lists and runs it.
 *
 * A command's `keys` register a shortcut under the same id, so the key, the
 * palette row, and the shortcut sheet can never disagree. The palette shows
 * whatever shortcut is registered under a command's id, which also picks up
 * a key bound with `useShortcut` by the code that owns it.
 */

export interface CommandOptions {
  /** Stable and unique, e.g. `view.zoomIn`. Also the id of the shortcut `keys` registers. */
  id: string;
  /** Says what running it does, e.g. "Zoom in". */
  label: string;
  group: ShortcutGroup;
  run: () => void;
  /** Keys that run it from anywhere in the viewer. */
  keys?: readonly KeyCombo[];
  /** More words the palette matches, e.g. `["dark mode"]`. */
  keywords?: readonly string[];
  /** With `keys`: run again on auto-repeat while held. Default false. */
  repeat?: boolean;
  /** Register only while true. Default true. */
  enabled?: boolean;
}

/** What the palette lists. */
export interface CommandInfo {
  readonly id: string;
  readonly label: string;
  readonly group: ShortcutGroup;
  readonly keywords: readonly string[];
}

interface Registration extends CommandInfo {
  readonly options: { current: CommandOptions };
}

const byId = new Map<string, Registration>();
const listeners = new Set<() => void>();
let snapshot: readonly CommandInfo[] = [];

function notify(): void {
  snapshot = [...byId.values()].map(({ id, label, group, keywords }) => ({ id, label, group, keywords }));
  for (const listener of [...listeners]) listener();
}

function register(options: { current: CommandOptions }): () => void {
  const { id, label, group, keywords = [] } = options.current;
  if (byId.has(id)) {
    const message = `Command id "${id}" is already registered`;
    if (import.meta.env.DEV) throw new Error(message);
    console.error(`[commands] ${message}; the later registration is ignored`);
    return () => {};
  }
  const registration: Registration = { id, label, group, keywords, options };
  byId.set(id, registration);
  notify();
  return () => {
    if (byId.get(id) !== registration) return;
    byId.delete(id);
    notify();
  };
}

/**
 * Register a command outside React, with its keys if it has any. Returns the
 * unregister function. Components use `useCommand`.
 */
export function registerCommand(options: CommandOptions): () => void {
  if (options.enabled === false) return () => {};
  const ref = { current: options };
  const unregisterCommand = register(ref);
  const unregisterShortcut = options.keys?.length
    ? registerShortcut({
        id: options.id,
        keys: options.keys,
        label: options.label,
        group: options.group,
        repeat: options.repeat,
        onTrigger: () => ref.current.run(),
      })
    : () => {};
  return () => {
    unregisterShortcut();
    unregisterCommand();
  };
}

/**
 * Offer a command while the component is mounted, and bind its keys. `run`
 * may change on every render without re-registering.
 */
export function useCommand(options: CommandOptions): void {
  const ref = useRef(options);
  useEffect(() => {
    ref.current = options;
  });
  const enabled = options.enabled ?? true;
  const keywordSignature = options.keywords?.join("\n") ?? "";
  useEffect(() => {
    if (!enabled) return;
    return register(ref);
    // Re-register only when what the palette lists changes.
  }, [enabled, options.id, options.label, options.group, keywordSignature]);

  useShortcut({
    id: options.id,
    keys: options.keys ?? [],
    label: options.label,
    group: options.group,
    repeat: options.repeat,
    onTrigger: () => ref.current.run(),
    enabled: enabled && (options.keys?.length ?? 0) > 0,
  });
}

/**
 * Offer a list of commands while mounted, such as one per option of a
 * setting. The list may grow, shrink, or relabel between renders; each `run`
 * is read when it runs.
 */
export function useCommands(commands: readonly CommandOptions[]): void {
  const ref = useRef(commands);
  useEffect(() => {
    ref.current = commands;
  });
  const enabled = commands.filter((c) => c.enabled ?? true);
  const signature = JSON.stringify(
    enabled.map(({ id, label, group, keys, keywords, repeat }) => [id, label, group, keys, keywords, repeat]),
  );
  useEffect(() => {
    const unregister = ref.current
      .filter((c) => c.enabled ?? true)
      .map((c) => registerCommand({ ...c, run: () => ref.current.find((latest) => latest.id === c.id)?.run() }));
    return () => {
      for (const off of unregister) off();
    };
  }, [signature]);
}

/** Run a registered command. Returns false when none has that id. */
export function runCommand(id: string): boolean {
  const registration = byId.get(id);
  if (!registration) return false;
  registration.options.current.run();
  return true;
}

/** Every registered command, in registration order. */
export function listCommands(): readonly CommandInfo[] {
  return snapshot;
}

/** `listCommands`, re-rendering as commands come and go. */
export function useCommandList(): readonly CommandInfo[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

// ---------------------------------------------------------------------------
// Search

function groupRank(command: CommandInfo): number {
  return SHORTCUT_GROUPS.indexOf(command.group);
}

/** How well one query word matches, or 0 when it doesn't. */
function wordScore(word: string, label: string, extras: string): number {
  const at = label.indexOf(word);
  if (at === 0) return 4;
  if (at > 0) return /[\s\-/(]/.test(label[at - 1]) ? 3 : 2;
  return extras.includes(word) ? 1 : 0;
}

/**
 * The commands that match every word of `query` anywhere in their label,
 * keywords, or group, best first: label prefixes, then word starts, then
 * anything else. An empty query lists every command by group.
 */
export function searchCommands(commands: readonly CommandInfo[], query: string): CommandInfo[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const byGroup = commands
    .map((command, order) => ({ command, order }))
    .sort((a, b) => groupRank(a.command) - groupRank(b.command) || a.order - b.order);
  if (words.length === 0) return byGroup.map(({ command }) => command);

  const whole = words.join(" ");
  const scored: { command: CommandInfo; score: number; order: number }[] = [];
  byGroup.forEach(({ command }, order) => {
    const label = command.label.toLowerCase();
    const extras = [...command.keywords, command.group].join(" ").toLowerCase();
    let score = label.startsWith(whole) ? 10 : 0;
    for (const word of words) {
      const s = wordScore(word, label, extras);
      if (s === 0) return;
      score += s;
    }
    scored.push({ command, score, order });
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map(({ command }) => command);
}

/** Clear every command. Tests only; shortcuts reset separately. */
export function __resetCommandsForTesting(): void {
  byId.clear();
  notify();
}
