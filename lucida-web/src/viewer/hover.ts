/**
 * Where the pointer rests over a view, and the crosshair that puts in each
 * other view looking at the same place, as the scene works it out. The
 * readout reads the samples under the pointer and under every crosshair; the
 * crosshairs and the notice that a point is outside a view's data draw over
 * their views.
 *
 * The pointer is written on every move. The crosshairs are worked out once
 * per animation frame from the cameras as they stand then, so they follow a
 * zoom under a still pointer as well as a move.
 */
import type { WasmScene } from "lucida-core";

/** The pointer over a view. */
export interface HoverPointer {
  readonly view: number;
  /** Fractions of the canvas from its top left. */
  readonly x: number;
  readonly y: number;
  /** Whether a finger put it there. */
  readonly touch: boolean;
  /** The event's time, which a hover's lag runs from. */
  readonly atMs: number;
}

/** Which way the scene frame's X, Y and Z run on a view's screen at the point, the longest 1 long. */
export type CrosshairArms = readonly [readonly [number, number], readonly [number, number], readonly [number, number]];

/** What one view shows of the point under the pointer in another. */
export type CrosshairMark =
  | {
    readonly view: number;
    readonly kind: "at";
    /** Fractions of the view's width and height from its top left. */
    readonly at: readonly [number, number];
    readonly arms: CrosshairArms;
    /** The point in world space, in a volume view, whose readout reads there rather than along the ray. */
    readonly world?: readonly [number, number, number];
  }
  | { readonly view: number; readonly kind: "outside" };

const NO_MARKS: ReadonlyMap<number, CrosshairMark> = new Map();

export class Hover {
  private pointer: HoverPointer | null = null;
  private marksJson = "[]";
  private marks: ReadonlyMap<number, CrosshairMark> = NO_MARKS;
  private readonly listeners = new Set<() => void>();

  setPointer(pointer: HoverPointer | null): void {
    this.pointer = pointer;
  }

  getPointer(): HoverPointer | null {
    return this.pointer;
  }

  /** Work the crosshairs out again from the pointer and `scene`, telling the listeners when they moved. */
  refresh(scene: Pick<WasmScene, "crosshairs" | "view_rect">): ReadonlyMap<number, CrosshairMark> {
    const json = this.pointer ? crosshairsUnder(scene, this.pointer) : "[]";
    if (json === this.marksJson) return this.marks;
    this.marksJson = json;
    const marks = JSON.parse(json) as CrosshairMark[];
    this.marks = marks.length > 0 ? new Map(marks.map((mark) => [mark.view, mark])) : NO_MARKS;
    for (const listener of [...this.listeners]) listener();
    return this.marks;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The crosshair in `view`, or null where it has none. */
  markOf(view: number): CrosshairMark | null {
    return this.marks.get(view) ?? null;
  }
}

/** The scene's crosshairs for the point under `pointer`, as JSON. */
function crosshairsUnder(scene: Pick<WasmScene, "crosshairs" | "view_rect">, pointer: HoverPointer): string {
  const [x, y, width, height] = scene.view_rect(pointer.view);
  if (!(width > 0 && height > 0)) return "[]";
  return scene.crosshairs(pointer.view, (pointer.x - x) / width, (pointer.y - y) / height);
}

/** A point the readout reads: under the pointer, or under a crosshair. */
export interface ReadPoint {
  readonly view: number;
  /** Fractions of the canvas from its top left. */
  readonly x: number;
  readonly y: number;
  /** The view's rectangle, `[x, y, width, height]` in fractions of the canvas. */
  readonly rect: readonly [number, number, number, number];
  readonly touch: boolean;
  readonly crosshair: boolean;
  /** The point in world space, where a volume view reads a crosshair's samples. */
  readonly world?: readonly [number, number, number];
}

/**
 * The points under the pointer and under each crosshair, the pointer's
 * first, in fractions of the canvas. `rectOf` gives a view's rectangle.
 */
export function readPoints(
  pointer: HoverPointer,
  marks: ReadonlyMap<number, CrosshairMark>,
  rectOf: (view: number) => readonly [number, number, number, number],
): ReadPoint[] {
  const onCanvas = (view: number, [x, y]: readonly [number, number]) => {
    const rect = rectOf(view);
    return { view, x: rect[0] + x * rect[2], y: rect[1] + y * rect[3], rect };
  };
  const { view, x, y, touch } = pointer;
  const points: ReadPoint[] = [{ view, x, y, rect: rectOf(view), touch, crosshair: false }];
  for (const mark of marks.values()) {
    if (mark.kind !== "at") continue;
    points.push({ ...onCanvas(mark.view, mark.at), touch: false, crosshair: true, ...(mark.world && { world: mark.world }) });
  }
  return points;
}
