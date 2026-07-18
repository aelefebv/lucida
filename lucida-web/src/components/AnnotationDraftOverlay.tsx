/**
 * Live preview of a box/line annotation while it is being drawn.
 *
 * Creation gestures live on the canvas (SliceViewer in 2D, VolumeViewer in 3D)
 * and previously only committed the shape on pointer release, so a new box/line
 * popped into existence at the end instead of growing under the cursor — unlike
 * RESIZING an existing shape, which previews live. This overlay closes that gap:
 * the gesture publishes the in-progress shape (screen-space CSS px, relative to
 * the canvas) to a tiny external store. This component redraws only when that
 * value changes, then clears when the gesture ends and the real annotation is
 * committed.
 *
 * Screen-space (not world-space) is correct here because a shift-drag DRAWS — it
 * never pans/zooms (2D) or orbits (3D) — so the camera is static for the whole
 * gesture and the raw pointer coordinates line up with where the committed shape
 * lands on release. One screen-space overlay therefore serves both 2D and 3D.
 */
import { useSyncExternalStore } from "react";
import { type AnnotationDraftStore, draftBoxRect } from "./annotationDraft.ts";

interface Props {
  /** Shared with the canvas gesture handlers; they write the live draw here. */
  draft: AnnotationDraftStore;
  /** Personal annotation-visibility toggle; when false, draw nothing (matches
   * the annotation overlays hiding everything). */
  visible?: boolean;
}

// Own-annotation color + stroke, matching a freshly-created own shape in
// AnnotationOverlay so the preview reads as "this shape, growing".
const DRAFT_COLOR = "#FF3B30";
const DRAFT_STROKE = 2.5;

export function AnnotationDraftOverlay({ draft: store, visible = true }: Props) {
  const current = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const draft = visible ? current : null;
  const rect = draft?.kind === "box"
    ? draftBoxRect(draft.x0, draft.y0, draft.x1, draft.y1)
    : null;

  return (
    <div
      style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "hidden", zIndex: 11 }}
    >
      <svg width="100%" height="100%" style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", overflow: "visible" }}>
        {rect && (
          <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} fill={DRAFT_COLOR} fillOpacity={0.12} stroke={DRAFT_COLOR} strokeWidth={DRAFT_STROKE} strokeLinejoin="round" />
        )}
        {draft?.kind === "line" && (
          <line x1={draft.x0} y1={draft.y0} x2={draft.x1} y2={draft.y1} stroke={DRAFT_COLOR} strokeWidth={DRAFT_STROKE} strokeLinecap="round" />
        )}
      </svg>
    </div>
  );
}
