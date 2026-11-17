import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { VisuallyHidden } from "react-aria-components";
import "./RangeBar.css";

export interface RangeBarProps {
  /** Names the bar for assistive tech. */
  label: string;
  /** The low and high values; low is never above high. */
  value: readonly [number, number];
  /** Fires continuously while a handle or the band moves. */
  onChange: (value: [number, number]) => void;
  /** The values at the bar's left and right ends. A value outside shows at the end it passed. */
  span: readonly [number, number];
  /** Scrolling over the bar asks to zoom by `factor` about `anchor`, the value under the pointer. Below 1 zooms in. */
  onZoom?: (anchor: number, factor: number) => void;
  /** Double-clicking the bar asks for its span back. */
  onZoomReset?: () => void;
  /** Whether the span is zoomed in, which the bar shows. */
  isZoomed?: boolean;
  /** What an arrow key moves a handle by, ten with Shift, and what a drag lands on. */
  step: number;
  /** Accessible names of the two handles. Default Minimum and Maximum. */
  thumbLabels?: readonly [string, string];
  /** A value as a screen reader reads it. */
  formatValue?: (value: number) => string;
  /** Drawn behind the band and the handles, filling the bar. */
  children?: ReactNode;
  className?: string;
}

/** Pointer travel a press takes before it drags, so a click or double-click moves nothing. */
const DRAG_THRESHOLD_PX = 3;
/** Shift slows a drag to this fraction of the pointer's travel. */
const FINE_DRAG = 0.1;
/** Zoom per pixel of wheel travel: one notch of a mouse wheel is about 100. */
const WHEEL_ZOOM = 0.002;
/** Pixels per line, for a wheel that reports lines. */
const WHEEL_LINE_PX = 16;

type Target = 0 | 1 | "band";

interface Drag {
  pointerId: number;
  /** `null` while two coincident handles wait for the first move to say which. */
  target: Target | null;
  pressX: number;
  lastX: number;
  moved: boolean;
  /** How far the pointer has moved, in values, Shift's slowing included. */
  offset: number;
  from: readonly [number, number];
}

/** `v` on the step grid, within the grid points inside `[a, b]`. */
function snapWithin(v: number, a: number, b: number, step: number): number {
  const lo = Math.ceil(a / step) * step;
  const hi = Math.floor(b / step) * step;
  if (lo > hi) return Math.min(b, Math.max(a, v));
  return Math.min(hi, Math.max(lo, Math.round(v / step) * step));
}

