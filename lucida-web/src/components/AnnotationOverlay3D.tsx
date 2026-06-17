/**
 * DOM overlay that renders collaborative annotation pins as markers in the 3D
 * volume view.
 *
 * This is the 3D counterpart to {@link AnnotationOverlay} (which owns the 2D
 * slice view and its comment-thread UI). It is deliberately minimal — just the
 * pin markers — so the rich thread UI lives in exactly one place (the 2D
 * overlay) while the 3D view shows where each pin sits in the volume.
 *
 * Like the peer-cursor 3D path (`PeerCursors`), each marker is re-projected
 * from the pin's world point every animation frame using the renderer's own
 * camera machinery. Rather than reproject by hand, it calls
 * `scene.project_annotation(datasetId, x, y, z)`, which lifts the pin's stored
 * in-plane-voxel + voxel-depth point to world space through the SAME rendering
 * transform the volume render pass uses, then projects it with the active
 * camera. That keeps a marker glued to its voxel as the camera orbits, and the
 * call returns an empty result when the point is behind the camera — so a
 * marker naturally hides as it swings behind the volume.
 *
 * Authoritative pin state lives in the WASM scene; this component reads it via
 * `scene.annotations(datasetId)` and never owns a parallel copy. `version` (the
 * remote-document version) bumps whenever a pin is added/removed, re-running the
 * read.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import type { Annotation } from "./AnnotationOverlay.tsx";
import { annotationVertices, isClosedShape, type ScreenPoint } from "./annotationGeometry.ts";

interface Props {
  /** The dataset whose pins to show (annotations are scoped per dataset). */
  datasetId: string;
  wasmSceneRef: RefObject<WasmScene | null>;
  canvas: HTMLCanvasElement;
  /** Bumped whenever the remote document changes; re-reads the pin set. */
  version: number;
  /** Local client id; the author's own pins are tinted distinctly. */
  myId: number;
}

