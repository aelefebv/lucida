import { useEffect, useRef } from "react";

const INPUT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Tracks which keys are pressed on a container element. Returns a stable Set,
 * updated in place, so RAF loops can read it without re-rendering.
 *
 * @param boundKeys Keys whose keydown is preventDefault'd.
 */
export function useKeyState(
  containerRef: React.RefObject<HTMLElement | null>,
  boundKeys: Set<string>,
): Set<string> {
  const pressedRef = useRef(new Set<string>());

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const pressed = pressedRef.current;

    function isInputFocused(): boolean {
      const active = document.activeElement;
      return active != null && INPUT_TAGS.has(active.tagName);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (isInputFocused()) return;
      // A held modifier makes it a browser or app shortcut (Ctrl+F, Alt+[),
      // whose default and listeners further up must still run.
      if (boundKeys.has(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
      }
      pressed.add(e.key);
    }

    function onKeyUp(e: KeyboardEvent) {
      if (isInputFocused()) return;
      pressed.delete(e.key);
    }

    function onBlur() {
      pressed.clear();
    }

    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("keyup", onKeyUp);
    el.addEventListener("blur", onBlur);

    return () => {
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("keyup", onKeyUp);
      el.removeEventListener("blur", onBlur);
      pressed.clear();
    };
  }, [containerRef, boundKeys]);

  // Returning the live Set is the contract: RAF loops read it each frame.
  // eslint-disable-next-line react-hooks/refs
  return pressedRef.current;
}
