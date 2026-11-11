/**
 * The point under the pointer in another view, over this one: a cross whose
 * arms run along the scene frame's axes as this view draws them, flat in a
 * slice view and turned with the camera in a volume. It is drawn over the
 * data, never hidden behind it, since the point is what the views compare.
 * Where this view's data doesn't hold the point, it says so in its column
 * instead, since a mark there would point at nothing it draws.
 */
import { useSyncExternalStore } from "react";
import type { CrosshairArms, Hover } from "./hover.ts";
import "./Crosshair.css";

/** How far the longest arm reaches from the point, and the gap it leaves there, in CSS pixels. */
const REACH = 16;
const GAP = 4;
/** An arm shorter than this share of the longest is one the view looks along: none is drawn. */
const MIN_ARM = 0.05;

interface Props {
  hover: Pick<Hover, "subscribe" | "markOf">;
  view: number;
}

export function Crosshair({ hover, view }: Props) {
  const mark = useSyncExternalStore(hover.subscribe, () => hover.markOf(view));
  if (mark?.kind !== "at") return null;
  return (
    <svg
      className="lc-crosshair"
      data-crosshair=""
      style={{ left: `${mark.at[0] * 100}%`, top: `${mark.at[1] * 100}%` }}
      viewBox={`${-REACH} ${-REACH} ${2 * REACH} ${2 * REACH}`}
      aria-hidden="true"
    >
      {armSegments(mark.arms).map(([x1, y1, x2, y2], index) => (
        <line key={index} x1={x1} y1={y1} x2={x2} y2={y2} />
      ))}
    </svg>
  );
}

/** Each arm as a segment either side of the gap, `[x1, y1, x2, y2]` from the point. */
function armSegments(arms: CrosshairArms): [number, number, number, number][] {
  const segments: [number, number, number, number][] = [];
  for (const [dx, dy] of arms) {
    const length = Math.hypot(dx, dy);
    if (length < MIN_ARM) continue;
    const [ux, uy] = [dx / length, dy / length];
    const reach = Math.max(REACH * length, GAP * 2);
    for (const side of [1, -1]) {
      segments.push([side * ux * GAP, side * uy * GAP, side * ux * reach, side * uy * reach]);
    }
  }
  return segments;
}

/** Says, in the view's column, that the point under the pointer is outside the view's data. */
export function CrosshairOutside({ hover, view }: Props) {
  const mark = useSyncExternalStore(hover.subscribe, () => hover.markOf(view));
  if (mark?.kind !== "outside") return null;
  return (
    <div className="lc-view-notice" role="status" data-crosshair-outside="">
      <p>The point under the pointer is outside this view's data.</p>
    </div>
  );
}
