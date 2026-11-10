/**
 * The value under the pointer: hover the canvas with a mouse or pen, or rest a
 * finger on it, and a card beside the point lists each visible channel's
 * sample there in data units, with its position and the level it came from,
 * and each visible label overlay's id there, with the name its table gives it.
 *
 * The render worker reads the samples from what it draws (`worker/probe.ts`).
 * One probe is in flight at a time, and a new one goes out only when the
 * pointer moved or a frame was drawn since the last, so the readout follows
 * arriving data without asking for frames of its own.
 */

import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import type { WasmScene } from "lucida-core";
import type { RenderClient } from "../renderer/renderClient.ts";
import type { ProbeSample } from "../renderer/workerProtocol.ts";
import type { ResolvedLayers } from "../resolvedLayers.ts";
import type { DatasetState } from "../types.ts";
import { Axis } from "../axes.ts";
import { cutAxis, type SlicePlane } from "../renderer/slicePlane.ts";
import { frameClock } from "../frameClock.ts";
import { REVEAL_LINGER_MS } from "../ui/longPress.ts";
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

interface Props {
  canvas: HTMLCanvasElement;
  client: RenderClient;
  scene: WasmScene;
  datasets: Map<string, DatasetState>;
  layers: ResolvedLayers;
  ref?: Ref<PixelReadoutHandle>;
}

/** A point on the canvas in CSS pixels, and whether a finger put it there. */
interface Point {
  x: number;
  y: number;
  touch: boolean;
}

/** Gap between the point and the card, in CSS pixels. */
const OFFSET = 14;

export function PixelReadout({ canvas, client, scene, datasets, layers, ref }: Props) {
  const [shown, setShown] = useState<{ at: Point; samples: ProbeSample[] } | null>(null);
  const probe = useRef({
    pointer: null as Point | null,
    moved: false,
    inFlight: false,
    probedFrame: -1,
    linger: undefined as ReturnType<typeof setTimeout> | undefined,
  });

  const pointAt = (clientX: number, clientY: number, touch: boolean): Point => {
    const bounds = canvas.getBoundingClientRect();
    return { x: clientX - bounds.left, y: clientY - bounds.top, touch };
  };
  const point = (at: Point | null) => {
    const state = probe.current;
    clearTimeout(state.linger);
    state.pointer = at;
    state.moved = at !== null;
    if (at) frameClock.wake();
    else setShown(null);
  };

  useImperativeHandle(ref, () => ({
    pressAt: (at) => point(pointAt(at.clientX, at.clientY, true)),
  }));

  useEffect(() => {
    const state = probe.current;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "touch") point(pointAt(e.clientX, e.clientY, false));
    };
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType !== "touch") point(null);
    };
    // A finger that lands again starts over; one that lifts leaves the card a moment.
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "touch" && state.pointer?.touch) point(null);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !state.pointer?.touch) return;
      clearTimeout(state.linger);
      state.linger = setTimeout(() => point(null), REVEAL_LINGER_MS);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    return () => {
      clearTimeout(state.linger);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    };
    // `point` and `pointAt` read only refs and the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas]);

  useEffect(() => {
    const state = probe.current;
    return frameClock.subscribe(() => {
      const at = state.pointer;
      if (!at || state.inFlight) return;
      const frame = client.lastFrameSeq();
      if (!state.moved && frame === state.probedFrame) return;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return;
      state.moved = false;
      state.probedFrame = frame;
      state.inFlight = true;
      void client.probe(at.x / width, at.y / height).then((samples) => {
        state.inFlight = false;
        // The pointer may have left, or moved on, while the probe was out.
        if (state.pointer) setShown({ at, samples });
        if (state.moved) frameClock.wake();
      });
    });
  }, [client, canvas]);

  const context = useMemo(() => readoutContext(scene, datasets, layers), [scene, datasets, layers]);
  const blocks = useMemo(() => (shown ? readoutBlocks(shown.samples, context) : []), [shown, context]);
  if (!shown || blocks.length === 0) return null;

  const { at } = shown;
  return (
    <div
      className="lc-pixel-readout"
      role="tooltip"
      data-testid="pixel-readout"
      data-touch={at.touch || undefined}
      data-flip-x={(!at.touch && at.x > canvas.clientWidth * 0.6) || undefined}
      data-flip-y={(!at.touch && at.y > canvas.clientHeight * 0.6) || undefined}
      style={{ left: at.x, top: at.y, ["--lc-readout-offset" as string]: `${OFFSET}px` }}
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
  );
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
    // Read at each probe, since a plane switch moves no layer.
    cutAxis: () => (scene.camera_mode() === "slice" ? cutAxis(scene.slice_plane() as SlicePlane) : "z"),
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
