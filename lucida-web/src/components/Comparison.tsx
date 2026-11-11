/**
 * The controls of a view's comparison: a bar over the view to switch between
 * swipe and blink, blink by key or at a rate, and stop; and the divider a
 * swipe is dragged by. Each acts on the active view, which a press in the
 * view's controls makes their view first (`viewer/ViewOverlays.tsx`).
 */
import { useEffect, useRef, useState } from "react";
import { Slider, SliderThumb, SliderTrack } from "react-aria-components";
import { ArrowsLeftRightIcon, PauseIcon, PlayIcon, SplitHorizontalIcon, XIcon } from "@phosphor-icons/react";
import type { ComparisonActions, Comparison, CompareMode } from "../comparison.ts";
import { Badge, Card, IconButton, SegmentedControl, type KeyCombo } from "../ui/index.ts";
import { useShortcut } from "../ui/shortcuts.ts";
import "./Comparison.css";

const FLIP_KEYS: readonly KeyCombo[] = ["X"];

/** Blinks per second a blink can run at. */
const BLINK_RATES = ["1", "2", "4"] as const;
type BlinkRate = (typeof BLINK_RATES)[number];

/**
 * The divider's step: fine enough that a drag follows the pointer, so an
 * arrow key nudges it and Shift or Page Up moves it a tenth of the view.
 */
const DIVIDER_STEP = 0.001;

interface BarProps {
  comparison: Comparison | null;
  actions: ComparisonActions;
  nameOf: (datasetId: string) => string;
  /** Says when the pair lines up because someone placed it by hand, or null. */
  byHand?: string | null;
  /** Whether its view is the active one, which the actions steer. */
  active: boolean;
  /** Whether a running blink holds still, as a capture asks, which then
   *  shows the side the comparison records. */
  still?: boolean;
}

export function ComparisonBar({ comparison, actions, nameOf, byHand, active, still = false }: BarProps) {
  // A blink runs at the rate its comparison records, which a new comparison
  // starts without. It flips only while its view is active, since a flip
  // steers the active view.
  const [rate, setRate] = useState<BlinkRate>("2");
  const blinking = comparison?.mode === "blink";
  const running = blinking ? (comparison?.rate ?? null) : null;
  useBlinkTimer(running !== null && active && !still, running ?? 0, actions.flip);
  const stop = () => {
    if (running !== null) actions.setBlinkRate(null);
  };

  useShortcut({
    id: "compare.flip",
    keys: FLIP_KEYS,
    label: "Show the other compared layer",
    group: "View",
    // One bar binds the key: the active view's.
    enabled: blinking && active,
    onTrigger: () => {
      // A key press is the person taking over, so it stops a running blink.
      stop();
      actions.flip();
    },
  });

  if (!comparison) return null;
  const shown = comparison.showing === "a" ? comparison.a : comparison.b;
  const hidden = comparison.showing === "a" ? comparison.b : comparison.a;
  return (
    <Card padding="sm" className="lc-comparison-bar" aria-label="Comparison">
      <span className="lc-comparison-names" title={`${nameOf(comparison.a)} and ${nameOf(comparison.b)}`}>
        {blinking ? nameOf(shown) : `${nameOf(comparison.a)} | ${nameOf(comparison.b)}`}
      </span>
      {byHand && (
        <span className="lc-comparison-by-hand" title={byHand} aria-label={byHand}>
          <Badge tone="accent">By hand</Badge>
        </span>
      )}
      <SegmentedControl<CompareMode>
        label="Compare by"
        size="sm"
        options={[
          { value: "swipe", label: "Swipe", icon: SplitHorizontalIcon },
          { value: "blink", label: "Blink", icon: ArrowsLeftRightIcon },
        ]}
        value={comparison.mode}
        onChange={actions.setMode}
      />
      {blinking && (
        <>
          <IconButton
            icon={ArrowsLeftRightIcon}
            size="sm"
            label={`Show ${nameOf(hidden)}`}
            shortcut={FLIP_KEYS}
            onPress={() => {
              stop();
              actions.flip();
            }}
          />
          <IconButton
            icon={running !== null ? PauseIcon : PlayIcon}
            size="sm"
            label={running !== null ? "Stop blinking" : "Blink"}
            onPress={() => actions.setBlinkRate(running !== null ? null : Number(rate))}
          />
          <SegmentedControl<BlinkRate>
            label="Blinks per second"
            size="sm"
            options={BLINK_RATES.map((value) => ({ value, label: `${value}/s` }))}
            value={running !== null ? (String(running) as BlinkRate) : rate}
            onChange={(next) => {
              setRate(next);
              if (running !== null) actions.setBlinkRate(Number(next));
            }}
          />
        </>
      )}
      <IconButton icon={XIcon} size="sm" label="Stop comparing" onPress={actions.end} />
    </Card>
  );
}

/** Calls `flip` `rate` times a second while `playing`. */
function useBlinkTimer(playing: boolean, rate: number, flip: () => void): void {
  const flipRef = useRef(flip);
  useEffect(() => {
    flipRef.current = flip;
  });
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => flipRef.current(), 1000 / rate);
    return () => window.clearInterval(id);
  }, [playing, rate]);
}

interface DividerProps {
  comparison: Comparison | null;
  actions: ComparisonActions;
  nameOf: (datasetId: string) => string;
}

/**
 * The swipe divider: a line across the view's height that a pointer or a
 * finger drags by any point along it, with a knob that takes focus and the
 * arrow keys. Only the line takes the pointer; the rest of the view still
 * pans and orbits. The trace driver finds it by its class.
 */
export function SwipeDivider({ comparison, actions, nameOf }: DividerProps) {
  if (!comparison || comparison.mode !== "swipe") return null;
  return (
    <Slider
      className="lc-swipe"
      aria-label={`Swipe divider, ${nameOf(comparison.a)} left of it and ${nameOf(comparison.b)} right`}
      minValue={0}
      maxValue={1}
      step={DIVIDER_STEP}
      formatOptions={{ style: "percent" }}
      value={comparison.divider}
      onChange={actions.setDivider}
    >
      <SliderTrack className="lc-swipe-track">
        <SliderThumb className="lc-swipe-divider">
          <div className="lc-swipe-line" />
          <div className="lc-swipe-knob">
            <SplitHorizontalIcon size={14} aria-hidden />
          </div>
        </SliderThumb>
      </SliderTrack>
    </Slider>
  );
}
