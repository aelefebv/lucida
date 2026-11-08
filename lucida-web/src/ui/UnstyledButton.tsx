import type { ReactNode } from "react";
import { Pressable, type PressEvent } from "react-aria-components";

export interface UnstyledButtonProps {
  children?: ReactNode;
  onPress?: (event: PressEvent) => void;
  isDisabled?: boolean;
  /** Leave focus where it is, e.g. in the text field these are suggestions for. */
  preventFocusOnPress?: boolean;
  /** Its whole look: this primitive draws nothing. */
  className?: string;
  title?: string;
  "aria-label"?: string;
  "aria-current"?: "location" | "page" | "true";
  "aria-pressed"?: boolean;
  [data: `data-${string}`]: string | boolean | undefined;
}

/**
 * A button that brings no look of its own, for a row, crumb, chip, or cell its
 * surface styles. It presses like Button, from pointer, touch, and keyboard,
 * and can open a Menu or Popover. Prefer Button or IconButton.
 */
export function UnstyledButton({
  children,
  onPress,
  isDisabled,
  preventFocusOnPress,
  ...attributes
}: UnstyledButtonProps) {
  // A native button rather than React Aria's, which drops `title`.
  return (
    <Pressable onPress={onPress} isDisabled={isDisabled} preventFocusOnPress={preventFocusOnPress}>
      <button type="button" disabled={isDisabled} {...attributes}>
        {children}
      </button>
    </Pressable>
  );
}
