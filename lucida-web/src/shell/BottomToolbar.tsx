import { useState } from "react";
import "./BottomToolbar.css";

export type AnnotationKind = "point" | "line" | "box";

export interface BottomToolbarProps {
  /** Opens a dataset by path or URL. */
  onOpenUrl: (url: string) => void;
  /** True while a dataset opens; the open controls wait. */
  loading: boolean;
  /** Opens the file browser. */
  onBrowse: () => void;
  /** Which shape a shift-drag on the canvas draws. */
  annotationKind: AnnotationKind;
  onAnnotationKindChange: (kind: AnnotationKind) => void;
  annotationsVisible: boolean;
  onToggleAnnotations: () => void;
}

/** The viewer's remaining toolbar, in a slim bar under the canvas. */
export function BottomToolbar({
  onOpenUrl,
  loading,
  onBrowse,
  annotationKind,
  onAnnotationKindChange,
  annotationsVisible,
  onToggleAnnotations,
}: BottomToolbarProps) {
  const [url, setUrl] = useState("");
  const open = () => {
    onOpenUrl(url);
    setUrl("");
  };

  return (
    <div className="lc-bottom-toolbar" role="toolbar" aria-label="Viewer toolbar">
      <input
        type="text"
        className="lc-bottom-toolbar-url"
        placeholder="Enter dataset path or gs:// URL"
        aria-label="Dataset path or URL"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") open();
        }}
        disabled={loading}
      />
      <button onClick={open} disabled={loading || !url.trim()}>
        {loading ? "Loading..." : "Open"}
      </button>
      <button onClick={onBrowse} disabled={loading}>
        Browse Local
      </button>
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
