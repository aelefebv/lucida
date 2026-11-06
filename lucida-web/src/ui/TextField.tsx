import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import type { FocusEvent, KeyboardEvent, Ref } from "react";
import {
  Button as AriaButton,
  Group,
  Input,
  SearchField as AriaSearchField,
  TextField as AriaTextField,
} from "react-aria-components";
import { FieldText } from "./Field.tsx";
import { fieldRootProps, type LabelPosition } from "./fieldProps.ts";

export interface TextFieldProps {
  label: string;
  /** Default `top`. */
  labelPosition?: LabelPosition;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  description?: string;
  /** Shown in place of the description, and marks the field invalid. */
  errorMessage?: string;
  type?: "text" | "email" | "url" | "password";
  maxLength?: number;
  isDisabled?: boolean;
  isReadOnly?: boolean;
  isRequired?: boolean;
  autoFocus?: boolean;
  onKeyDown?: (event: KeyboardEvent) => void;
  onBlur?: (event: FocusEvent) => void;
  className?: string;
  /** The input element, for a caller that moves focus back to it. */
  inputRef?: Ref<HTMLInputElement>;
  /** Set on the input, for tests and scripted drivers that find it by id. */
  "data-testid"?: string;
}

export function TextField({
  label,
  labelPosition = "top",
  description,
  errorMessage,
  placeholder,
  className,
  inputRef,
  "data-testid": testId,
  ...rest
}: TextFieldProps) {
  return (
    <AriaTextField
      {...fieldRootProps(label, labelPosition, className)}
      {...rest}
      isInvalid={errorMessage ? true : undefined}
    >
      <FieldText
        label={label}
        labelPosition={labelPosition}
        description={description}
        errorMessage={errorMessage}
      />
      <Group className="lc-input-group lc-field-control">
        <Input ref={inputRef} className="lc-input" placeholder={placeholder} data-testid={testId} />
      </Group>
    </AriaTextField>
  );
}

export interface SearchFieldProps {
  label: string;
  /** Default `hidden`: the icon and placeholder say what it is. */
  labelPosition?: LabelPosition;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** Enter pressed. */
  onSubmit?: (value: string) => void;
  placeholder?: string;
  isDisabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}

/** A text field with a search icon and a clear button. Escape clears it. */
export function SearchField({
  label,
  labelPosition = "hidden",
  placeholder = "Search",
  className,
  ...rest
}: SearchFieldProps) {
  return (
    <AriaSearchField {...fieldRootProps(label, labelPosition, className)} {...rest}>
      {({ isEmpty }) => (
        <>
          <FieldText label={label} labelPosition={labelPosition} />
          <Group className="lc-input-group lc-field-control">
            <MagnifyingGlassIcon className="lc-input-adornment" size={14} aria-hidden />
            <Input className="lc-input lc-search-input" placeholder={placeholder} />
            {!isEmpty && (
              <AriaButton className="lc-input-button" aria-label="Clear">
                <XIcon size={12} aria-hidden />
              </AriaButton>
            )}
          </Group>
        </>
      )}
    </AriaSearchField>
  );
}
