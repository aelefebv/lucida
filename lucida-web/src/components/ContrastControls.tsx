import type { ReactNode } from "react";
import { ArrowsOutLineHorizontalIcon, MagicWandIcon } from "@phosphor-icons/react";
import { Button, IconButton, Slider, Switch, Tooltip } from "../ui/index.ts";
import { contrastBounds, orderLimits } from "./contrastLimits.ts";
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
  /** The data type's largest value. */
  fullRangeMax: number;
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
  fullRangeMax,
  integer,
  fullRange,
  onFullRangeChange,
  onContrastChange,
  onGammaChange,
  onAutoFit,
  continuous,
  children,
}: Props) {
  const [minValue, maxValue] = contrastBounds(contrastMin, contrastMax, dataRange, fullRangeMax, fullRange);
  const span = maxValue - minValue;
  const step = integer ? 1 : span > 0 ? span / 1000 : 0.001;
  const format: Intl.NumberFormatOptions = integer
    ? { maximumFractionDigits: 0, useGrouping: false }
    : { maximumSignificantDigits: 4, useGrouping: false };

  return (
    <div className="lc-contrast" role="group" aria-label={`${label} contrast`}>
      <Slider<readonly [number, number]>
        label="Contrast"
        value={[contrastMin, contrastMax]}
        minValue={minValue}
        maxValue={maxValue}
        step={step}
        formatOptions={format}
        valueDisplay="field"
        thumbLabels={["Minimum", "Maximum"]}
        onChange={(next) => {
          const [lo, hi] = orderLimits(next, contrastMin, step);
          if (lo !== contrastMin || hi !== contrastMax) onContrastChange(lo, hi);
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
