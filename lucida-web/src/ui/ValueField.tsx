import type { CSSProperties } from "react";
import { Input, NumberField as AriaNumberField, useLocale } from "react-aria-components";
import { displayFormat } from "./numberFormat.ts";
import "./ValueField.css";

export interface ValueFieldProps {
  /** The field's accessible name; it shows no label of its own. */
  label: string;
  value: number;
  /** Fires on Enter or blur with the value as typed. A cleared field fires nothing. */
  onCommit: (value: number) => void;
  /** Bounds for its arrow keys; a typed value is the owner's to clamp. */
  minValue?: number;
  maxValue?: number;
  step?: number;
  /** Without these, the value shows every fraction digit it holds, and at least three. */
  formatOptions?: Intl.NumberFormatOptions;
  isDisabled?: boolean;
}

/** A compact number field that shows its value whole and sizes itself to it. */
export function ValueField({
  label,
  value,
  onCommit,
  minValue,
  maxValue,
  step,
  formatOptions,
  isDisabled,
}: ValueFieldProps) {
  const { locale } = useLocale();
  const format = displayFormat([value], formatOptions);
  // Wide enough for the whole value: an int64 limit runs to 20 characters.
  const chars = new Intl.NumberFormat(locale, format).format(value).length;
  return (
    <AriaNumberField
      className="lc-value-field"
      aria-label={label}
      value={value}
      onChange={(next) => {
        if (!Number.isNaN(next)) onCommit(next);
      }}
      minValue={minValue}
      maxValue={maxValue}
      step={step}
      formatOptions={format}
      isDisabled={isDisabled}
      // `snap` would show a stored value rounded to the step, and keep a typed
      // one from landing between steps. The owner clamps a commit itself, and
      // the field never shows an off-step value as invalid.
      commitBehavior="validate"
      validationBehavior="aria"
      isInvalid={false}
    >
      <Input className="lc-value-field-input" style={{ "--lc-field-chars": chars } as CSSProperties} />
    </AriaNumberField>
  );
}
