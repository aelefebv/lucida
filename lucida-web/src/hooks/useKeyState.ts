import { useEffect, useState } from "react";

const INPUT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export interface KeyState {
  readonly pressed: ReadonlySet<string>;
  subscribe(listener: () => void): () => void;
}

class ObservableKeyState implements KeyState {
  readonly pressed = new Set<string>();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  press(key: string): void {
    if (this.pressed.has(key)) return;
    this.pressed.add(key);
    this.publish();
  }

  release(key: string): void {
    if (!this.pressed.delete(key)) return;
    this.publish();
  }

  clear(): void {
    if (this.pressed.size === 0) return;
    this.pressed.clear();
    this.publish();
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * Tracks keys on a container without forcing React re-renders.
 *
 * The returned signal is stable. Consumers subscribe to actual state changes,
 * so continuous input may request frames while a held key is active and idle
 * input owns no polling callback.
 *
 * @param containerRef Ref to the DOM element that should receive key events
 * @param boundKeys    Set of key values for which keydown should be preventDefault'd
 */
export function useKeyState(
  containerRef: React.RefObject<HTMLElement | null>,
  boundKeys: Set<string>,
): KeyState {
  const [state] = useState(() => new ObservableKeyState());

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function isInputFocused(): boolean {
      const active = document.activeElement;
      return active != null && INPUT_TAGS.has(active.tagName);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (isInputFocused()) return;
      if (boundKeys.has(e.key)) {
        e.preventDefault();
      }
      state.press(e.key);
    }

    function onKeyUp(e: KeyboardEvent) {
      if (isInputFocused()) return;
      state.release(e.key);
    }

    function onBlur() {
      state.clear();
    }

    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("keyup", onKeyUp);
    el.addEventListener("blur", onBlur);

    return () => {
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("keyup", onKeyUp);
      el.removeEventListener("blur", onBlur);
      state.clear();
    };
  }, [containerRef, boundKeys, state]);

  return state;
}
