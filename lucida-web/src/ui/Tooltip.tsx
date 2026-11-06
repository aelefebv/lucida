import type { ReactElement, ReactNode } from "react";
import { Tooltip as AriaTooltip, TooltipTrigger } from "react-aria-components";
import { Kbd } from "./Kbd.tsx";
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

/** Shows on hover after a short delay and at once on keyboard focus. */
export function Tooltip({ content, shortcut, placement = "top", children, isDisabled }: TooltipProps) {
  return (
    <TooltipTrigger delay={600} closeDelay={0} isDisabled={isDisabled}>
      {children}
      <AriaTooltip className="lc-tooltip" placement={placement} offset={6}>
        <span>{content}</span>
        {combosOf(shortcut).map((combo) => (
          <Kbd key={combo} keys={combo} />
        ))}
      </AriaTooltip>
    </TooltipTrigger>
  );
}
