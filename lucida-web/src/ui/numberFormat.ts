/**
 * How a value shows: with the caller's options, or else with every fraction
 * digit the value holds and at least the three a number format shows by
 * default. A stored value can sit off a control's step, and React Aria would
 * round it to the step for display.
 */
export function displayFormat(values: readonly number[], formatOptions?: Intl.NumberFormatOptions): Intl.NumberFormatOptions {
  if (formatOptions) return formatOptions;
  const digits = Math.max(3, ...values.map(fractionDigits));
  return { maximumFractionDigits: Math.min(digits, 20) };
}

/** The fraction digits the shortest text that reads back as `value` has. */
function fractionDigits(value: number): number {
  const [mantissa, exponent = "0"] = String(Math.abs(value)).split("e");
  return Math.max(0, (mantissa.split(".")[1]?.length ?? 0) - Number(exponent));
}