function readAnnotations(scene: WasmScene | null, datasetId: string): Annotation[] {
  if (!scene) return [];
  try {
    const json = scene.annotations(datasetId);
    const parsed = JSON.parse(json) as Annotation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function AnnotationOverlay3D({ datasetId, wasmSceneRef, canvas, version, myId }: Props) {
  const dotRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // SVG geometry element per line/box, re-projected each frame through the SAME
  // `project_annotation` call the dots use — so a line/box tracks the volume as
  // the camera orbits, just like a point marker.
  const shapeRefs = useRef<Map<string, SVGLineElement | SVGPolygonElement>>(new Map());
  const [annotations, setAnnotations] = useState<Annotation[]>([]);

  // Re-read the authoritative pin set from WASM whenever the document version
  // or the scoped dataset changes. Reading happens in an effect (never during
  // render) so we don't touch the scene ref mid-render. The RAF tick below only
  // repositions existing DOM nodes; it does not re-read or allocate.
  useEffect(() => {
    setAnnotations(readAnnotations(wasmSceneRef.current, datasetId));
  }, [wasmSceneRef, datasetId, version]);

  // Mirror the latest pins into a ref so the RAF loop reads them without
  // remounting when the set changes — the same render-phase, write-only mirror
  // pattern PeerCursors and AnnotationOverlay use.
  const annotationsRef = useRef(annotations);
  // eslint-disable-next-line react-hooks/refs
  annotationsRef.current = annotations;
  const datasetIdRef = useRef(datasetId);
  // eslint-disable-next-line react-hooks/refs
  datasetIdRef.current = datasetId;

  useEffect(() => {
    let rafId: number;
    const tick = () => {
      const scene = wasmSceneRef.current;
      if (scene) {
        const dpr = devicePixelRatio;
        const ds = datasetIdRef.current;
        // The single per-vertex projection every kind reuses: lift (x, y, z) to
        // world and project via the renderer's camera. An empty result means the
        // vertex is behind the camera (or the dataset has no anchorable member).
        // project_annotation returns physical pixels; divide by DPR for CSS. The
        // shared depth `z` applies to every vertex of a line/box.
        const project = (v: ScreenPoint, z: number): ScreenPoint | null => {
          const proj = scene.project_annotation(ds, v[0], v[1], z);
          return proj.length < 2 ? null : [proj[0] / dpr, proj[1] / dpr];
        };
        for (const pin of annotationsRef.current) {
          const pinZ = pin.z ?? 0;
          const verts = annotationVertices(pin);
          const projected: (ScreenPoint | null)[] = verts.map((v) => project(v, pinZ));
          // If ANY vertex is behind the camera, hide the whole shape + dot — a
          // partially-projected line/box would streak across the screen.
          const allVisible = projected.every((p) => p !== null);

          const el = dotRefs.current.get(pin.id);
          if (el) {
            const anchor = projected[0];
            if (!allVisible || !anchor) {
              el.style.display = "none";
            } else {
              el.style.display = "";
              el.style.transform = `translate(${anchor[0]}px, ${anchor[1]}px)`;
            }
          }

          const shape = shapeRefs.current.get(pin.id);
          if (shape) {
            if (!allVisible) {
              shape.style.display = "none";
            } else {
              shape.style.display = "";
              const pts = projected as ScreenPoint[];
              if (isClosedShape(pin)) {
                (shape as SVGPolygonElement).setAttribute(
                  "points",
                  pts.map((p) => `${p[0]},${p[1]}`).join(" "),
                );
              } else if (pts.length >= 2) {
                const line = shape as SVGLineElement;
                line.setAttribute("x1", String(pts[0][0]));
                line.setAttribute("y1", String(pts[0][1]));
                line.setAttribute("x2", String(pts[1][0]));
                line.setAttribute("y2", String(pts[1][1]));
              }
            }
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [wasmSceneRef, canvas]);

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        // Markers are informational in 3D; the layer never blocks camera
        // orbit/zoom or the shift-click pin drop handled on the canvas.
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: 10,
      }}
    >
      {/* Line/box geometry, projected per-vertex through the volume transform
          every frame (see the tick). Starts hidden so nothing flashes at the
          origin before the first projection. */}
      <svg
        width="100%"
        height="100%"
        style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", overflow: "visible" }}
      >
        {annotations.map((pin) => {
          if (pin.kind !== "line" && pin.kind !== "box") return null;
          if (!pin.end) return null;
          const color = pin.author === String(myId) ? "#FF3B30" : "#FF9F0A";
          if (isClosedShape(pin)) {
            return (
              <polygon
                key={pin.id}
                ref={(el) => {
                  if (el) shapeRefs.current.set(pin.id, el);
                  else shapeRefs.current.delete(pin.id);
                }}
                points=""
                fill={color}
                fillOpacity={0.12}
                stroke={color}
                strokeWidth={2.5}
                strokeLinejoin="round"
                style={{ display: "none" }}
              />
            );
          }
          return (
            <line
              key={pin.id}
              ref={(el) => {
                if (el) shapeRefs.current.set(pin.id, el);
                else shapeRefs.current.delete(pin.id);
              }}
              x1={0}
              y1={0}
              x2={0}
              y2={0}
              stroke={color}
              strokeWidth={2.5}
              strokeLinecap="round"
              style={{ display: "none" }}
            />
          );
        })}
      </svg>
      {annotations.map((pin) => {
        const mine = pin.author === String(myId);
        return (
          <div
            key={pin.id}
            ref={(el) => {
              if (el) dotRefs.current.set(pin.id, el);
              else dotRefs.current.delete(pin.id);
            }}
            // Start hidden; the RAF tick reveals + positions it once projected,
            // so a marker never flashes at the origin for a frame.
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              display: "none",
              transform: "translate(0px, 0px)",
              willChange: "transform",
              pointerEvents: "none",
            }}
          >
            <div
              title={mine ? "Pin by you" : `Pin by ${pin.author}`}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: 12,
                height: 12,
                marginLeft: -6,
                marginTop: -6,
                borderRadius: "50%",
                backgroundColor: "#FF3B30",
                border: "2px solid white",
                boxShadow: "0 1px 3px rgba(0,0,0,0.6)",
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
