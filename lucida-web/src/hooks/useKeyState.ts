import { useEffect, useRef } from "react";

const INPUT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Tracks which keys are currently pressed on a container element.
 *
 * Returns a stable Set ref (updated in-place) suitable for reading in RAF loops
 * without causing React re-renders.
 *
 * @param containerRef Ref to the DOM element that should receive key events
 * @param boundKeys    Set of key values for which keydown should be preventDefault'd
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
      if (boundKeys.has(e.key)) {
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

  return pressedRef.current;
}
