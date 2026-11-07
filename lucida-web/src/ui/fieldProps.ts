/**
 * Where a field's label goes: above the control, beside it (a settings row),
 * or nowhere visible, in which case it is still the accessible name.
 */
export type LabelPosition = "top" | "side" | "hidden";

/** Props every field root takes for its label. */
export function fieldRootProps(label: string, labelPosition: LabelPosition, className?: string) {
  return {
    className: className ? `lc-field ${className}` : "lc-field",
    "data-label-position": labelPosition,
    "aria-label": labelPosition === "hidden" ? label : undefined,
  };
}
