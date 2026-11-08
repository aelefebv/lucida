import type { Icon } from "@phosphor-icons/react";
import { useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Header,
  Keyboard,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuSection as AriaMenuSection,
  MenuTrigger,
  Popover as AriaPopover,
  Separator,
  Text,
} from "react-aria-components";
import { CheckBox } from "./Checkbox.tsx";
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
  /** On the popover, for layout only, e.g. a fixed width. */
  className?: string;
}

/** A list of actions. Arrow keys move, Enter runs, Escape closes. */
export function Menu({ trigger, children, label, placement = "bottom start", className }: MenuProps) {
  return (
    <MenuTrigger>
      {trigger}
      <AriaPopover
        className={className ? `lc-popover ${className}` : "lc-popover"}
        placement={placement}
        offset={6}
        data-lc-overlay=""
      >
        <AriaMenu className="lc-menu" aria-label={label}>
          {children}
        </AriaMenu>
      </AriaPopover>
    </MenuTrigger>
  );
}

export interface ContextMenuProps {
  /** The client point to open at, or null while closed. */
  at: { x: number; y: number } | null;
  onClose: () => void;
  /** Accessible name for the menu. */
  label: string;
  /** MenuItem, MenuSection, and MenuSeparator. */
  children: ReactNode;
}

/**
 * A menu opened at a point, by a right-click or a long press, rather than by
 * a trigger. It flips and shifts to stay on screen. Escape, a click outside,
 * or running an item closes it.
 */
export function ContextMenu({ at, onClose, label, children }: ContextMenuProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  // The point outlives `at` so the menu stays put while it animates closed.
  const [point, setPoint] = useState(at);
  if (at && (at.x !== point?.x || at.y !== point?.y)) setPoint(at);
  return createPortal(
    <>
      <div
        ref={anchorRef}
        className="lc-context-anchor"
        style={{ left: point?.x ?? 0, top: point?.y ?? 0 }}
        aria-hidden="true"
      />
      <AriaPopover
        triggerRef={anchorRef}
        isOpen={at !== null}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        placement="bottom start"
        offset={2}
        className="lc-popover"
        data-lc-overlay=""
      >
        <AriaMenu className="lc-menu" aria-label={label} autoFocus onClose={onClose}>
          {children}
        </AriaMenu>
      </AriaPopover>
    </>,
    document.body,
  );
}

export interface MenuItemProps {
  /** The item's text; also what type-to-select matches. */
  children: string;
  /** A second line under the text. */
  description?: string;
  /** Names the item in a checkable MenuSection's `selectedKeys`. */
  id?: string;
  /** Optional only on a checkable item, which pressing toggles. */
  onAction?: () => void;
  icon?: Icon;
  /** Shown at the right; pass the keys you registered with `useShortcut`. */
  shortcut?: KeyCombo;
  variant?: "default" | "danger";
  isDisabled?: boolean;
}

export function MenuItem({
  children,
  description,
  id,
  onAction,
  icon: ItemIcon,
  shortcut,
  variant = "default",
  isDisabled,
}: MenuItemProps) {
  return (
    <AriaMenuItem
      id={id}
      className="lc-menu-item"
      data-variant={variant}
      textValue={children}
      onAction={onAction}
      isDisabled={isDisabled}
    >
      {({ isSelected, selectionMode }) => (
        <>
          {selectionMode === "multiple" && <CheckBox isSelected={isSelected} />}
          {ItemIcon && <ItemIcon className="lc-menu-item-icon" size={16} aria-hidden />}
          {description ? (
            <span className="lc-menu-item-text">
              <Text slot="label" className="lc-menu-item-label">
                {children}
              </Text>
              <Text slot="description" className="lc-menu-item-description">
                {description}
              </Text>
            </span>
          ) : (
            <span className="lc-menu-item-label">{children}</span>
          )}
          {shortcut && (
            <Keyboard className="lc-menu-item-shortcut">
              {formatKeyCombo(shortcut).join(isApplePlatform() ? "" : "+")}
            </Keyboard>
          )}
        </>
      )}
    </AriaMenuItem>
  );
}

export interface MenuSectionProps {
  title?: string;
  /** A richer heading than `title`, e.g. who is signed in. It names the section. */
  header?: ReactNode;
  /** Makes the section's items checkable, each by its `id`. Checking one leaves the menu open. */
  selectionMode?: "multiple";
  selectedKeys?: Iterable<string>;
  onSelectionChange?: (keys: "all" | Set<string>) => void;
  children: ReactNode;
}

export function MenuSection({
  title,
  header,
  selectionMode,
  selectedKeys,
  onSelectionChange,
  children,
}: MenuSectionProps) {
  return (
    <AriaMenuSection
      className="lc-menu-section"
      selectionMode={selectionMode}
      selectedKeys={selectedKeys}
      onSelectionChange={
        onSelectionChange &&
        ((keys) => onSelectionChange(keys === "all" ? "all" : new Set([...keys].map(String))))
      }
    >
      {header ? (
        <Header className="lc-menu-section-header">{header}</Header>
      ) : (
        title && <Header className="lc-menu-section-title">{title}</Header>
      )}
      {children}
    </AriaMenuSection>
  );
}

export function MenuSeparator() {
  return <Separator className="lc-menu-separator" />;
}
