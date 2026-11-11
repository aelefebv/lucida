/**
 * The controls of the view's comparison: a bar over the canvas to switch
 * between swipe and blink, blink by key or at a rate, and stop; and the
 * divider a swipe is dragged by.
 */
import { useEffect, useRef, useState } from "react";
import { Slider, SliderThumb, SliderTrack } from "react-aria-components";
import { ArrowsLeftRightIcon, PauseIcon, PlayIcon, SplitHorizontalIcon, XIcon } from "@phosphor-icons/react";
import type { ComparisonActions, Comparison, CompareMode } from "../comparison.ts";
import { Card, IconButton, SegmentedControl, type KeyCombo } from "../ui/index.ts";
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
  /** What it says of the layers the comparison sets aside, or null for none. */
  setAside: string | null;
}

export function ComparisonBar({ comparison, actions, nameOf, setAside }: BarProps) {
  // A running blink belongs to the pair it was started on, so a new
  // comparison starts still.
  const pair = comparison ? `${comparison.a}\n${comparison.b}` : null;
  const [playingPair, setPlayingPair] = useState<string | null>(null);
  const [rate, setRate] = useState<BlinkRate>("2");
  const blinking = comparison?.mode === "blink";
  const playing = blinking && pair !== null && playingPair === pair;
  useBlinkTimer(playing, Number(rate), actions.flip);

  useShortcut({
    id: "compare.flip",
    keys: FLIP_KEYS,
    label: "Show the other compared layer",
    group: "View",
    enabled: blinking,
    onTrigger: () => {
      // A key press is the person taking over, so it stops a running blink.
      setPlayingPair(null);
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
      {setAside && <span className="lc-comparison-aside">{setAside}</span>}
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
              setPlayingPair(null);
              actions.flip();
            }}
          />
          <IconButton
            icon={playing ? PauseIcon : PlayIcon}
            size="sm"
            label={playing ? "Stop blinking" : "Blink"}
            onPress={() => setPlayingPair(playing ? null : pair)}
          />
          <SegmentedControl<BlinkRate>
            label="Blinks per second"
            size="sm"
            options={BLINK_RATES.map((value) => ({ value, label: `${value}/s` }))}
            value={rate}
            onChange={setRate}
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
