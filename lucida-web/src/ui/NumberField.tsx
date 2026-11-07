import { MinusIcon, PlusIcon } from "@phosphor-icons/react";
import {
  Button as AriaButton,
  Group,
  Input,
  NumberField as AriaNumberField,
} from "react-aria-components";
import { FieldText } from "./Field.tsx";
import { fieldRootProps, type LabelPosition } from "./fieldProps.ts";

export interface NumberFieldProps {
  label: string;
  /** Default `top`. */
  labelPosition?: LabelPosition;
  value?: number;
  defaultValue?: number;
  /** Fires on Enter, blur, a stepper, or an arrow key; not per keystroke. */
  onChange?: (value: number) => void;
  minValue?: number;
  maxValue?: number;
  step?: number;
  /** e.g. `{ maximumFractionDigits: 2 }` or `{ style: "percent" }`. */
  formatOptions?: Intl.NumberFormatOptions;
  description?: string;
  errorMessage?: string;
  /** Hide the − and + buttons; arrow keys and scrolling still step. */
  hideSteppers?: boolean;
  isDisabled?: boolean;
  className?: string;
}

export function NumberField({
  label,
  labelPosition = "top",
  description,
  errorMessage,
  hideSteppers,
  onChange,
  className,
  ...rest
}: NumberFieldProps) {
  return (
    <AriaNumberField
      {...fieldRootProps(label, labelPosition, className)}
      {...rest}
      // A cleared field reports NaN; dropping it puts the last value back.
      onChange={(value) => {
        if (!Number.isNaN(value)) onChange?.(value);
      }}
      isInvalid={errorMessage ? true : undefined}
    >
      <FieldText
        label={label}
        labelPosition={labelPosition}
        description={description}
        errorMessage={errorMessage}
      />
      <Group className="lc-input-group lc-field-control lc-number-group">
        {!hideSteppers && (
          <AriaButton slot="decrement" className="lc-input-button lc-stepper-decrement">
            <MinusIcon size={12} aria-hidden />
          </AriaButton>
        )}
        <Input className="lc-input lc-number-input" />
        {!hideSteppers && (
          <AriaButton slot="increment" className="lc-input-button lc-stepper-increment">
            <PlusIcon size={12} aria-hidden />
          </AriaButton>
        )}
      </Group>
    </AriaNumberField>
  );
}