/** Two handles over a zoomable span, with the band between them and a backdrop behind. */
export function RangeBar({
  label,
  value,
  onChange,
  span,
  onZoom,
  onZoomReset,
  isZoomed,
  step,
  thumbLabels = ["Minimum", "Maximum"],
  formatValue = String,
  children,
  className,
}: RangeBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const handleRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)] as const;
  const inputRefs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)] as const;
  const drag = useRef<Drag | null>(null);
  const [active, setActive] = useState<Target | null>(null);
  const [a, b] = span;
  const width = b - a;
  const fraction = (v: number) => (width > 0 ? (Math.min(b, Math.max(a, v)) - a) / width : 0);

  const emit = (lo: number, hi: number) => {
    if (lo !== value[0] || hi !== value[1]) onChange([lo, hi]);
  };

  /** Handle `index` set to `v`, never past the other handle. */
  const setHandle = (index: 0 | 1, v: number) => {
    if (index === 0) emit(Math.min(v, value[1]), value[1]);
    else emit(value[0], Math.max(v, value[0]));
  };

  const targetAt = (x: number, trackWidth: number): Target | null | "either" => {
    const px = (v: number) => fraction(v) * trackWidth;
    // A handle past the span's end is not where it shows, so it is not grabbed.
    const near = ([0, 1] as const).filter((i) => {
      const v = value[i];
      const radius = (handleRefs[i].current?.getBoundingClientRect().width ?? 0) / 2;
      return v >= a && v <= b && Math.abs(x - px(v)) <= radius;
    });
    if (near.length === 1) return near[0];
    const [x0, x1] = [px(value[0]), px(value[1])];
    if (near.length === 2) {
      const mid = (x0 + x1) / 2;
      return x < mid ? 0 : x > mid ? 1 : "either";
    }
    return x > x0 && x < x1 ? "band" : null;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (e.button !== 0 || !track || !(width > 0)) return;
    const rect = track.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const hit = targetAt(e.clientX - rect.left, rect.width);
    if (hit === null) return;
    // No text selection, and focus goes to the handle rather than wherever the press landed.
    e.preventDefault();
    track.setPointerCapture?.(e.pointerId);
    const target = hit === "either" ? null : hit;
    drag.current = { pointerId: e.pointerId, target, pressX: e.clientX, lastX: e.clientX, moved: false, offset: 0, from: value };
    if (typeof target === "number") inputRefs[target].current?.focus({ preventScroll: true });
    setActive(target);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const track = trackRef.current;
    if (!d || e.pointerId !== d.pointerId || !track) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.pressX) < DRAG_THRESHOLD_PX) return;
      d.moved = true;
      if (d.target === null) {
        d.target = e.clientX < d.pressX ? 0 : 1;
        inputRefs[d.target].current?.focus({ preventScroll: true });
        setActive(d.target);
      }
    }
    const rect = track.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    d.offset += ((e.clientX - d.lastX) / rect.width) * width * (e.shiftKey ? FINE_DRAG : 1);
    d.lastX = e.clientX;
    if (d.target === "band") {
      // An end inside the span stops at its edge; an end already past it goes no further out.
      const [lo, hi] = d.from;
      let shift = d.offset;
      if (shift > 0) shift = Math.min(shift, hi <= b ? b - hi : 0);
      else shift = Math.max(shift, lo >= a ? a - lo : 0);
      shift = Math.trunc(shift / step) * step;
      emit(lo + shift, hi + shift);
    } else if (d.target !== null) {
      setHandle(d.target, snapWithin(d.from[d.target] + d.offset, a, b, step));
    }
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    setActive(null);
  };

  const onKeyDown = (index: 0 | 1, e: ReactKeyboardEvent<HTMLInputElement>) => {
    const direction = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (direction === undefined) return;
    e.preventDefault();
    const v = value[index];
    const moved = v + direction * step * (e.shiftKey ? 10 : 1);
    const lo = Math.ceil(a / step) * step;
    const hi = Math.floor(b / step) * step;
    // Like a drag, a step stops at the span's edge, and a handle past it only comes back.
    if (v < a) setHandle(index, direction > 0 ? Math.min(moved, hi) : v);
    else if (v > b) setHandle(index, direction < 0 ? Math.max(moved, lo) : v);
    else setHandle(index, Math.min(Math.max(moved, Math.min(lo, v)), Math.max(hi, v)));
  };

  // Assistive tech sets a handle through its input, as do Home and End.
  const onInput = (index: 0 | 1, e: ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.currentTarget.value);
    if (Number.isFinite(v)) setHandle(index, v);
  };

  const onWheel = useEffectEvent((e: WheelEvent) => {
    const track = trackRef.current;
    if (!onZoom || !track || e.deltaY === 0 || !(width > 0)) return;
    const rect = track.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    e.preventDefault();
    const anchor = a + ((e.clientX - rect.left) / rect.width) * width;
    const pixels = e.deltaY * (e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? rect.height : 1);
    onZoom(anchor, Math.exp(pixels * WHEEL_ZOOM));
  });

  // React's wheel listener is passive, and a zoom has to keep the panel from scrolling too.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const listener = (e: WheelEvent) => onWheel(e);
    track.addEventListener("wheel", listener, { passive: false });
    return () => track.removeEventListener("wheel", listener);
  }, []);

  const f0 = fraction(value[0]);
  const f1 = fraction(value[1]);
  return (
    <div
      className={className ? `lc-range-bar ${className}` : "lc-range-bar"}
      role="group"
      aria-label={label}
      data-zoomed={isZoomed || undefined}
    >
      <div
        ref={trackRef}
        className="lc-range-bar-track"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={() => onZoomReset?.()}
      >
        <div className="lc-range-bar-backdrop">{children}</div>
        <div
          className="lc-range-bar-band"
          style={{ left: `${f0 * 100}%`, width: `${(f1 - f0) * 100}%` }}
          data-dragging={active === "band" || undefined}
        />
        {([0, 1] as const).map((i) => {
          const v = value[i];
          return (
            <div
              key={i}
              ref={handleRefs[i]}
              className="lc-range-bar-handle"
              style={{ left: `${(i === 0 ? f0 : f1) * 100}%` }}
              data-beyond={v < a ? "start" : v > b ? "end" : undefined}
              data-dragging={active === i || undefined}
            >
              <VisuallyHidden>
                <input
                  ref={inputRefs[i]}
                  type="range"
                  aria-label={thumbLabels[i]}
                  aria-valuetext={formatValue(v)}
                  min={a}
                  max={b}
                  step={step}
                  value={Math.min(b, Math.max(a, v))}
                  onKeyDown={(e) => onKeyDown(i, e)}
                  onChange={(e) => onInput(i, e)}
                />
              </VisuallyHidden>
            </div>
          );
        })}
      </div>
    </div>
  );
}
