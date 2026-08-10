/**
 * PROTOTYPE — throwaway. Issue #892.
 *
 * The trace is being written while you watch, so the prototype has to be
 * watchable while it is being written. This replays a finished trace in real
 * time and exposes a cursor; each variant is free to disagree about what to do
 * with it (auto-follow, ignore, or freeze until you stop).
 *
 * The cursor lives in a ref and is read inside rAF, deliberately. A live view
 * that re-renders a React tree at 60 fps inside the tab it is profiling is
 * self-defeating — measuring that cost is part of the question.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface Replay {
  /** current cursor, microseconds from run start. Read inside rAF. */
  nowRef: React.RefObject<number>;
  /** coarse cursor for React chrome — updated at 4 Hz, not 60 */
  coarseNowUs: number;
  playing: boolean;
  finished: boolean;
  play: () => void;
  pause: () => void;
  restart: () => void;
  /** jump the cursor to the end — "the whole recording" */
  seekEnd: () => void;
  speed: number;
  setSpeed: (s: number) => void;
  /** ms the last monitor render took, measured by the variant */
  reportRenderMs: (ms: number) => void;
  /**
   * p95 of the variant's own render cost. Sampled whether or not the replay is
   * playing, deliberately: while playing, variant A draws only a 6 s scrolling
   * window, so a playing-only sample measures a subset of the spans and
   * understates the cost of the paused view, which draws all of them.
   */
  renderMsP95: number;
}

/**
 * Mount-scoped: the caller keys the component on the run so switching runs
 * remounts rather than resetting state from an effect.
 */
export function useReplay(durationUs: number): Replay {
  const nowRef = useRef(durationUs);
  const [coarseNowUs, setCoarseNowUs] = useState(durationUs);
  const [playing, setPlaying] = useState(false);
  const [finished, setFinished] = useState(true);
  const [speed, setSpeedState] = useState(1);
  const speedRef = useRef(1);
  const samples = useRef<number[]>([]);
  const [renderMsP95, setRenderMsP95] = useState(0);

  const setSpeed = useCallback((s: number) => {
    speedRef.current = s;
    setSpeedState(s);
  }, []);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let lastCoarse = 0;
    const tick = (t: number) => {
      const dt = t - last;
      last = t;
      nowRef.current = Math.min(
        durationUs,
        nowRef.current + dt * 1000 * speedRef.current,
      );
      if (t - lastCoarse > 250) {
        lastCoarse = t;
        setCoarseNowUs(nowRef.current);
      }
      if (nowRef.current >= durationUs) {
        setPlaying(false);
        setFinished(true);
        setCoarseNowUs(durationUs);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, durationUs]);

  // Cost sampling runs on its own 2 Hz timer, independent of playback.
  useEffect(() => {
    const id = setInterval(() => {
      const s = samples.current;
      if (s.length > 8) {
        const sorted = s.slice(-240).sort((a, b) => a - b);
        setRenderMsP95(sorted[Math.floor(sorted.length * 0.95)]);
      }
    }, 500);
    return () => clearInterval(id);
  }, []);

  const play = useCallback(() => {
    if (nowRef.current >= durationUs) nowRef.current = 0;
    setFinished(false);
    setPlaying(true);
  }, [durationUs]);

  const pause = useCallback(() => setPlaying(false), []);

  const restart = useCallback(() => {
    nowRef.current = 0;
    setCoarseNowUs(0);
    setFinished(false);
    setPlaying(true);
  }, []);

  const seekEnd = useCallback(() => {
    nowRef.current = durationUs;
    setCoarseNowUs(durationUs);
    setPlaying(false);
    setFinished(true);
  }, [durationUs]);

  const reportRenderMs = useCallback((ms: number) => {
    const s = samples.current;
    s.push(ms);
    if (s.length > 240) s.splice(0, s.length - 240);
  }, []);

  return {
    nowRef,
    coarseNowUs,
    playing,
    finished,
    play,
    pause,
    restart,
    seekEnd,
    speed,
    setSpeed,
    reportRenderMs,
    renderMsP95,
  };
}
