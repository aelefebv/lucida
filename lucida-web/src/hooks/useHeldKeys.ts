import { useEffect, useRef } from "react";
import type { HeldAction, HeldBinding } from "../config/keyBindings.ts";
import { comboFromEvent, registerShortcut, type ShortcutGroup } from "../ui/shortcuts.ts";

export interface HeldKeysOptions {
  group: ShortcutGroup;
  /** The registry scope the keys bind in. Default global. */
  scope?: string;
  /** Bind only while true. */
  enabled: boolean;
}

/**
 * The actions whose keys are held down. Each binding registers as a
 * shortcut, so the registry decides whether a press counts (never while
 * typing, scope precedence); this adds the release, which the registry does
 * not see. A key's release, or the window losing focus, ends its action.
 *
 * Returns a stable Set, updated in place, so a frame loop reads it without
 * re-rendering.
 */
export function useHeldKeys(
  bindings: readonly HeldBinding[],
  { group, scope, enabled }: HeldKeysOptions,
): ReadonlySet<HeldAction> {
  const heldRef = useRef(new Set<HeldAction>());

  useEffect(() => {
    if (!enabled) return;
    const held = heldRef.current;
    // By physical key, so a release still matches after Shift changes what
    // the key types.
    const byCode = new Map<string, HeldAction>();

    const unregister = bindings.map((binding) =>
      registerShortcut({
        id: binding.id,
        keys: binding.keys.map(([combo]) => combo),
        label: binding.label,
        group,
        scope,
        onTrigger: (event) => {
          const combo = comboFromEvent(event);
          const action = binding.keys.find(([k]) => k === combo)?.[1];
          if (!action) return;
          byCode.set(event.code || event.key.toUpperCase(), action);
          held.add(action);
        },
      }),
    );

    const release = (event: KeyboardEvent) => {
      const code = event.code || event.key.toUpperCase();
      const action = byCode.get(code);
      if (!action) return;
      byCode.delete(code);
      if (![...byCode.values()].includes(action)) held.delete(action);
    };
    const releaseAll = () => {
      byCode.clear();
      held.clear();
    };
    window.addEventListener("keyup", release);
    window.addEventListener("blur", releaseAll);
    return () => {
      for (const off of unregister) off();
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", releaseAll);
      releaseAll();
    };
  }, [bindings, group, scope, enabled]);

  // Returning the live Set is the contract: frame loops read it each frame.
  // eslint-disable-next-line react-hooks/refs
  return heldRef.current;
}
