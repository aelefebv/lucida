/**
 * Live preview of a box or line while it is being drawn. The canvas gesture
 * writes the in-progress shape into a shared ref and this draws it on the
 * frame clock.
 *
 * Screen space is correct because a shift-drag draws and never moves the
 * camera, so raw pointer coords match where the committed shape lands. One
 * overlay serves both 2D and 3D.
 */
import { useEffect, useRef, type RefObject } from "react";
import { type AnnotationDraft, draftBoxRect } from "./annotationDraft.ts";
import { frameClock } from "../frameClock.ts";
import "./AnnotationOverlay.css";

interface Props {
  /** Shared with the canvas gesture handlers; they write the live draw here. */
  draftRef: RefObject<AnnotationDraft | null>;
  /** Personal annotation visibility; false draws nothing. */
  visible?: boolean;
}

export function AnnotationDraftOverlay({ draftRef, visible = true }: Props) {
  const rectRef = useRef<SVGRectElement>(null);
  const lineRef = useRef<SVGLineElement>(null);

  useEffect(() => {
    const tick = () => {
      const rect = rectRef.current;
      const line = lineRef.current;
      const draft = visible ? draftRef.current : null;
      if (!draft) {
        if (rect) rect.style.display = "none";
        if (line) line.style.display = "none";
      } else if (draft.kind === "box") {
        if (line) line.style.display = "none";
        if (rect) {
          const r = draftBoxRect(draft.x0, draft.y0, draft.x1, draft.y1);
          rect.setAttribute("x", String(r.x));
          rect.setAttribute("y", String(r.y));
          rect.setAttribute("width", String(r.width));
          rect.setAttribute("height", String(r.height));
          rect.style.display = "";
        }
      } else {
        if (rect) rect.style.display = "none";
        if (line) {
          line.setAttribute("x1", String(draft.x0));
          line.setAttribute("y1", String(draft.y0));
          line.setAttribute("x2", String(draft.x1));
          line.setAttribute("y2", String(draft.y1));
          line.style.display = "";
        }
      }
    };
    // The draft moves only with the pointer, whose events wake the clock.
    return frameClock.subscribe(tick);
  }, [draftRef, visible]);

  // Drawn with the own-shape style, so the draft matches the shape it becomes.
  return (
    <div className="lc-annotation-layer" data-layer="draft">
      <svg className="lc-annotation-svg" width="100%" height="100%">
        <rect ref={rectRef} className="lc-annotation-shape" style={{ display: "none" }} />
        <line ref={lineRef} className="lc-annotation-shape" style={{ display: "none" }} />
      </svg>
    </div>
  );
}
