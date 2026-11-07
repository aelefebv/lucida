import { useContext, useEffect, useRef, type ReactElement, type ReactNode, type RefObject } from "react";
import {
  Tooltip as AriaTooltip,
  TooltipContext,
  TooltipTrigger,
  TooltipTriggerStateContext,
} from "react-aria-components";
import { Kbd } from "./Kbd.tsx";
import { watchLongPress } from "./longPress.ts";
import { combosOf, type KeyCombo } from "./shortcuts.ts";
import "./Tooltip.css";

export type TooltipPlacement = "top" | "bottom" | "left" | "right";

export interface TooltipProps {
  /** Short text: what the control does. */
  content: ReactNode;
  /** Drawn as keycaps after the text; several combos for one action are drawn in turn. */
  shortcut?: KeyCombo | readonly KeyCombo[];
  placement?: TooltipPlacement;
  /**
   * A focusable primitive from this folder (Button, IconButton, ...). A plain
   * DOM element gets no tooltip.
   */
  children: ReactElement;
  isDisabled?: boolean;
}

/**
 * Shows on hover after a short delay, at once on keyboard focus, and on a
 * long press under touch, where nothing hovers.
 */
export function Tooltip({ content, shortcut, placement = "top", children, isDisabled }: TooltipProps) {
  return (
    <TooltipTrigger delay={600} closeDelay={0} isDisabled={isDisabled}>
      {children}
      {!isDisabled && <LongPressReveal />}
      <AriaTooltip className="lc-tooltip" placement={placement} offset={6}>
        <span>{content}</span>
        {combosOf(shortcut).map((combo) => (
          <Kbd key={combo} keys={combo} />
        ))}
      </AriaTooltip>
    </TooltipTrigger>
  );
}

/** Opens the enclosing trigger's tooltip on a long press of its trigger. */
function LongPressReveal() {
  const state = useContext(TooltipTriggerStateContext);
  const { triggerRef } = (useContext(TooltipContext) ?? {}) as { triggerRef?: RefObject<Element | null> };
  // The trigger state is a new object on every render; the listeners read the latest.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  useEffect(() => {
    const element = triggerRef?.current;
    if (!(element instanceof HTMLElement)) return;
    return watchLongPress(
      element,
      () => stateRef.current?.open(true),
      () => stateRef.current?.close(true),
    );
  }, [triggerRef]);
  return null;
}
