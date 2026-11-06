import { useState } from "react";
import { ShareToolbarButton } from "../components/ShareToolbarButton.tsx";
import type { SavedView } from "../savedView/types.ts";
import "./BottomToolbar.css";

export interface BottomToolbarProps {
  /** Opens a dataset by path or URL. */
  onOpenUrl: (url: string) => void;
  /** True while a dataset opens; the open controls wait. */
  loading: boolean;
  /** Opens the file browser. */
  onBrowse: () => void;
  /** The live view, for the link the share button copies. */
  getCurrentSavedView: () => SavedView | null;
}

/** The viewer's remaining toolbar, in a slim bar under the canvas. */
export function BottomToolbar({
  onOpenUrl,
  loading,
  onBrowse,
  getCurrentSavedView,
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
      <ShareToolbarButton getCurrentSavedView={getCurrentSavedView} />
    </div>
  );
}
