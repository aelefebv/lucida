import type { ReactNode } from "react";
import { ArrowsOutLineHorizontalIcon, MagicWandIcon } from "@phosphor-icons/react";
import { Button, IconButton, Slider, Switch, Tooltip } from "../ui/index.ts";
import { contrastBounds, orderLimits } from "./contrastLimits.ts";
import { shortestFloat32Text } from "./pixelReadout.ts";
import "./ContrastControls.css";

const GAMMA_MIN = 0.1;
const GAMMA_MAX = 5;

interface Props {
  /** Names the group for assistive tech, e.g. the channel's name. */
  label: string;
  contrastMin: number;
  contrastMax: number;
  gamma: number;
  /** The range the loaded data spans, or `null` before any has loaded. */
  dataRange: { min: number; max: number } | null;
  /** Every value the data type holds, or `null` for a float type. */
  valueRange: readonly [number, number] | null;
  /** Whole-number data steps by 1; other data by a thousandth of the span. */
  integer: boolean;
  /** Span the slider over the data type's whole range instead of the loaded data's. */
  fullRange: boolean;
  onFullRangeChange: (fullRange: boolean) => void;
  onContrastChange: (min: number, max: number) => void;
  onGammaChange: (gamma: number) => void;
  /** Fit the limits to the loaded data once. */
  onAutoFit: () => void;
  /** Continuous auto-contrast, when it is shown with these controls. */
  continuous?: { isSelected: boolean; onChange: (on: boolean) => void };
  children?: ReactNode;
}

/** Contrast limits and gamma, each a slider with editable values, plus auto-fit. */
export function ContrastControls({
  label,
  contrastMin,
  contrastMax,
  gamma,
  dataRange,
  valueRange,
  integer,
  fullRange,
  onFullRangeChange,
  onContrastChange,
  onGammaChange,
  onAutoFit,
  continuous,
  children,
}: Props) {
  const [minValue, maxValue] = contrastBounds(contrastMin, contrastMax, dataRange, valueRange, fullRange);
  const span = maxValue - minValue;
  const step = integer ? 1 : span > 0 ? span / 1000 : 0.001;
  // The fields show each limit whole. The renderer applies a limit in float32,
  // so a float limit shows the fewest digits that name the same float32, up to
  // the nine any float32 needs, and an integer limit shows every digit.
  const format: Intl.NumberFormatOptions = integer
    ? { maximumFractionDigits: 0, useGrouping: false }
    : { maximumSignificantDigits: 9, useGrouping: false };
  const shown = (limit: number) => (integer ? limit : Number(shortestFloat32Text(limit)));
  const shownMin = shown(contrastMin);
  const shownMax = shown(contrastMax);

  return (
    <div className="lc-contrast" role="group" aria-label={`${label} contrast`}>
      <Slider<readonly [number, number]>
        label="Contrast"
        value={[shownMin, shownMax]}
        minValue={minValue}
        maxValue={maxValue}
        step={step}
        formatOptions={format}
        valueDisplay="field"
        thumbLabels={["Minimum", "Maximum"]}
        onChange={(next) => {
          const [lo, hi] = orderLimits(next, shownMin, step);
          // A limit left where it showed keeps the value it holds.
          const nextMin = lo === shownMin ? contrastMin : lo;
          const nextMax = hi === shownMax ? contrastMax : hi;
          if (nextMin !== contrastMin || nextMax !== contrastMax) onContrastChange(nextMin, nextMax);
        }}
      />
      <Slider<number>
        label="Gamma"
        value={gamma}
        minValue={GAMMA_MIN}
        maxValue={GAMMA_MAX}
        step={0.01}
        formatOptions={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }}
        valueDisplay="field"
        onChange={(next) => {
          if (next !== gamma) onGammaChange(next);
        }}
      />
      <div className="lc-contrast-actions">
        <Tooltip content={dataRange ? "Fit the limits to the loaded data once" : "No data has loaded yet"}>
          <Button size="sm" icon={MagicWandIcon} onPress={onAutoFit} isDisabled={!dataRange}>
            Auto
          </Button>
        </Tooltip>
        {continuous && (
          <Switch
            className="lc-contrast-continuous"
            label="Continuous"
            isSelected={continuous.isSelected}
            onChange={continuous.onChange}
          />
        )}
        {children}
        {integer && (
          <IconButton
            className="lc-contrast-full"
            icon={ArrowsOutLineHorizontalIcon}
            size="sm"
            label="Span the slider over the full value range"
            isSelected={fullRange}
            onSelectedChange={onFullRangeChange}
          />
        )}
      </div>
    </div>
  );
}
