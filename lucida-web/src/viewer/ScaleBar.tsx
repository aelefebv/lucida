/**
 * A view's scale bar, in its pane's bottom-left corner. lucida-core reads
 * the lengths; this draws them, one bar across or, where the screen's axes
 * measure differently, an L whose arms are each labelled.
 *
 * It follows the camera on the frame clock and writes the DOM directly, so
 * a zoom moves it without rendering anything around it.
 */
import { useEffect, useRef } from "react";
import type { WasmScene } from "lucida-core";
import type { ViewSurface } from "../components/cameraProjection.ts";
import { frameClock } from "../frameClock.ts";
import { floatingControlBoxes } from "../shell/CanvasStage.tsx";
import { armLabel, parseScaleBar, type ScaleBarReading } from "./scaleBar.ts";
import { placeScaleBar, snapLength } from "./scaleBarPlacement.ts";
import "./ScaleBar.css";

interface Props {
  scene: WasmScene;
  surface: ViewSurface;
}

export function ScaleBar({ scene, surface }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLSpanElement>(null);
  const acrossRef = useRef<HTMLSpanElement>(null);
  const downRef = useRef<HTMLSpanElement>(null);
  const noteRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let drawn = "";
    let reading: ScaleBarReading | null = null;
    const tick = () => {
      const root = rootRef.current;
      const mark = markRef.current;
      const across = acrossRef.current;
      const down = downRef.current;
      const note = noteRef.current;
      if (!root || !mark || !across || !down || !note) return;
      const json = scene.scale_bar(surface.view);
      if (json !== drawn) {
        drawn = json;
        reading = parseScaleBar(json);
        if (reading) draw(reading, { mark, across, down, note });
      }
      root.hidden = reading === null;
      if (reading) place(root, surface.element);
    };
    return frameClock.subscribe(tick);
  }, [scene, surface]);

  return (
    <div ref={rootRef} className="lc-scale-bar" hidden>
      <span ref={markRef} className="lc-scale-bar-mark" />
      <span ref={downRef} className="lc-scale-bar-label" data-arm="down" />
      <span ref={acrossRef} className="lc-scale-bar-label" data-arm="across" />
      <span ref={noteRef} className="lc-scale-bar-note" />
    </div>
  );
}

interface Parts {
  mark: HTMLElement;
  across: HTMLElement;
  down: HTMLElement;
  note: HTMLElement;
}

/** Size the mark to the arms' lengths and write the labels. */
function draw(reading: ScaleBarReading, { mark, across, down, note }: Parts) {
  const corner = reading.down !== null;
  mark.dataset.shape = corner ? "corner" : "bar";
  mark.style.width = `${snapLength(reading.across.pixels)}px`;
  mark.style.height = reading.down ? `${snapLength(reading.down.pixels)}px` : "";
  across.textContent = armLabel(reading.across, corner);
  down.hidden = !reading.down;
  down.textContent = reading.down ? armLabel(reading.down, corner) : "";
  note.hidden = !reading.at_orbit_center;
  note.textContent = reading.at_orbit_center ? "at orbit center" : "";
}

/**
 * Put the bar in its pane's corner, clear of the stage's floating controls
 * and of the notices the pane shows, which announce themselves as status.
 */
function place(root: HTMLElement, pane: HTMLElement) {
  const obstacles = [
    ...floatingControlBoxes(pane),
    ...Array.from(pane.querySelectorAll(':scope > [role="status"]'), (notice) => notice.getBoundingClientRect()),
  ];
  const size = root.getBoundingClientRect();
  const at = placeScaleBar(pane.getBoundingClientRect(), size.width, size.height, obstacles);
  root.style.visibility = at ? "" : "hidden";
  if (!at) return;
  root.style.left = `${at.left}px`;
  root.style.top = `${at.top}px`;
}
