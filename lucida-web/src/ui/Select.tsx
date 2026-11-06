import { CaretUpDownIcon, CheckIcon, type Icon } from "@phosphor-icons/react";
import {
  Button as AriaButton,
  ListBox,
  ListBoxItem,
  Popover as AriaPopover,
  Select as AriaSelect,
  SelectValue,
} from "react-aria-components";
import { FieldText } from "./Field.tsx";
import { fieldRootProps, type LabelPosition } from "./fieldProps.ts";
import "./Overlay.css";
import "./Select.css";

export interface SelectOption<V extends string> {
  value: V;
  label: string;
  icon?: Icon;
}

export interface SelectProps<V extends string> {
  label: string;
  /** Default `top`. */
  labelPosition?: LabelPosition;
  options: readonly SelectOption<V>[];
  value: V;
  onChange: (value: V) => void;
  description?: string;
  isDisabled?: boolean;
  className?: string;
}

/** Pick one of a list. For two to four short options, use SegmentedControl. */
export function Select<V extends string>({
  label,
  labelPosition = "top",
  options,
  value,
  onChange,
  description,
  isDisabled,
  className,
}: SelectProps<V>) {
  return (
    <AriaSelect
      {...fieldRootProps(label, labelPosition, className)}
      value={value}
      onChange={(key) => {
        if (key !== null) onChange(key as V);
      }}
      isDisabled={isDisabled}
    >
      <FieldText label={label} labelPosition={labelPosition} description={description} />
      <AriaButton className="lc-input-group lc-field-control lc-select-trigger">
        <SelectValue<SelectOption<V>> className="lc-select-value">
          {({ selectedItem }) => {
            const ItemIcon = selectedItem?.icon;
            return (
              <>
                {ItemIcon && <ItemIcon size={16} aria-hidden />}
                <span className="lc-select-text">{selectedItem?.label ?? ""}</span>
              </>
            );
          }}
        </SelectValue>
        <CaretUpDownIcon className="lc-select-caret" size={14} aria-hidden />
      </AriaButton>
      <AriaPopover className="lc-popover lc-select-popover" offset={4} data-lc-overlay="">
        <ListBox className="lc-menu" items={options.map((o) => ({ ...o, id: o.value }))}>
          {(option) => {
            const ItemIcon = option.icon;
            return (
              <ListBoxItem className="lc-menu-item" id={option.value} textValue={option.label}>
                {({ isSelected }) => (
                  <>
                    {ItemIcon && <ItemIcon className="lc-menu-item-icon" size={16} aria-hidden />}
                    <span className="lc-menu-item-label">{option.label}</span>
                    {isSelected && <CheckIcon className="lc-menu-item-check" size={14} aria-hidden />}
                  </>
                )}
              </ListBoxItem>
            );
          }}
        </ListBox>
      </AriaPopover>
    </AriaSelect>
  );
}
