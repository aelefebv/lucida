import { useState } from "react";
import { Button } from "../ui/Button.tsx";
import { TextField } from "../ui/TextField.tsx";
import { checkSource } from "./sourceInput.ts";
import "./SourceField.css";

export interface SourceFieldProps {
  /** Receives the canonical URL of input that passed the check. */
  onSubmit: (url: string) => void;
  /** Default "Open". */
  submitLabel?: string;
  autoFocus?: boolean;
  isDisabled?: boolean;
  className?: string;
}

/**
 * A path or URL field with its submit button. Input that cannot open is
 * explained under the field and never submitted.
 */
export function SourceField({
  onSubmit,
  submitLabel = "Open",
  autoFocus,
  isDisabled,
  className,
}: SourceFieldProps) {
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const submit = () => {
    const check = checkSource(value);
    if (check.kind === "empty") return;
    if (check.kind === "rejected") {
      setMessage(check.message);
      return;
    }
    setMessage(null);
    setValue("");
    onSubmit(check.url);
  };

  return (
    <form
      className={className ? `lc-source-field ${className}` : "lc-source-field"}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextField
        label="Dataset path or URL"
        labelPosition="hidden"
        className="lc-source-field-input"
        value={value}
        onChange={(next) => {
          setValue(next);
          setMessage(null);
        }}
        placeholder="/data/sample.zarr or gs://bucket/sample.zarr"
        description="A path on the server, or a gs://, s3://, http://, or https:// URL."
        errorMessage={message ?? undefined}
        autoFocus={autoFocus}
        isDisabled={isDisabled}
      />
      <Button type="submit" variant="primary" isDisabled={isDisabled || !value.trim()}>
        {submitLabel}
      </Button>
    </form>
  );
}
