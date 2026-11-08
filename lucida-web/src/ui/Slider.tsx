import type { CSSProperties } from "react";
import {
  Input,
  Label,
  NumberField as AriaNumberField,
  Slider as AriaSlider,
  SliderOutput,
  SliderThumb,
  SliderTrack,
  useLocale,
} from "react-aria-components";
import "./Slider.css";

/** One value, or a `[low, high]` range with two thumbs. */
export type SliderValue = number | readonly [number, number];

export interface SliderProps<T extends SliderValue> {
  label: string;
  /** Default `top`, with the value at the right of the label. */
  labelPosition?: "top" | "hidden";
  value: T;
  /** Fires continuously while dragging. */
  onChange: (value: T) => void;
  /** Fires once when a drag or edit ends; commit expensive work here. */
  onChangeEnd?: (value: T) => void;
  minValue?: number;
  maxValue?: number;
  step?: number;
  /** Without these, a value shows every fraction digit it holds, and at least three. */
  formatOptions?: Intl.NumberFormatOptions;
  /**
   * `text` shows the value, `field` makes it editable, `none` hides it.
   * Default `text`. Either shows the value as given, though the thumb moves
   * in steps.
   */
  valueDisplay?: "text" | "field" | "none";
  /** Accessible names of a range's two thumbs. Default Minimum and Maximum. */
  thumbLabels?: readonly [string, string];
  isDisabled?: boolean;
  className?: string;
  /** Set on the slider, for tests and scripted drivers that find it by id. */
  "data-testid"?: string;
}

function toArray(value: SliderValue): number[] {
  return typeof value === "number" ? [value] : [value[0], value[1]];
}

function fromArray<T extends SliderValue>(values: number[], like: T): T {
  return (typeof like === "number" ? values[0] : [values[0], values[1]]) as T;
}

/**
 * How a value shows: with the caller's options, or else with every fraction
 * digit the value holds and at least the three a number format shows by
 * default. A stored value can sit off the slider's step, and React Aria would
 * round it to the step for display.
 */
function displayFormat(values: readonly number[], formatOptions?: Intl.NumberFormatOptions): Intl.NumberFormatOptions {
  if (formatOptions) return formatOptions;
  const digits = Math.max(3, ...values.map(fractionDigits));
  return { maximumFractionDigits: Math.min(digits, 20) };
}

/** The fraction digits the shortest text that reads back as `value` has. */
function fractionDigits(value: number): number {
  const [mantissa, exponent = "0"] = String(Math.abs(value)).split("e");
  return Math.max(0, (mantissa.split(".")[1]?.length ?? 0) - Number(exponent));
}

export function Slider<T extends SliderValue>({
  label,
  labelPosition = "top",
  value,
  onChange,
  onChangeEnd,
  minValue = 0,
  maxValue = 100,
  step = 1,
  formatOptions,
  valueDisplay = "text",
  thumbLabels = ["Minimum", "Maximum"],
  isDisabled,
  className,
  "data-testid": testId,
}: SliderProps<T>) {
  const { locale } = useLocale();
  const values = toArray(value);
  const isRange = values.length === 2;
  const outputFormat = new Intl.NumberFormat(locale, displayFormat(values, formatOptions));

  // An edited value keeps the range ordered: low never passes high.
  const commitField = (index: number, next: number) => {
    if (Number.isNaN(next)) return;
    const updated = [...values];
    updated[index] = Math.min(maxValue, Math.max(minValue, next));
    if (isRange) {
      if (index === 0) updated[0] = Math.min(updated[0], updated[1]);
      else updated[1] = Math.max(updated[1], updated[0]);
    }
    const result = fromArray(updated, value);
    onChange(result);
    onChangeEnd?.(result);
  };

  return (
    <AriaSlider<number[]>
      className={className ? `lc-slider ${className}` : "lc-slider"}
      data-testid={testId}
      aria-label={labelPosition === "hidden" ? label : undefined}
      value={values}
      onChange={(next) => onChange(fromArray(next, value))}
      onChangeEnd={onChangeEnd ? (next) => onChangeEnd(fromArray(next, value)) : undefined}
      minValue={minValue}
      maxValue={maxValue}
      step={step}
      formatOptions={formatOptions}
      isDisabled={isDisabled}
    >
      {(labelPosition !== "hidden" || valueDisplay !== "none") && (
        <div className="lc-slider-header">
          {labelPosition !== "hidden" && <Label className="lc-slider-label">{label}</Label>}
          {valueDisplay === "text" && (
            <SliderOutput className="lc-slider-output">
              {values.map((v) => outputFormat.format(v)).join("–")}
            </SliderOutput>
          )}
          {valueDisplay === "field" && (
            <span className="lc-slider-fields">
              {values.map((v, i) => (
                <SliderValueField
                  key={i}
                  label={isRange ? `${label} ${thumbLabels[i].toLowerCase()}` : label}
                  value={v}
                  minValue={minValue}
                  maxValue={maxValue}
                  step={step}
                  formatOptions={formatOptions}
                  isDisabled={isDisabled}
                  onCommit={(next) => commitField(i, next)}
                  separator={i === 1}
                />
              ))}
            </span>
          )}
        </div>
      )}
      <SliderTrack className="lc-slider-track">
        {({ state }) => {
          const start = isRange ? state.getThumbPercent(0) : 0;
          const end = state.getThumbPercent(isRange ? 1 : 0);
          return (
            <>
              <div className="lc-slider-rail" />
              <div
                className="lc-slider-fill"
                style={{ left: `${start * 100}%`, width: `${(end - start) * 100}%` }}
              />
              {values.map((_, i) => (
                <SliderThumb
                  key={i}
                  index={i}
                  className="lc-slider-thumb"
                  aria-label={isRange ? thumbLabels[i] : undefined}
                />
              ))}
            </>
          );
        }}
      </SliderTrack>
    </AriaSlider>
  );
}

function SliderValueField({
  label,
  value,
  minValue,
  maxValue,
  step,
  formatOptions,
  isDisabled,
  onCommit,
  separator,
}: {
  label: string;
  value: number;
  minValue: number;
  maxValue: number;
  step: number;
  formatOptions?: Intl.NumberFormatOptions;
  isDisabled?: boolean;
  onCommit: (value: number) => void;
  separator: boolean;
}) {
  const { locale } = useLocale();
  const format = displayFormat([value], formatOptions);
  // Wide enough for the whole value: an int64 limit runs to 20 characters.
  const chars = new Intl.NumberFormat(locale, format).format(value).length;
  return (
    <span className="lc-slider-field-group">
      {separator && <span className="lc-slider-separator">–</span>}
      <AriaNumberField
        className="lc-slider-field"
        aria-label={label}
        value={value}
        onChange={onCommit}
        minValue={minValue}
        maxValue={maxValue}
        step={step}
        formatOptions={format}
        isDisabled={isDisabled}
        // `snap` would show a stored value rounded to the step, and keep a typed
        // one from landing between steps. The slider clamps a commit itself, and
        // the field never shows an off-step value as invalid.
        commitBehavior="validate"
        validationBehavior="aria"
        isInvalid={false}
      >
        <Input className="lc-slider-field-input" style={{ "--lc-field-chars": chars } as CSSProperties} />
      </AriaNumberField>
    </span>
  );
}
