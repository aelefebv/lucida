/**
 * Four-up's planes where they cross a view, as the scene lays them out: in
 * a slice view a line for each plane whose axis it draws, in the volume each
 * plane's outline over the data.
 *
 * A collection is cut at one place from every tile's own edge, so the lines
 * stand on one tile, which they share across the views: the last one the
 * pointer was over, and the first until then. Lines on every tile would say
 * nothing more and crowd a large collection.
 */
import { useEffect } from "react";
import type { WasmScene } from "lucida-core";
import { isCaptureSurface } from "../captureSurface.ts";
import type { SpatialAxis } from "../renderer/slicePlane.ts";
import type { SceneStore } from "../sceneStore.ts";
import { isViewPane } from "./viewPane.ts";

export interface PlaneLine {
  /** The axis the plane stands at a place along. */
  readonly axis: SpatialAxis;
  /** The segment's ends, as fractions of the view's width and height from its top left. */
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
}

/** A tile of a collection as lucida-core names it, which the page only hands back. */
export type PlaneTile = string;

type PlanesScene = Pick<WasmScene, "plane_lines" | "plane_line_position" | "tile_at">;

/** One view's lines as last read, and what they were read at. */
interface Read {
  readonly epochs: unknown;
  readonly tile: PlaneTile | null;
  readonly json: string;
  readonly lines: readonly PlaneLine[];
}

const NO_LINES: readonly PlaneLine[] = [];

/**
 * The query parameter a capture sets to `1` to draw the plane lines, which
 * the capture surface otherwise leaves out with everything over the canvas.
 */
export const PLANE_LINES_PARAM = "plane_lines";

/** Whether this page is a capture that asked for the plane lines. */
export function planeLinesCaptured(search?: string): boolean {
  const raw = search ?? (typeof window === "undefined" ? "" : window.location.search);
  return isCaptureSurface(raw) && new URLSearchParams(raw).get(PLANE_LINES_PARAM) === "1";
}

/** Whether `line` spans its view top to bottom, so a drag moves it across. */
export function isUpright(line: PlaneLine): boolean {
  return line.from[0] === line.to[0];
}

/**
 * Four-up's planes over every view, on the tile they follow. A view's lines
 * are read again only once the scene or the tile has moved, and keep their
 * identity until they change, so a pointer moving within one tile renders
 * nothing.
 */
export class FourUpPlanes {
  private tile: PlaneTile | null = null;
  private readonly read = new Map<number, Read>();
  private readonly listeners = new Set<() => void>();
  private readonly scene: PlanesScene;
  private readonly store: Pick<SceneStore, "subscribe" | "getEpochs">;

  constructor(scene: PlanesScene, store: Pick<SceneStore, "subscribe" | "getEpochs">) {
    this.scene = scene;
    this.store = store;
  }

  /** Listen for a move of the scene or of the tile. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    const unsubscribe = this.store.subscribe(listener);
    return () => {
      this.listeners.delete(listener);
      unsubscribe();
    };
  };

  /** Where four-up's planes cross `view`; none in any other layout. */
  linesOf(view: number): readonly PlaneLine[] {
    const epochs = this.store.getEpochs();
    const last = this.read.get(view);
    if (last && last.epochs === epochs && last.tile === this.tile) return last.lines;
    const json = this.scene.plane_lines(view, this.tile);
    const lines = last?.json === json ? last.lines : parseLines(json);
    this.read.set(view, { epochs, tile: this.tile, json, lines });
    return lines;
  }

  /** Follow the tile under `at` in `view`, fractions of its width and height
   *  from its top left. Outside every tile the last one stays. */
  hover(view: number, at: readonly [number, number]): void {
    const tile = this.scene.tile_at(view, at[0], at[1]);
    if (tile === "null" || tile === this.tile) return;
    this.tile = tile;
    this.notify();
  }

  /** Stand on the first tile again. */
  forget(): void {
    if (this.tile === null) return;
    this.tile = null;
    this.notify();
  }

  /** The position on `view`'s grid along `axis` under `fraction` of the way
   *  across it, as dragging the plane's line sets it for every tile; null
   *  where `view` doesn't draw `axis`. */
  positionAt(view: number, axis: SpatialAxis, fraction: number): number | null {
    const index = Number(this.scene.plane_line_position(view, axis, fraction, this.tile));
    return index >= 0 ? index : null;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function parseLines(json: string): readonly PlaneLine[] {
  const lines = JSON.parse(json) as PlaneLine[];
  return lines.length > 0 ? lines : NO_LINES;
}

/**
 * Have `planes` follow the tile under a pointer over any view's pane in
 * `eventRoot` while `on`: one core call a move. Turned off, they stand on
 * the first tile again.
 */
export function useFollowTile(planes: FourUpPlanes | null, eventRoot: HTMLElement | null, on: boolean): void {
  useEffect(() => {
    if (!planes || !eventRoot || !on) return;
    const onMove = (e: PointerEvent) => {
      // Over a line or a marker drawn on a view, the tile stays.
      if (!isViewPane(e.target)) return;
      const pane = e.target as HTMLElement;
      const rect = pane.getBoundingClientRect();
      const at = [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height] as const;
      planes.hover(Number(pane.dataset.viewPane), at);
    };
    eventRoot.addEventListener("pointermove", onMove);
    return () => {
      eventRoot.removeEventListener("pointermove", onMove);
      planes.forget();
    };
  }, [planes, eventRoot, on]);
}
