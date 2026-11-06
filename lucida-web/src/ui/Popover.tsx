import type { ReactElement, ReactNode } from "react";
import { Dialog, DialogTrigger, Popover as AriaPopover } from "react-aria-components";
import "./Overlay.css";

export type PopoverPlacement =
  | "bottom"
  | "bottom start"
  | "bottom end"
  | "top"
  | "top start"
  | "top end"
  | "left"
  | "right";

export interface PopoverProps {
  /** The Button or IconButton that opens it. */
  trigger: ReactElement;
  /** Content, or a function of `close` for content that closes itself. */
  children: ReactNode | ((close: () => void) => ReactNode);
  /** Accessible name for the popover. */
  label: string;
  placement?: PopoverPlacement;
  /** Controlled open state; omit to let the trigger own it. */
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  className?: string;
}

/**
 * Non-modal content anchored to its trigger. Escape or a click outside
 * closes it, and focus returns to the trigger.
 */
export function Popover({
  trigger,
  children,
  label,
  placement = "bottom start",
  isOpen,
  onOpenChange,
  className,
}: PopoverProps) {
  return (
    <DialogTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
      {trigger}
      <AriaPopover
        className={className ? `lc-popover ${className}` : "lc-popover"}
        placement={placement}
        offset={6}
        data-lc-overlay=""
      >
        <Dialog className="lc-popover-dialog" aria-label={label}>
          {({ close }) => (typeof children === "function" ? children(close) : children)}
        </Dialog>
      </AriaPopover>
    </DialogTrigger>
  );
}
