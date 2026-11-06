import { ShareToolbarButton } from "../components/ShareToolbarButton.tsx";
import type { SavedView } from "../savedView/types.ts";
import "./BottomToolbar.css";

export type AnnotationKind = "point" | "line" | "box";

export interface BottomToolbarProps {
  /** The live view, for the link the share button copies. */
  getCurrentSavedView: () => SavedView | null;
  /** Which shape a shift-drag on the canvas draws. */
  annotationKind: AnnotationKind;
  onAnnotationKindChange: (kind: AnnotationKind) => void;
  annotationsVisible: boolean;
  onToggleAnnotations: () => void;
}

/** The viewer's remaining toolbar, in a slim bar under the canvas. */
export function BottomToolbar({
  getCurrentSavedView,
  annotationKind,
  onAnnotationKindChange,
  annotationsVisible,
  onToggleAnnotations,
}: BottomToolbarProps) {
  return (
    <div className="lc-bottom-toolbar" role="toolbar" aria-label="Viewer toolbar">
      <ShareToolbarButton getCurrentSavedView={getCurrentSavedView} />
      <label
        className="lc-bottom-toolbar-label"
        title="Shape drawn by shift-drag on the canvas (point = click, line/box = drag)"
      >
        Annotate
        <select
          aria-label="Annotation shape"
          value={annotationKind}
          onChange={(e) => onAnnotationKindChange(e.target.value as AnnotationKind)}
        >
          <option value="point">Point</option>
          <option value="line">Line</option>
          <option value="box">Box</option>
        </select>
      </label>
      {/* The aria-label and title name the next action, so the control reads
          correctly in either state. */}
      <button
        data-testid="annot-visibility-toggle"
        onClick={onToggleAnnotations}
        aria-pressed={!annotationsVisible}
        aria-label={annotationsVisible ? "Hide annotations" : "Show annotations"}
        title={annotationsVisible ? "Hide annotations" : "Show annotations"}
      >
        {annotationsVisible ? "Hide Annotations" : "Show Annotations"}
      </button>
    </div>
  );
}
