/**
 * Four-up's planes over one view, each in its axis's color: lines across a
 * slice view, which a drag moves, and outlines over the volume. A drag sets
 * the plane's place at the pointer, and every view crosses there.
 */
import type { PointerEvent } from "react";
import type { SpatialAxis } from "../renderer/slicePlane.ts";
import { isUpright, type PlaneLine } from "./planeLines.ts";
import "./PlaneLines.css";

interface Props {
  lines: readonly PlaneLine[];
  /** Move `axis`'s plane to `fraction` of the way across the view; absent where no line moves. */
  onDrag?: (axis: SpatialAxis, fraction: number) => void;
}

export function PlaneLines({ lines, onDrag }: Props) {
  if (lines.length === 0) return null;
  return (
    <svg className="lc-plane-lines" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
      {lines.map((line, index) => (
        <g key={index} data-axis={line.axis}>
          <line className="lc-plane-line" x1={line.from[0]} y1={line.from[1]} x2={line.to[0]} y2={line.to[1]} />
          {onDrag && (
            <line
              className="lc-plane-line-grip"
              data-upright={isUpright(line) ? "" : undefined}
              x1={line.from[0]}
              y1={line.from[1]}
              x2={line.to[0]}
              y2={line.to[1]}
              onPointerDown={(e) => grip(e, line, onDrag)}
              onPointerMove={(e) => drag(e, line, onDrag)}
            />
          )}
        </g>
      ))}
    </svg>
  );
}

function grip(e: PointerEvent<SVGLineElement>, line: PlaneLine, onDrag: NonNullable<Props["onDrag"]>) {
  e.currentTarget.setPointerCapture(e.pointerId);
  // The press is the drag's, not a pan of the view under it.
  e.stopPropagation();
  drag(e, line, onDrag);
}

function drag(e: PointerEvent<SVGLineElement>, line: PlaneLine, onDrag: NonNullable<Props["onDrag"]>) {
  if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
  const svg = e.currentTarget.ownerSVGElement;
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const fraction = isUpright(line)
    ? (e.clientX - rect.left) / rect.width
    : (e.clientY - rect.top) / rect.height;
  onDrag(line.axis, Math.min(Math.max(fraction, 0), 1));
}
