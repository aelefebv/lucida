import {
  Input,
  Label,
  NumberField as AriaNumberField,
  Slider as AriaSlider,
  SliderOutput,
  SliderThumb,
  SliderTrack,
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
  formatOptions?: Intl.NumberFormatOptions;
  /**
   * `text` shows the value, `field` makes it editable, `none` hides it.
   * Default `text`.
   */
  valueDisplay?: "text" | "field" | "none";
  /** Accessible names of a range's two thumbs. Default Minimum and Maximum. */
  thumbLabels?: readonly [string, string];
  isDisabled?: boolean;
  className?: string;
}

function toArray(value: SliderValue): number[] {
  return typeof value === "number" ? [value] : [value[0], value[1]];
}

function fromArray<T extends SliderValue>(values: number[], like: T): T {
  return (typeof like === "number" ? values[0] : [values[0], values[1]]) as T;
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
}: SliderProps<T>) {
  const values = toArray(value);
  const isRange = values.length === 2;

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
          {valueDisplay === "text" && <SliderOutput className="lc-slider-output" />}
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
  return (
    <>
      {separator && <span className="lc-slider-separator">–</span>}
      <AriaNumberField
        className="lc-slider-field"
        aria-label={label}
        value={value}
        onChange={onCommit}
        minValue={minValue}
        maxValue={maxValue}
        step={step}
        formatOptions={formatOptions}
        isDisabled={isDisabled}
      >
        <Input className="lc-slider-field-input" />
      </AriaNumberField>
    </>
  );
}
