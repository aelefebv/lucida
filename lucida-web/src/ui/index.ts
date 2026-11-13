// The UI primitives. Import from here; style only with --lc-* tokens. Icons
// come straight from @phosphor-icons/react and are passed as components, e.g.
// `icon={PlusIcon}`.
export { Avatar, type AvatarProps } from "./Avatar.tsx";
export { Badge, type BadgeProps, type BadgeTone } from "./Badge.tsx";
export {
  Button,
  IconButton,
  type ButtonProps,
  type ButtonVariant,
  type IconButtonProps,
} from "./Button.tsx";
export { Card, type CardProps } from "./Card.tsx";
export { Checkbox, type CheckboxProps } from "./Checkbox.tsx";
export { CommandPalette, type CommandPaletteProps } from "./CommandPalette.tsx";
export {
  listCommands,
  registerCommand,
  runCommand,
  searchCommands,
  useCommand,
  useCommandList,
  useCommands,
  type CommandInfo,
  type CommandOptions,
} from "./commands.ts";
export { Dialog, type DialogProps } from "./Dialog.tsx";
export { escapeTopLayer, hasEscapeLayer, pushEscapeLayer } from "./escape.ts";
export type { LabelPosition } from "./fieldProps.ts";
export { Kbd, type KbdProps } from "./Kbd.tsx";
export { KeyboardHelp } from "./KeyboardHelp.tsx";
export { showKeyboardHelp, useKeyboardHelp, type KeyboardHelpOverlay } from "./keyboardHelpState.ts";
export {
  ContextMenu,
  Menu,
  MenuItem,
  MenuSection,
  MenuSeparator,
  type ContextMenuProps,
  type MenuItemProps,
  type MenuProps,
  type MenuSectionProps,
} from "./Menu.tsx";
export { NumberField, type NumberFieldProps } from "./NumberField.tsx";
export { PanelHeader, type PanelHeaderProps } from "./PanelHeader.tsx";
export { Popover, type PopoverPlacement, type PopoverProps } from "./Popover.tsx";
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentOption,
} from "./SegmentedControl.tsx";
export { Select, type SelectOption, type SelectProps } from "./Select.tsx";
export {
  activateShortcutScope,
  formatKeyCombo,
  listShortcuts,
  registerShortcut,
  SHORTCUT_GROUPS,
  useShortcut,
  useShortcutList,
  useShortcutScope,
  type KeyCombo,
  type ShortcutGroup,
  type ShortcutInfo,
  type ShortcutOptions,
} from "./shortcuts.ts";
export { ShortcutSheet, type ShortcutSheetProps } from "./ShortcutSheet.tsx";
export { Slider, type SliderProps, type SliderValue } from "./Slider.tsx";
export { Switch, type SwitchProps } from "./Switch.tsx";
export {
  ComboboxField,
  SearchField,
  TextField,
  type ComboboxFieldProps,
  type SearchFieldProps,
  type TextFieldProps,
} from "./TextField.tsx";
// ToastRegion is left out: main.tsx loads it lazily, and a static re-export
// here would pull it into the main bundle.
export { dismissToast, toast, type ToastOptions, type ToastTone } from "./toastQueue.ts";
export { Toolbar, ToolbarSeparator, type ToolbarProps } from "./Toolbar.tsx";
export { Tooltip, type TooltipPlacement, type TooltipProps } from "./Tooltip.tsx";
export { UnstyledButton, type UnstyledButtonProps } from "./UnstyledButton.tsx";
