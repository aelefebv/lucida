/**
 * The HUD: a canvas strip in the viewport that shows what the pipeline is
 * doing, at the HUD's tick cadence, with the overlay toggles in its legend.
 *
 * The strip is drawn imperatively on a timer, not through React state and
 * not from an animation frame: one sample, one model read, one draw per
 * tick, and nothing per frame (ADR 0049 as amended). The legend is DOM, so
 * the toggles are ordinary checkboxes.
 */

import { useEffect, useRef } from "react";

import { drawHud, hudHeight } from "./hudDraw.ts";
import { buildHudView, createHudHistory, HUD_TICK_MS, pushSample } from "./hudModel.ts";
import { HudSource, type HudCacheReads } from "./hudSource.ts";
import { HudLegend } from "./HudLegend.tsx";
import "./Hud.css";

/** Room kept at the right of the viewport for `FpsCounter`. */
const RIGHT_RESERVE = 96;
const MARGIN = 8;
const MIN_WIDTH = 520;
const MAX_WIDTH = 1100;

export interface HudProps {
  /** The viewer canvas, for the width the strip may take. */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** The open datasets, for names and for pruning closed ones. */
  datasets: ReadonlyMap<string, { name: string }>;
  /** The session's cache, or null while there is none. */
  getCache: () => HudCacheReads | null;
}

export function Hud({ canvasRef, datasets, getCache }: HudProps) {
  const stripRef = useRef<HTMLCanvasElement | null>(null);
  const datasetsRef = useRef(datasets);
  const getCacheRef = useRef(getCache);
  useEffect(() => {
    datasetsRef.current = datasets;
    getCacheRef.current = getCache;
  }, [datasets, getCache]);

  useEffect(() => {
    const source = new HudSource({
      getCache: () => getCacheRef.current(),
      datasetName: (id) => datasetsRef.current.get(id)?.name ?? id,
    });
    source.start();
    const history = createHudHistory();

    const tick = () => {
      const strip = stripRef.current;
      if (!strip) return;
      pushSample(history, source.sample(new Set(datasetsRef.current.keys())));
      const view = buildHudView(history);

      const viewerWidth = canvasRef.current?.clientWidth ?? 0;
      const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewerWidth - 2 * MARGIN - RIGHT_RESERVE));
      const height = hudHeight(view, width);
      const dpr = window.devicePixelRatio || 1;
      const deviceWidth = Math.round(width * dpr);
      const deviceHeight = Math.round(height * dpr);
      if (strip.width !== deviceWidth) strip.width = deviceWidth;
      if (strip.height !== deviceHeight) strip.height = deviceHeight;
      strip.style.width = `${width}px`;
      strip.style.height = `${height}px`;
      strip.setAttribute(
        "aria-label",
        `pipeline HUD: ${view.quiescence.label}, ${view.quiescence.detail}; ${view.adapter.label}, ${view.adapter.detail}`,
      );

      const ctx = strip.getContext("2d");
      if (!ctx) return;
      drawHud(ctx, view, { width, height, dpr });
    };

    tick();
    const timer = setInterval(tick, HUD_TICK_MS);
    return () => {
      clearInterval(timer);
      source.dispose();
    };
  }, [canvasRef]);

  return (
    <div className="hud" data-testid="hud">
      <canvas ref={stripRef} className="hud-strip" role="img" aria-label="pipeline HUD" />
      <HudLegend />
    </div>
  );
}
