import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { isTypingTarget } from "../../ui/shortcuts.ts";
import { keyboardInset } from "./sheet.ts";

function subscribeVisualViewport(onChange: () => void): () => void {
  const visual = window.visualViewport;
  window.addEventListener("resize", onChange);
  visual?.addEventListener("resize", onChange);
  visual?.addEventListener("scroll", onChange);
  return () => {
    window.removeEventListener("resize", onChange);
    visual?.removeEventListener("resize", onChange);
    visual?.removeEventListener("scroll", onChange);
  };
}

const readKeyboardInset = () => keyboardInset(window.innerHeight, window.visualViewport);

/** The px of the layout viewport's bottom the on-screen keyboard covers, kept current. */
export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribeVisualViewport, readKeyboardInset, () => 0);
}

/** Whether focus is in a text field outside `ref`, such as a comment being typed on the canvas. */
export function useTypingOutside(ref: RefObject<HTMLElement | null>): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const update = () => {
      const active = document.activeElement;
      setTyping(isTypingTarget(active) && !(active instanceof Node && ref.current?.contains(active)));
    };
    // Focus has moved by the time focusin fires; on focusout it has not yet.
    const later = () => queueMicrotask(update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", later);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", later);
    };
  }, [ref]);
  return typing;
}
