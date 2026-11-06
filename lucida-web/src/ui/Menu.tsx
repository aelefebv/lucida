import type { Icon } from "@phosphor-icons/react";
import type { ReactElement, ReactNode } from "react";
import {
  Header,
  Keyboard,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuSection as AriaMenuSection,
  MenuTrigger,
  Popover as AriaPopover,
  Separator,
} from "react-aria-components";
import type { PopoverPlacement } from "./Popover.tsx";
import { formatKeyCombo, isApplePlatform, type KeyCombo } from "./shortcuts.ts";
import "./Overlay.css";

export interface MenuProps {
  /** The Button or IconButton that opens it. */
  trigger: ReactElement;
  /** MenuItem, MenuSection, and MenuSeparator. */
  children: ReactNode;
  /** Accessible name for the menu, when the trigger's text does not say it. */
  label?: string;
  placement?: PopoverPlacement;
}

/** A list of actions. Arrow keys move, Enter runs, Escape closes. */
export function Menu({ trigger, children, label, placement = "bottom start" }: MenuProps) {
  return (
    <MenuTrigger>
      {trigger}
      <AriaPopover className="lc-popover" placement={placement} offset={6} data-lc-overlay="">
        <AriaMenu className="lc-menu" aria-label={label}>
          {children}
        </AriaMenu>
      </AriaPopover>
    </MenuTrigger>
  );
}

export interface MenuItemProps {
  /** The item's text; also what type-to-select matches. */
  children: string;
  onAction: () => void;
  icon?: Icon;
  /** Shown at the right; pass the keys you registered with `useShortcut`. */
  shortcut?: KeyCombo;
  variant?: "default" | "danger";
  isDisabled?: boolean;
}

export function MenuItem({
  children,
  onAction,
  icon: ItemIcon,
  shortcut,
  variant = "default",
  isDisabled,
}: MenuItemProps) {
  return (
    <AriaMenuItem
      className="lc-menu-item"
      data-variant={variant}
      textValue={children}
      onAction={onAction}
      isDisabled={isDisabled}
    >
      {ItemIcon && <ItemIcon className="lc-menu-item-icon" size={16} aria-hidden />}
      <span className="lc-menu-item-label">{children}</span>
      {shortcut && (
        <Keyboard className="lc-menu-item-shortcut">
          {formatKeyCombo(shortcut).join(isApplePlatform() ? "" : "+")}
        </Keyboard>
      )}
    </AriaMenuItem>
  );
}

export interface MenuSectionProps {
  title?: string;
  children: ReactNode;
}

export function MenuSection({ title, children }: MenuSectionProps) {
  return (
    <AriaMenuSection className="lc-menu-section">
      {title && <Header className="lc-menu-section-title">{title}</Header>}
      {children}
    </AriaMenuSection>
  );
}

export function MenuSeparator() {
  return <Separator className="lc-menu-separator" />;
}
