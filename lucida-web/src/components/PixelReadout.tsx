/**
 * The value under the pointer: hover the canvas with a mouse or pen, or rest a
 * finger on it, and a card beside the point lists each visible channel's
 * sample there in data units, with its position and the level it came from,
 * and each visible label overlay's id there, with the name its table gives it.
 * Each crosshair the point puts in another view gets the same card, read
 * under the crosshair, so the views' values at one point sit side by side.
 *
 * The render worker reads the samples from what it draws (`worker/probe.ts`).
 * One read of every point is in flight at a time, and a new one goes out only
 * when a point moved or a frame was drawn since the last, so the readout
 * follows arriving data without asking for frames of its own. The crosshairs
 * are worked out on the same animation frame, from the cameras as they stand.
 */

import { isViewPane } from "../viewer/viewPane.ts";
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import type { WasmScene } from "lucida-core";
import type { RenderClient } from "../renderer/renderClient.ts";
import type { ProbeSample } from "../renderer/workerProtocol.ts";
import type { ResolvedLayers } from "../resolvedLayers.ts";
import type { DatasetState } from "../types.ts";
import { Axis } from "../axes.ts";
import { cutAxis, type SlicePlane, type SpatialAxis } from "../renderer/slicePlane.ts";
import { frameClock } from "../frameClock.ts";
import { REVEAL_LINGER_MS } from "../ui/longPress.ts";
import { readPoints, type Hover, type HoverPointer, type ReadPoint } from "../viewer/hover.ts";
import { channelDisplayName } from "./channels.ts";
import type { ClientPoint } from "./cameraProjection.ts";
import { rampGradient } from "./colormapSwatch.ts";
import { readoutBlocks, type ReadoutContext, type ReadoutLabel } from "./pixelReadout.ts";
import { labelColor, MAX_GPU_LABEL_COLORS, type RGBA } from "../renderer/labelColors.ts";
import "./PixelReadout.css";

export interface PixelReadoutHandle {
  /** Show the readout for a finger resting at a client point, until it lifts. */
  pressAt(at: ClientPoint): void;
}

/** What the readout tells the trace of a hover: that one landed, and that its readouts are drawn. */
export interface HoverTrace {
  markHover(atMs: number): void;
  noteHoverDrawn(throughMs: number, dispatchedMs: number): void;
}

interface Props {
  /** The canvas every view divides, which a probe reads a point of. */
  canvas: HTMLCanvasElement;
  /**
   * What holds the views' panes. Pointers over any view reach it, so the
   * readout follows whichever view is under the pointer.
   */
  eventRoot: HTMLElement;
  client: RenderClient;
  scene: WasmScene;
  datasets: Map<string, DatasetState>;
  layers: ResolvedLayers;
  /** Where the pointer rests, and the crosshairs it puts in the other views. */
  hover: Hover;
  /** Where hovers are traced, once the page has a render loop. */
  trace?: () => HoverTrace | null;
  ref?: Ref<PixelReadoutHandle>;
}

/** One card's point and what was read there. */
interface Card {
  point: ReadPoint;
  samples: ProbeSample[];
}

/** What a read found: a card per point, and the hovers it answers. */
interface Shown {
  cards: Card[];
  /** The newest hover event the read's points came from. */
  throughMs: number;
  /** When the read left for the worker. */
  dispatchedMs: number;
}

/** Gap between the point and the card, in CSS pixels. */
const OFFSET = 14;

