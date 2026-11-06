import { CloudIcon, FolderIcon, XIcon } from "@phosphor-icons/react";
import { is_local_dataset_url, normalize_dataset_url } from "lucida-core";
import { useId } from "react";
import { IconButton } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { useShortcut } from "../ui/shortcuts.ts";
import { BrowsePane } from "./BrowsePane.tsx";
import {
  forgetRecentSource,
  rememberRecentSource,
  sourceName,
  useRecentSources,
} from "./recentSources.ts";
import { ADD_DATA_SHORTCUT } from "./shortcut.ts";
import { SourceField } from "./SourceField.tsx";
import "./AddDataDialog.css";

export interface AddDataDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Open a dataset into the workspace. `url` is canonical. */
  onOpen: (url: string) => void;
  /** Create a new workspace from datasets collected in the browser. */
  onCreateWorkspace?: (paths: string[]) => void;
}

/**
 * The one way to add data: a path or URL, a recent dataset, or the file
 * browser. `Mod+O` opens it; it closes as soon as an open is sent, and the
 * canvas's banners carry the progress or the failure from there.
 */
export function AddDataDialog({ isOpen, onOpenChange, onOpen, onCreateWorkspace }: AddDataDialogProps) {
  const headingId = useId();
  useShortcut({
    id: "data.add",
    keys: [ADD_DATA_SHORTCUT],
    label: "Add data",
    group: "General",
    onTrigger: () => onOpenChange(true),
  });

  return (
    <Dialog title="Add data" size="lg" isOpen={isOpen} onOpenChange={onOpenChange}>
      {(close) => {
        const open = (url: string) => {
          const canonical = normalize_dataset_url(url);
          rememberRecentSource(canonical);
          onOpen(canonical);
          close();
        };
        return (
          <div className="lc-add-data">
            <SourceField autoFocus onSubmit={open} />
            <RecentSources onOpen={open} />
            <section className="lc-add-data-browse" aria-labelledby={`${headingId}-browse`}>
              <h3 id={`${headingId}-browse`} className="lc-add-data-heading">
                Browse files
              </h3>
              <BrowsePane
                className="lc-add-data-browse-pane"
                onOpen={open}
                onCreateWorkspace={
                  onCreateWorkspace &&
                  ((paths) => {
                    onCreateWorkspace(paths);
                    close();
                  })
                }
              />
            </section>
          </div>
        );
      }}
    </Dialog>
  );
}

function RecentSources({ onOpen }: { onOpen: (url: string) => void }) {
  const sources = useRecentSources();
  const headingId = useId();
  if (sources.length === 0) return null;
  return (
    <section className="lc-add-data-recent" aria-labelledby={headingId}>
      <h3 id={headingId} className="lc-add-data-heading">
        Recent
      </h3>
      <ul className="lc-add-data-recent-list">
        {sources.map((url) => {
          const name = sourceName(url);
          const SourceIcon = is_local_dataset_url(url) ? FolderIcon : CloudIcon;
          return (
            <li key={url} className="lc-add-data-recent-item">
              <button type="button" className="lc-add-data-recent-open" title={url} onClick={() => onOpen(url)}>
                <SourceIcon size={16} aria-hidden />
                <span className="lc-add-data-recent-name">{name}</span>
                <span className="lc-add-data-recent-url">
                  <span dir="ltr">{url}</span>
                </span>
              </button>
              <IconButton
                icon={XIcon}
                label={`Remove ${name} from recent`}
                size="sm"
                onPress={() => forgetRecentSource(url)}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
