/**
 * PROTOTYPE — throwaway. Issue #892.
 *
 * Floating bar: variant cycling (arrows + <- ->), which run is loaded, the
 * replay transport, the Chrome-JSON export for the borrowed path, and the
 * monitor's own cost. The last one is not decoration — "it must not perturb
 * what it measures" is one of the questions on the ticket, so the prototype
 * reports its own render cost where you cannot miss it.
 */

import { useEffect } from "react";
import type { RunKey } from "./syntheticTrace.ts";
import type { Replay } from "./useReplay.ts";

export interface SwitcherProps {
  variants: { key: string; name: string }[];
  current: string;
  onVariant: (key: string) => void;
  run: RunKey;
  onRun: (r: RunKey) => void;
  replay: Replay;
  onExport: () => void;
  cost: { tableBytes: number; chromeBytes: number | null };
}

export function PrototypeSwitcher({
  variants,
  current,
  onVariant,
  run,
  onRun,
  replay,
  onExport,
  cost,
}: SwitcherProps) {
  const i = Math.max(
    0,
    variants.findIndex((v) => v.key === current),
  );
  const cycle = (d: number) =>
    onVariant(variants[(i + d + variants.length) % variants.length].key);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return;
      }
      if (e.key === "ArrowLeft") cycle(-1);
      if (e.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="proto-bar">
      <button onClick={() => cycle(-1)} aria-label="previous variant">
        ‹
      </button>
      <span className="proto-label">
        <strong>{variants[i].key}</strong> — {variants[i].name}
      </span>
      <button onClick={() => cycle(1)} aria-label="next variant">
        ›
      </button>

      <span className="proto-sep" />

      <select value={run} onChange={(e) => onRun(e.target.value as RunKey)}>
        <option value="cold">cold open (36 chunks)</option>
        <option value="warm">warm re-open (2,559 chunks)</option>
      </select>

      <span className="proto-sep" />

      {replay.playing ? (
        <button onClick={replay.pause}>❚❚ pause</button>
      ) : (
        <button onClick={replay.restart}>▶ replay live</button>
      )}
      <button onClick={replay.seekEnd} disabled={replay.finished}>
        ⤓ whole run
      </button>
      <select
        value={replay.speed}
        onChange={(e) => replay.setSpeed(Number(e.target.value))}
      >
        <option value={0.5}>0.5×</option>
        <option value={1}>1×</option>
        <option value={4}>4×</option>
        <option value={16}>16×</option>
      </select>

      <span className="proto-sep" />

      <button onClick={onExport}>⇩ Chrome JSON</button>

      <span className="proto-cost">
        table {kb(cost.tableBytes)}
        {cost.chromeBytes != null && <> · chrome json {kb(cost.chromeBytes)}</>}
        {replay.renderMsP95 > 0 && (
          <> · monitor p95 {replay.renderMsP95.toFixed(1)} ms/frame</>
        )}
      </span>
    </div>
  );
}

function kb(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} kB`;
}
