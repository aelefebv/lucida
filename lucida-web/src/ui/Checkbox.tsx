import { CheckIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Checkbox as AriaCheckbox } from "react-aria-components";
import "./Checkbox.css";

export interface CheckboxProps {
  /** The label; the whole row is the target. */
  children: ReactNode;
  isSelected: boolean;
  onChange: (isSelected: boolean) => void;
  isDisabled?: boolean;
  /** For layout only. */
  className?: string;
}

/** One of several independent on/off choices in a compact row. For a setting, use Switch. */
export function Checkbox({ children, isSelected, onChange, isDisabled, className }: CheckboxProps) {
  return (
    <AriaCheckbox
      className={className ? `lc-checkbox ${className}` : "lc-checkbox"}
      isSelected={isSelected}
      onChange={onChange}
      isDisabled={isDisabled}
    >
      <CheckBox isSelected={isSelected} />
      {children}
    </AriaCheckbox>
  );
}

/** The drawn box alone, for a control that carries the checked state itself, e.g. a menu item. */
export function CheckBox({ isSelected }: { isSelected: boolean }) {
  return (
    <span className="lc-checkbox-box" data-selected={isSelected || undefined} aria-hidden>
      <CheckIcon size={10} weight="bold" />
    </span>
  );
}