export function PixelReadout({ canvas, eventRoot, client, scene, datasets, layers, hover, trace, ref }: Props) {
  const [shown, setShown] = useState<Shown | null>(null);
  const probe = useRef({
    inFlight: false,
    probedKey: "",
    probedFrame: -1,
    linger: undefined as ReturnType<typeof setTimeout> | undefined,
  });

  const point = (at: HoverPointer | null) => {
    const state = probe.current;
    clearTimeout(state.linger);
    hover.setPointer(at);
    if (at) {
      frameClock.wake();
      return;
    }
    hover.refresh(scene);
    state.probedKey = "";
    setShown(null);
  };

  useImperativeHandle(ref, () => ({
    pressAt: (at) => point(pointerOver(paneAt(eventRoot, at), canvas, at, true, performance.now())),
  }));

  useEffect(() => {
    const state = probe.current;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      // Over a marker drawn on a view, as off the canvas, nothing is read.
      const pane = isViewPane(e.target) ? (e.target as HTMLElement) : null;
      point(pointerOver(pane, canvas, e, false, e.timeStamp));
      // A drag is the pan or orbit it moves, not a hover.
      if (pane && e.buttons === 0) trace?.()?.markHover(e.timeStamp);
    };
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType !== "touch") point(null);
    };
    // A finger that lands again starts over; one that lifts leaves the card a moment.
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "touch" && hover.getPointer()?.touch) point(null);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !hover.getPointer()?.touch) return;
      clearTimeout(state.linger);
      state.linger = setTimeout(() => point(null), REVEAL_LINGER_MS);
    };
    eventRoot.addEventListener("pointermove", onMove);
    eventRoot.addEventListener("pointerleave", onLeave);
    eventRoot.addEventListener("pointerdown", onDown);
    eventRoot.addEventListener("pointerup", onUp);
    eventRoot.addEventListener("pointercancel", onUp);
    return () => {
      clearTimeout(state.linger);
      eventRoot.removeEventListener("pointermove", onMove);
      eventRoot.removeEventListener("pointerleave", onLeave);
      eventRoot.removeEventListener("pointerdown", onDown);
      eventRoot.removeEventListener("pointerup", onUp);
      eventRoot.removeEventListener("pointercancel", onUp);
    };
    // `point` reads only refs, the hover and the scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas, eventRoot, hover, trace]);

  useEffect(() => {
    const state = probe.current;
    const rectOf = (view: number) => {
      const [x, y, width, height] = scene.view_rect(view);
      return [x, y, width, height] as const;
    };
    return frameClock.subscribe(() => {
      const marks = hover.refresh(scene);
      const pointer = hover.getPointer();
      if (!pointer || state.inFlight) return;
      if (canvas.clientWidth === 0 || canvas.clientHeight === 0) return;
      const points = readPoints(pointer, marks, rectOf);
      const key = JSON.stringify(points);
      const frame = client.lastFrameSeq();
      if (key === state.probedKey && frame === state.probedFrame) return;
      state.probedKey = key;
      state.probedFrame = frame;
      state.inFlight = true;
      const dispatchedMs = performance.now();
      void Promise.all(points.map((at) => client.probe(at.x, at.y, at.world && [...at.world]))).then((read) => {
        state.inFlight = false;
        // The pointer may have left while the read was out.
        if (hover.getPointer()) {
          setShown({ cards: points.map((at, i) => ({ point: at, samples: read[i] })), throughMs: pointer.atMs, dispatchedMs });
        }
        // A point that moved while the read was out is read next.
        frameClock.wake();
      });
    });
  }, [client, canvas, scene, hover]);

  // Once the cards are on the page, the hovers they read are answered.
  useLayoutEffect(() => {
    if (shown) trace?.()?.noteHoverDrawn(shown.throughMs, shown.dispatchedMs);
  }, [shown, trace]);

  const context = useMemo(() => readoutContext(scene, datasets, layers), [scene, datasets, layers]);
  const cards = useMemo(
    () => (shown?.cards ?? []).map((card) => ({
      point: card.point,
      blocks: readoutBlocks(card.samples, { ...context, cutAxis: () => viewCutAxis(scene, card.point.view) }),
    })),
    [shown, context, scene],
  );
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  return cards.map(({ point: at, blocks }) => blocks.length > 0 && (
    <div
      key={`${at.view}${at.crosshair ? "+" : ""}`}
      className="lc-pixel-readout"
      role="tooltip"
      data-testid="pixel-readout"
      data-crosshair={at.crosshair || undefined}
      data-touch={at.touch || undefined}
      // Flipped within its own view, so the card stays over the view it reads.
      data-flip-x={(!at.touch && at.x - at.rect[0] > at.rect[2] * 0.6) || undefined}
      data-flip-y={(!at.touch && at.y - at.rect[1] > at.rect[3] * 0.6) || undefined}
      style={{ left: at.x * width, top: at.y * height, ["--lc-readout-offset" as string]: `${OFFSET}px` }}
    >
      {blocks.map((block) => (
        <section key={block.key} className="lc-pixel-readout-block">
          {block.title && <div className="lc-pixel-readout-title">{block.title}</div>}
          <div className="lc-pixel-readout-head">
            <span className="lc-pixel-readout-position">
              {block.position.map((axis) => (
                <span key={axis.label}>
                  <span className="lc-pixel-readout-axis">{axis.label}</span> {axis.value}
                </span>
              ))}
            </span>
            {block.level && <span className="lc-pixel-readout-level">{block.level}</span>}
          </div>
          {block.note && <div className="lc-pixel-readout-note">{block.note}</div>}
          <dl className="lc-pixel-readout-rows">
            {block.rows.map((row) => (
              <div key={row.key} className="lc-pixel-readout-row" data-absent={row.absent || undefined}>
                <dt>
                  <span
                    className="lc-pixel-readout-swatch"
                    style={{ background: row.colormap ? rampGradient(row.colormap, 96) : row.color }}
                    data-label={row.colormap ? undefined : true}
                    aria-hidden
                  />
                  {row.name}
                </dt>
                <dd>
                  {row.value}
                  {row.detail && <span className="lc-pixel-readout-detail">{row.detail}</span>}
                  {row.level && <span className="lc-pixel-readout-level"> {row.level}</span>}
                  {row.position && <span className="lc-pixel-readout-at">{row.position}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  ));
}

/** The view pane under a client point, if any. */
function paneAt(root: HTMLElement, at: ClientPoint): HTMLElement | null {
  for (const pane of root.querySelectorAll<HTMLElement>("[data-view-pane]")) {
    const rect = pane.getBoundingClientRect();
    if (at.clientX >= rect.left && at.clientX < rect.right && at.clientY >= rect.top && at.clientY < rect.bottom) {
      return pane;
    }
  }
  return null;
}

/**
 * The pointer at a client point over `pane`, or null off every view. Placed
 * on the canvas, as the worker reads a point of the frame it drew.
 */
function pointerOver(
  pane: HTMLElement | null,
  canvas: HTMLCanvasElement,
  at: ClientPoint,
  touch: boolean,
  atMs: number,
): HoverPointer | null {
  if (!pane || canvas.clientWidth === 0 || canvas.clientHeight === 0) return null;
  const bounds = canvas.getBoundingClientRect();
  return {
    view: Number(pane.dataset.viewPane),
    x: (at.clientX - bounds.left) / canvas.clientWidth,
    y: (at.clientY - bounds.top) / canvas.clientHeight,
    touch,
    atMs,
  };
}

/** The axis `view` stands at a position on: a slice view's cut, and Z in a volume. */
function viewCutAxis(scene: WasmScene, view: number): SpatialAxis {
  return scene.view_camera_mode(view) === "slice" ? cutAxis(scene.slice_plane(view) as SlicePlane) : "z";
}

/** Names, types and colors for the readout, from the scene and the manifests. */
function readoutContext(scene: WasmScene, datasets: Map<string, DatasetState>, layers: ResolvedLayers): ReadoutContext {
  let settings: Record<string, { channel_settings?: { name?: string }[] }> = {};
  try {
    settings = JSON.parse(scene.all_dataset_settings());
  } catch {
    // Unreadable settings leave the manifest's channel names.
  }
  const multiscale = (id: string) => datasets.get(id)?.manifest.images[0]?.multiscale;
  const labels = new Map<string, ReadoutLabel | null>();
  return {
    datasetName: (id) => {
      try {
        return scene.dataset_name(id) || datasets.get(id)?.name || id;
      } catch {
        return datasets.get(id)?.name ?? id;
      }
    },
    entityName: (id, entityId) => {
      const manifest = datasets.get(id)?.manifest;
      if (!manifest || manifest.kind === "Single") return null;
      const entity = manifest.entities.find((e) => e.id === entityId);
      const parent = entity?.parent ? manifest.entities.find((e) => e.id === entity.parent) : undefined;
      const name = entity?.labels.name ?? parent?.labels.name;
      return typeof name === "string" && name.trim() ? name : null;
    },
    dataType: (id) => multiscale(id)?.data_type ?? "uint16",
    depth: (id) => multiscale(id)?.levels[0]?.shape[Axis.Z] ?? 1,
    channel: (id, channel) => ({
      name: channelDisplayName(
        channel,
        settings[id]?.channel_settings?.[channel]?.name,
        multiscale(id)?.channel_infos?.[channel]?.label,
      ),
      colormap: layers.get(id)?.channels.find((c) => c.channel === channel)?.colormap ?? "gray",
    }),
    label: (id, labelImageId) => {
      const key = `${id}\u0000${labelImageId}`;
      if (!labels.has(key)) {
        const spec = datasets.get(id)?.manifest.labels?.find((l) => l.image.image_id === labelImageId);
        labels.set(key, spec ? readoutLabel(spec.name, spec.colors ?? [], spec.names ?? []) : null);
      }
      return labels.get(key) ?? null;
    },
  };
}

/**
 * A label overlay as the readout shows it. Its id colors follow the draw: the
 * shader holds the first declared colors only, and the first entry for an id
 * wins.
 */
function readoutLabel(
  name: string,
  colors: readonly { value: number; rgba: RGBA }[],
  names: readonly { value: number; name: string }[],
): ReadoutLabel {
  const declared = new Map<number, RGBA>();
  for (const { value, rgba } of colors.slice(0, MAX_GPU_LABEL_COLORS)) {
    if (!declared.has(value)) declared.set(value, rgba);
  }
  const named = new Map<number, string>();
  for (const entry of names) {
    if (!named.has(entry.value)) named.set(entry.value, entry.name);
  }
  return {
    name,
    idName: (id: number) => named.get(id) ?? null,
    color: (id: number) => {
      const [r, g, b, a] = labelColor(id, declared);
      return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
    },
  };
}
