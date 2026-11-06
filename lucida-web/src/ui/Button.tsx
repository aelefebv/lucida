import type { Icon } from "@phosphor-icons/react";
import { useEffect, useRef, type ReactNode } from "react";
import { Button as AriaButton, ToggleButton, type PressEvent } from "react-aria-components";
import { ariaKeyShortcut, type KeyCombo } from "./shortcuts.ts";
import { Tooltip, type TooltipPlacement } from "./Tooltip.tsx";
import "./Button.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps {
  children: ReactNode;
  /** Default `secondary`. One `primary` per view at most. */
  variant?: ButtonVariant;
  /** `md` is the control height; `sm` is one step down. Default `md`. */
  size?: "md" | "sm";
  /** A Phosphor icon component, e.g. `PlusIcon`, drawn before the label. */
  icon?: Icon;
  /** Drawn after the label, e.g. `CaretDownIcon` on a menu trigger. */
  trailingIcon?: Icon;
  onPress?: () => void;
  isDisabled?: boolean;
  type?: "button" | "submit";
  autoFocus?: boolean;
  /** For a disclosure: whether the region it shows and hides is open. */
  "aria-expanded"?: boolean;
  /** The id of the region a disclosure shows and hides. */
  "aria-controls"?: string;
  /** For layout only (margins, flex). Never restyle a primitive. */
  className?: string;
  "data-testid"?: string;
}

function cx(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

export function Button({
  children,
  variant = "secondary",
  size = "md",
  icon: LeadingIcon,
  trailingIcon: TrailingIcon,
  onPress,
  isDisabled,
  type = "button",
  autoFocus,
  className,
  ...attributes
}: ButtonProps) {
  return (
    <AriaButton
      {...attributes}
      className={cx("lc-button", className)}
      data-variant={variant}
      data-size={size}
      onPress={onPress}
      isDisabled={isDisabled}
      type={type}
      autoFocus={autoFocus}
    >
      {LeadingIcon && <LeadingIcon className="lc-button-icon" size={16} aria-hidden />}
      <span className="lc-button-label">{children}</span>
      {TrailingIcon && <TrailingIcon className="lc-button-icon" size={14} aria-hidden />}
    </AriaButton>
  );
}

interface IconButtonBase {
  icon: Icon;
  /** Names the action. It is the accessible name and the tooltip. */
  label: string;
  /** Shown in the tooltip; pass the keys you registered with `useShortcut`. */
  shortcut?: KeyCombo;
  tooltipPlacement?: TooltipPlacement;
  /** Default `ghost`. */
  variant?: "ghost" | "secondary";
  /** `lg` is for rails (20px icon). Default `md`. */
  size?: "sm" | "md" | "lg";
  isDisabled?: boolean;
  /** For a disclosure: whether the region it shows and hides is open. */
  "aria-expanded"?: boolean;
  /** The id of the region a disclosure shows and hides. */
  "aria-controls"?: string;
  className?: string;
  "data-testid"?: string;
}

interface ActionIconButtonProps extends IconButtonBase {
  /**
   * Omit when the button triggers a Menu, Popover, or Dialog. The event
   * carries the modifier keys, for an Alt-click variant.
   */
  onPress?: (event: PressEvent) => void;
  isSelected?: never;
  onSelectedChange?: never;
}

interface ToggleIconButtonProps extends IconButtonBase {
  /** Makes it a toggle (pressed or not), e.g. a tool or a panel. */
  isSelected: boolean;
  onSelectedChange: (isSelected: boolean) => void;
  onPress?: never;
}

export type IconButtonProps = ActionIconButtonProps | ToggleIconButtonProps;

/** An icon-only button. Always carries a tooltip naming it and its shortcut. */
export function IconButton(props: IconButtonProps) {
  const {
    icon: IconComponent,
    label,
    shortcut,
    tooltipPlacement = "top",
    variant = "ghost",
    size = "md",
    isDisabled,
    className,
    "data-testid": testId,
    "aria-expanded": ariaExpanded,
    "aria-controls": ariaControls,
  } = props;
  const ref = useRef<HTMLButtonElement>(null);
  const isToggle = props.isSelected !== undefined;
  // React Aria drops aria-keyshortcuts from the props it forwards.
  useEffect(() => {
    if (shortcut) ref.current?.setAttribute("aria-keyshortcuts", ariaKeyShortcut(shortcut));
    else ref.current?.removeAttribute("aria-keyshortcuts");
  }, [shortcut, isToggle]);
  const common = {
    ref,
    className: cx("lc-button", "lc-icon-button", className),
    "data-variant": variant,
    "data-size": size,
    "aria-label": label,
    "aria-expanded": ariaExpanded,
    "aria-controls": ariaControls,
    "data-testid": testId,
    isDisabled,
  };
  const glyph = <IconComponent size={size === "lg" ? 20 : 16} aria-hidden />;
  return (
    <Tooltip content={label} shortcut={shortcut} placement={tooltipPlacement}>
      {!isToggle ? (
        <AriaButton {...common} onPress={props.onPress}>
          {glyph}
        </AriaButton>
      ) : (
        <ToggleButton {...common} isSelected={props.isSelected} onChange={props.onSelectedChange}>
          {glyph}
        </ToggleButton>
      )}
    </Tooltip>
  );
}
