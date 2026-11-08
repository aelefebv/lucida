import {
  ArrowBendLeftUpIcon,
  CaretRightIcon,
  CheckCircleIcon,
  FileIcon,
  FolderIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Button } from "../ui/Button.tsx";
import { UnstyledButton } from "../ui/UnstyledButton.tsx";
import "./BrowsePane.css";

interface BrowseEntry {
  name: string;
  type: "directory" | "file";
}

interface BrowseResponse {
  path: string;
  entries: BrowseEntry[];
}

const LAST_FOLDER_ENTRY = "lucida-browse-path";

export interface BrowsePaneProps {
  /** Open the dataset in the folder being browsed. */
  onOpen?: (path: string) => void;
  /**
   * Create a workspace from datasets collected across folders. Given, the
   * pane shows the selection controls.
   */
  onCreateWorkspace?: (paths: string[]) => void;
  className?: string;
}

/**
 * Browses the server's filesystem for a dataset. The server owns the root: an
 * empty path asks for the platform default, `/` on Unix or a list of drives
 * (response path `""`) on Windows. Entries join onto whatever path the server
 * returned with `/`, except at the empty root, where a drive must not become
 * `/c:`.
 */
export function BrowsePane({ onOpen, onCreateWorkspace, className }: BrowsePaneProps) {
  // Per tab, so the next dialog opens where the last one left off.
  const [currentPath, setCurrentPath] = useState(
    () => sessionStorage.getItem(LAST_FOLDER_ENTRY) ?? "",
  );
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const crumbsRef = useRef<HTMLElement>(null);
  // Moving through folders from the list replaces the row that had focus, so
  // focus goes to the new first row instead of falling out of the dialog.
  const refocusList = useRef(false);

  const hasDataset = entries.some((e) => e.name === "zarr.json");
  const multiSelect = Boolean(onCreateWorkspace);
  const alreadySelected = selected.includes(currentPath);

  const browse = useCallback(async (path: string): Promise<boolean> => {
    setLoading(true);
    setError(null);
    try {
      const url = path ? `/api/browse?path=${encodeURIComponent(path)}` : "/api/browse";
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || res.statusText);
      }
      const data: BrowseResponse = await res.json();
      setCurrentPath(data.path);
      setEntries(data.entries);
      sessionStorage.setItem(LAST_FOLDER_ENTRY, data.path);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      refocusList.current = false;
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The fetch is the effect; its loading flag is what the first paint shows.
    // A remembered folder may be gone, so fall back to the root, not an error.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void browse(currentPath).then((ok) => {
      if (!ok && currentPath) void browse("");
    });
    // Mount only: later navigation goes through `browse` directly.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const crumbs = crumbsRef.current;
    if (crumbs) crumbs.scrollLeft = crumbs.scrollWidth;
  }, [currentPath]);

  useEffect(() => {
    if (loading || !refocusList.current) return;
    refocusList.current = false;
    listRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [loading, entries]);

  const browseFromList = (path: string) => {
    refocusList.current = true;
    void browse(path);
  };

  const navigateInto = (name: string) => {
    // The Unix root already ends in `/`; `//name` would be a UNC path on Windows.
    const parent = currentPath === "" || currentPath.endsWith("/") ? currentPath : `${currentPath}/`;
    browseFromList(parent + name);
  };

  const navigateUp = () => {
    const stripped = currentPath.replace(/\/[^/]*$/, "");
    // `c:` strips to itself and `/foo` strips to `""`; both go up to the root.
    browseFromList(stripped === currentPath ? "" : stripped);
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = rows[event.key === "ArrowDown" ? at + 1 : Math.max(0, at - 1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  const addToSelection = () => {
    if (!hasDataset) return;
    setSelected((prev) => (prev.includes(currentPath) ? prev : [...prev, currentPath]));
  };

  const createWorkspace = () => {
    if (!onCreateWorkspace) return;
    // The folder on screen counts without an explicit Add, so a single
    // dataset is one click.
    const paths = hasDataset && !alreadySelected ? [...selected, currentPath] : selected;
    if (paths.length > 0) onCreateWorkspace(paths);
  };

  // Canonical paths are forward-slashed on every platform.
  const segments = currentPath.split("/").filter(Boolean);
  // Keeps Unix paths absolute and Windows paths in drive-letter form.
  const leadingSlash = currentPath.startsWith("/") ? "/" : "";
  const atRoot = currentPath === "" || currentPath === "/";
  // Beside an Open action, creating a workspace waits until something is collected.
  const showCreate = multiSelect && (!onOpen || selected.length > 0);

  return (
    <div className={className ? `lc-browse ${className}` : "lc-browse"}>
      <nav ref={crumbsRef} className="lc-browse-crumbs" aria-label="Folder path">
        <UnstyledButton className="lc-browse-crumb" onPress={() => void browse("")}>
          /
        </UnstyledButton>
        {segments.map((segment, i) => (
          <Fragment key={i}>
            <CaretRightIcon className="lc-browse-crumb-sep" size={12} aria-hidden />
            <UnstyledButton
              className="lc-browse-crumb"
              aria-current={i === segments.length - 1 ? "location" : undefined}
              onPress={() => void browse(leadingSlash + segments.slice(0, i + 1).join("/"))}
            >
              {segment}
            </UnstyledButton>
          </Fragment>
        ))}
      </nav>

      <div ref={listRef} className="lc-browse-list" aria-busy={loading} onKeyDown={onListKeyDown}>
        {loading ? (
          <p className="lc-browse-note">Loading…</p>
        ) : error ? (
          <p className="lc-browse-note" data-tone="danger" role="alert">
            Couldn't list this folder. {error}
          </p>
        ) : (
          <ul className="lc-browse-entries">
            {!atRoot && (
              <li>
                <UnstyledButton className="lc-browse-entry" aria-label="Up one folder" onPress={navigateUp}>
                  <ArrowBendLeftUpIcon size={16} aria-hidden />
                  <span>..</span>
                </UnstyledButton>
              </li>
            )}
            {entries.map((entry) =>
              entry.type === "directory" ? (
                <li key={entry.name}>
                  <UnstyledButton className="lc-browse-entry" onPress={() => navigateInto(entry.name)}>
                    <FolderIcon size={16} aria-hidden />
                    <span className="lc-browse-entry-name">{entry.name}</span>
                  </UnstyledButton>
                </li>
              ) : (
                <li key={entry.name} className="lc-browse-entry" data-kind="file">
                  <FileIcon size={16} aria-hidden />
                  <span className="lc-browse-entry-name">{entry.name}</span>
                </li>
              ),
            )}
            {entries.length === 0 && <li className="lc-browse-note">This folder is empty.</li>}
          </ul>
        )}
      </div>

      {multiSelect && selected.length > 0 && (
        <ul className="lc-browse-selection" data-testid="file-browser-selection" aria-label="Selected datasets">
          {selected.map((path) => (
            <li key={path} className="lc-browse-chip">
              <span className="lc-browse-chip-label" title={path}>
                {path}
              </span>
              <UnstyledButton
                className="lc-browse-chip-remove"
                aria-label={`Remove ${path} from selection`}
                onPress={() => setSelected((prev) => prev.filter((p) => p !== path))}
              >
                <XIcon size={12} aria-hidden />
              </UnstyledButton>
            </li>
          ))}
        </ul>
      )}

      <div className="lc-browse-footer">
        <span className="lc-browse-status" data-found={hasDataset || undefined}>
          {hasDataset ? (
            <>
              <CheckCircleIcon size={16} aria-hidden />
              Dataset found
            </>
          ) : (
            "Go to a folder that holds a zarr.json"
          )}
        </span>
        <div className="lc-browse-actions">
          {multiSelect && (
            <Button
              variant={onOpen ? "ghost" : "secondary"}
              onPress={addToSelection}
              isDisabled={!hasDataset || alreadySelected}
            >
              {alreadySelected ? "Added" : "Add to selection"}
            </Button>
          )}
          {onOpen && (
            <Button onPress={() => onOpen(currentPath)} isDisabled={!hasDataset}>
              Open
            </Button>
          )}
          {showCreate && (
            <Button
              variant="primary"
              onPress={createWorkspace}
              isDisabled={selected.length === 0 && !hasDataset}
            >
              {selected.length > 1
                ? `Create workspace (${selected.length})`
                : "Create workspace from selection"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
