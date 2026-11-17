import type { ReactNode } from "react";
import { ArrowsOutLineHorizontalIcon, MagicWandIcon } from "@phosphor-icons/react";
import { Button, IconButton, Slider, Switch, Tooltip } from "../ui/index.ts";
import type { ValueHistogram } from "../pipeline/valueHistogram.ts";
import { ContrastLimits } from "./ContrastLimits.tsx";
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
  /** Whole-number data steps by 1; other data by a thousandth of the span in view. */
  integer: boolean;
  /** Span the bar over the data type's whole range instead of the loaded data's. */
  fullRange: boolean;
  /** The loaded values, drawn behind the limits, or `null` before any have loaded. */
  histogram: ValueHistogram | null;
  onFullRangeChange: (fullRange: boolean) => void;
  onContrastChange: (min: number, max: number) => void;
  onGammaChange: (gamma: number) => void;
  /** Stretch the limits over the loaded data once. */
  onAutoFit: () => void;
  /** Continuous auto-contrast, when it is shown with these controls. */
  continuous?: { isSelected: boolean; onChange: (on: boolean) => void };
  children?: ReactNode;
}

/** Contrast limits over the channel's histogram, gamma as a slider, and auto-fit. */
export function ContrastControls({
  label,
  contrastMin,
  contrastMax,
  gamma,
  dataRange,
  valueRange,
  integer,
  fullRange,
  histogram,
  onFullRangeChange,
  onContrastChange,
  onGammaChange,
  onAutoFit,
  continuous,
  children,
}: Props) {
  return (
    <div className="lc-contrast" role="group" aria-label={`${label} contrast`}>
      <ContrastLimits
        contrastMin={contrastMin}
        contrastMax={contrastMax}
        dataRange={dataRange}
        valueRange={valueRange}
        integer={integer}
        fullRange={fullRange}
        histogram={histogram}
        onContrastChange={onContrastChange}
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
        <Tooltip content={dataRange ? "Stretch: clip the lowest and highest 0.1% of values" : "No data has loaded yet"}>
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
