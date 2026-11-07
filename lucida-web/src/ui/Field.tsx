import { Label, Text } from "react-aria-components";
import type { LabelPosition } from "./fieldProps.ts";
import "./Field.css";

/** A field primitive's visible label and its help or error line. */
export function FieldText({
  label,
  labelPosition,
  description,
  errorMessage,
}: {
  label: string;
  labelPosition: LabelPosition;
  description?: string;
  errorMessage?: string;
}) {
  return (
    <>
      {labelPosition !== "hidden" && <Label className="lc-field-label">{label}</Label>}
      {errorMessage ? (
        <Text slot="errorMessage" className="lc-field-help lc-field-error">
          {errorMessage}
        </Text>
      ) : (
        description && (
          <Text slot="description" className="lc-field-help">
            {description}
          </Text>
        )
      )}
    </>
  );
}
