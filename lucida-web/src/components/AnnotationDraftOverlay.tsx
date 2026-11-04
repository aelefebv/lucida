/**
 * Live preview of a box or line while it is being drawn. The canvas gesture
 * writes the in-progress shape into a shared ref and this draws it each frame.
 *
 * Screen space is correct because a shift-drag draws and never moves the
 * camera, so raw pointer coords match where the committed shape lands. One
 * overlay serves both 2D and 3D.
 */
import { useEffect, useRef, type RefObject } from "react";
import { type AnnotationDraft, draftBoxRect } from "./annotationDraft.ts";

interface Props {
  /** Shared with the canvas gesture handlers; they write the live draw here. */
  draftRef: RefObject<AnnotationDraft | null>;
  /** Personal annotation visibility; false draws nothing. */
  visible?: boolean;
}

// Matches a freshly created own shape in AnnotationOverlay.
const DRAFT_COLOR = "#FF3B30";
const DRAFT_STROKE = 2.5;

export function AnnotationDraftOverlay({ draftRef, visible = true }: Props) {
  const rectRef = useRef<SVGRectElement>(null);
  const lineRef = useRef<SVGLineElement>(null);

  useEffect(() => {
    let rafId: number;
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
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [draftRef, visible]);

  return (
    <div
      style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "hidden", zIndex: 11 }}
    >
      <svg width="100%" height="100%" style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", overflow: "visible" }}>
        <rect ref={rectRef} style={{ display: "none" }} fill={DRAFT_COLOR} fillOpacity={0.12} stroke={DRAFT_COLOR} strokeWidth={DRAFT_STROKE} strokeLinejoin="round" />
        <line ref={lineRef} style={{ display: "none" }} stroke={DRAFT_COLOR} strokeWidth={DRAFT_STROKE} strokeLinecap="round" />
      </svg>
    </div>
  );
}
