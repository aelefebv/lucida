import { BrowsePane } from "../addData/BrowsePane.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import "./FileBrowser.css";

interface FileBrowserProps {
  /** Open the dataset in the browsed folder. Optional, so the browser can
   *  serve only to create a workspace through `onCreateWorkspace`. */
  onSelect?: (path: string) => void;
  /** Create a workspace from the collected dataset paths. Given, the
   *  browser shows the selection controls. */
  onCreateWorkspace?: (paths: string[]) => void;
  onClose: () => void;
}

/** The browse pane alone in a dialog, closing after either action. */
export function FileBrowser({ onSelect, onCreateWorkspace, onClose }: FileBrowserProps) {
  return (
    <Dialog
      title="Browse files"
      size="lg"
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <BrowsePane
        className="lc-file-browser-pane"
        onOpen={
          onSelect &&
          ((path) => {
            onSelect(path);
            onClose();
          })
        }
        onCreateWorkspace={
          onCreateWorkspace &&
          ((paths) => {
            onCreateWorkspace(paths);
            onClose();
          })
        }
      />
    </Dialog>
  );
}
