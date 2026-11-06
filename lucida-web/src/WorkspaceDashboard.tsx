import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  CloudIcon,
  CopyIcon,
  DotsThreeIcon,
  FolderIcon,
  FolderOpenIcon,
  LinkIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  PushPinIcon,
  SquaresFourIcon,
  type Icon,
  type IconProps,
} from "@phosphor-icons/react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { BrowsePane } from "./addData/BrowsePane.tsx";
import { rememberRecentSource } from "./addData/recentSources.ts";
import { ADD_DATA_SHORTCUT } from "./addData/shortcut.ts";
import { SourceField } from "./addData/SourceField.tsx";
import { ProfileMenu } from "./auth/ProfileMenu.tsx";
import { isRemoteDatasetUrl, shortDatasetLocations } from "./datasetLocation.ts";
import { relativeTimeFromIso } from "./savedView/useBookmarks.ts";
import { LucidaMark } from "./shell/LucidaMark.tsx";
import { SettingsMenu } from "./shell/SettingsMenu.tsx";
import { Badge } from "./ui/Badge.tsx";
import { Button, IconButton } from "./ui/Button.tsx";
import { useCommand } from "./ui/commands.ts";
import { Dialog } from "./ui/Dialog.tsx";
import { KeyboardHelp } from "./ui/KeyboardHelp.tsx";
import { Menu, MenuItem } from "./ui/Menu.tsx";
import { SegmentedControl } from "./ui/SegmentedControl.tsx";
import { SearchField } from "./ui/TextField.tsx";
import { toast } from "./ui/toastQueue.ts";
import { initWasmOnce } from "./wasmInit.ts";
import {
  archiveWorkspace,
  createWorkspace,
  duplicateWorkspace,
  listArchivedWorkspaces,
  listWorkspaces,
  restoreWorkspace,
  updateWorkspacePin,
  type WorkspaceRole,
  type WorkspaceSummary,
} from "./workspaceApi.ts";
import { sortWorkspaceDashboardRows } from "./workspaceDashboardOrder.ts";
import { createWorkspaceFromDatasets } from "./workspaceFromDataset.ts";
import { WorkspacePreview } from "./workspacePreview/WorkspacePreview.tsx";
import "./WorkspaceDashboard.css";

interface Props {
  /** Open a workspace. The viewer auto-opens any `datasetUrls` once
   *  connected. */
  onOpenWorkspace: (id: string, datasetUrls?: readonly string[]) => void;
}

type Shelf = "active" | "archived";

const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Owner",
  editor: "Editor",
  viewer: "Viewer",
};

const PushPinFilledIcon = forwardRef<SVGSVGElement, IconProps>((props, ref) => (
  <PushPinIcon ref={ref} weight="fill" {...props} />
)) as Icon;

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function workspaceHref(id: string): string {
  return `/w/${encodeURIComponent(id)}`;
}

export function WorkspaceDashboard({ onOpenWorkspace }: Props) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [shelf, setShelf] = useState<Shelf>("active");
  // Bumped to fetch the current shelf again without switching it.
  const [reloads, setReloads] = useState(0);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  // One flag for every create (blank, typed path, browsed files), so a second
  // create cannot start while the first is in flight.
  const [creating, setCreating] = useState(false);
  // Cards with a pin, archive, restore, or duplicate in flight.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [browseOpen, setBrowseOpen] = useState(false);
  // The path field checks input with the wasm build, which the viewer would
  // otherwise load only once a workspace opens.
  const [wasmReady, setWasmReady] = useState(false);
  const openDataRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  useEffect(() => {
    let cancelled = false;
    initWasmOnce().then(
      () => {
        if (!cancelled) setWasmReady(true);
      },
      (e: unknown) => {
        if (!cancelled) setError(`Couldn't load the path checker: ${messageOf(e)}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = shelf === "archived" ? listArchivedWorkspaces : listWorkspaces;
    void load()
      .then((rows) => {
        if (!cancelled) setWorkspaces(rows);
      })
      .catch((e) => {
        if (!cancelled) setError(messageOf(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [shelf, reloads]);

  // Labeled across every loaded workspace, not just the matches, so a label
  // holds still while a search narrows the grid.
  const locations = useMemo(() => {
    const placed = workspaces.filter((w) => w.first_dataset_url);
    const labels = shortDatasetLocations(placed.map((w) => w.first_dataset_url as string));
    return new Map(placed.map((w, i) => [w.id, labels[i]]));
  }, [workspaces]);

  const visible = useMemo(() => {
    // The archived list arrives most recently archived first; keep that.
    const ordered = shelf === "archived" ? workspaces : sortWorkspaceDashboardRows(workspaces);
    const q = query.trim().toLocaleLowerCase();
    if (!q) return ordered;
    return ordered.filter(
      (w) =>
        w.name.toLocaleLowerCase().includes(q) ||
        (w.first_dataset_url ?? "").toLocaleLowerCase().includes(q),
    );
  }, [query, shelf, workspaces]);

  const pinned = shelf === "active" ? visible.filter((w) => w.pinned_at) : [];
  const others = shelf === "active" ? visible.filter((w) => !w.pinned_at) : visible;

  const switchShelf = (next: Shelf) => {
    if (next === shelf) return;
    setLoading(true);
    setWorkspaces([]);
    setShelf(next);
  };

  const withCard = useCallback(async (id: string, action: () => Promise<void>) => {
    setBusyIds((ids) => new Set(ids).add(id));
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusyIds((ids) => {
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const workspace = await createWorkspace();
      onOpenWorkspace(workspace.id);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setCreating(false);
    }
  }, [onOpenWorkspace]);

  // Only the create step can fail here, and it stays on the dashboard. A failed
  // dataset open surfaces in the viewer and keeps the workspace.
  const handleOpenData = useCallback(
    async (urls: readonly string[]) => {
      const cleaned = urls.map((u) => u.trim()).filter((u) => u.length > 0);
      if (cleaned.length === 0) return;
      setCreating(true);
      setError(null);
      try {
        const workspace = await createWorkspaceFromDatasets(cleaned);
        onOpenWorkspace(workspace.id, cleaned);
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setCreating(false);
      }
    },
    [onOpenWorkspace],
  );

  const handlePin = (workspace: WorkspaceSummary, pin: boolean) =>
    withCard(workspace.id, async () => {
      const state = await updateWorkspacePin(workspace.id, pin);
      setWorkspaces((rows) =>
        rows.map((row) =>
          row.id === workspace.id
            ? {
              ...row,
              last_opened_at: state.last_opened_at ?? row.last_opened_at,
              pinned_at: state.pinned_at,
            }
            : row,
        ),
      );
    });

  const handleRestore = (workspace: WorkspaceSummary) =>
    withCard(workspace.id, async () => {
      await restoreWorkspace(workspace.id);
      setWorkspaces((rows) => rows.filter((row) => row.id !== workspace.id));
    });

  const handleArchive = (workspace: WorkspaceSummary) =>
    withCard(workspace.id, async () => {
      await archiveWorkspace(workspace.id);
      setWorkspaces((rows) => rows.filter((row) => row.id !== workspace.id));
      toast({
        title: `Archived ${workspace.name}`,
        description: "It's under Archived until you restore it.",
        action: {
          label: "Undo",
          onPress: () => {
            restoreWorkspace(workspace.id).then(
              () => setReloads((n) => n + 1),
              (e: unknown) => toast({ title: "Couldn't restore it", description: messageOf(e), tone: "danger" }),
            );
          },
        },
        timeout: 8000,
      });
    });

  // Copy any accessible workspace into one the user owns, then open it.
  const handleDuplicate = (workspace: WorkspaceSummary) =>
    withCard(workspace.id, async () => {
      const copy = await duplicateWorkspace(workspace.id);
      onOpenWorkspace(copy.id);
    });

  const copyLink = async (workspace: WorkspaceSummary) => {
    const link = `${window.location.origin}${workspaceHref(workspace.id)}`;
    try {
      // Absent outside a secure context, which throws here like a refusal.
      await navigator.clipboard.writeText(link);
      toast({ title: "Link copied", tone: "success" });
    } catch {
      toast({ title: "Couldn't copy the link", description: link, tone: "danger" });
    }
  };

  const focusOpenData = () => openDataRef.current?.querySelector("input")?.focus();

  useCommand({
    id: "dashboard.openData",
    label: "Open data…",
    group: "General",
    keywords: ["dataset", "path", "url", "add", "new workspace"],
    keys: [ADD_DATA_SHORTCUT],
    run: focusOpenData,
  });
  useCommand({
    id: "dashboard.browseFiles",
    label: "Browse files…",
    group: "General",
    keywords: ["open", "dataset", "folder"],
    run: () => setBrowseOpen(true),
  });
  useCommand({
    id: "dashboard.newWorkspace",
    label: "New empty workspace",
    group: "General",
    keywords: ["create", "blank"],
    run: () => void handleCreate(),
    enabled: !creating,
  });

  const renderGrid = (rows: WorkspaceSummary[]) => (
    <ul className="lc-dashboard-grid">
      {rows.map((workspace) => (
        <WorkspaceCard
          key={workspace.id}
          workspace={workspace}
          location={locations.get(workspace.id) ?? null}
          archived={shelf === "archived"}
          busy={busyIds.has(workspace.id)}
          onOpen={() => onOpenWorkspace(workspace.id)}
          onPin={(pin) => void handlePin(workspace, pin)}
          onDuplicate={() => void handleDuplicate(workspace)}
          onArchive={() => void handleArchive(workspace)}
          onRestore={() => void handleRestore(workspace)}
          onCopyLink={() => void copyLink(workspace)}
        />
      ))}
    </ul>
  );

  return (
    <div className="lc-dashboard">
      <header className="lc-dashboard-header">
        <h1 className="lc-dashboard-brand">
          <LucidaMark size={24} />
          lucida
        </h1>
        <div className="lc-dashboard-header-end">
          <SettingsMenu />
          <ProfileMenu />
        </div>
      </header>

      <main className="lc-dashboard-main">
        <section className="lc-dashboard-open" aria-labelledby={`${headingId}-open`}>
          <h2 id={`${headingId}-open`} className="lc-dashboard-heading">
            Open data
          </h2>
          <p className="lc-dashboard-lede">Each dataset you open starts a new workspace.</p>
          <div ref={openDataRef} className="lc-dashboard-open-row" data-testid="new-workspace-from-dataset">
            <SourceField
              className="lc-dashboard-source"
              submitLabel={creating ? "Opening…" : "Open"}
              isDisabled={creating || !wasmReady}
              onSubmit={(url) => {
                rememberRecentSource(url);
                void handleOpenData([url]);
              }}
            />
            <Button icon={FolderOpenIcon} onPress={() => setBrowseOpen(true)} isDisabled={creating}>
              Browse files…
            </Button>
          </div>
        </section>

        <section className="lc-dashboard-workspaces" aria-labelledby={`${headingId}-workspaces`}>
          <div className="lc-dashboard-toolbar">
            <h2 id={`${headingId}-workspaces`} className="lc-dashboard-heading">
              Workspaces
            </h2>
            <SegmentedControl
              label="Show"
              size="sm"
              options={[
                { value: "active", label: "Active" },
                { value: "archived", label: "Archived" },
              ]}
              value={shelf}
              onChange={switchShelf}
            />
            <div className="lc-dashboard-toolbar-end">
              <SearchField
                className="lc-dashboard-search"
                label="Search workspaces"
                placeholder="Search workspaces"
                value={query}
                onChange={setQuery}
              />
              {shelf === "active" && (
                <Button icon={PlusIcon} onPress={() => void handleCreate()} isDisabled={creating}>
                  New workspace
                </Button>
              )}
            </div>
          </div>

          {error && (
            <div className="lc-dashboard-error" role="alert">
              <span>{error}</span>
              <Button size="sm" variant="ghost" onPress={() => setError(null)}>
                Dismiss
              </Button>
            </div>
          )}

          {loading ? (
            <p className="lc-dashboard-note" aria-busy="true">
              Loading workspaces…
            </p>
          ) : visible.length === 0 ? (
            <EmptyState
              kind={query.trim() ? "search" : shelf}
              query={query.trim()}
              onClearSearch={() => setQuery("")}
              onBrowse={() => setBrowseOpen(true)}
            />
          ) : (
            <>
              {pinned.length > 0 && (
                <section className="lc-dashboard-section" aria-labelledby={`${headingId}-pinned`}>
                  <h3 id={`${headingId}-pinned`} className="lc-dashboard-section-title">
                    Pinned
                  </h3>
                  {renderGrid(pinned)}
                </section>
              )}
              {others.length > 0 && (
                <section className="lc-dashboard-section" aria-labelledby={`${headingId}-others`}>
                  {/* Without a pinned section above, one heading over the lone grid adds nothing. */}
                  <h3
                    id={`${headingId}-others`}
                    className="lc-dashboard-section-title"
                    data-hidden={pinned.length === 0 || undefined}
                  >
                    {shelf === "archived" ? "Archived" : "Recent"}
                  </h3>
                  {renderGrid(others)}
                </section>
              )}
            </>
          )}
        </section>
      </main>

      <Dialog title="Browse files" size="lg" isOpen={browseOpen} onOpenChange={setBrowseOpen}>
        {(close) => (
          <BrowsePane
            className="lc-dashboard-browse"
            onOpen={(path) => {
              close();
              void handleOpenData([path]);
            }}
            onCreateWorkspace={(paths) => {
              close();
              void handleOpenData(paths);
            }}
          />
        )}
      </Dialog>
      <KeyboardHelp />
    </div>
  );
}

interface WorkspaceCardProps {
  workspace: WorkspaceSummary;
  /** Where its first dataset lives, shortened; null without one. */
  location: string | null;
  archived: boolean;
  busy: boolean;
  onOpen: () => void;
  onPin: (pin: boolean) => void;
  onDuplicate: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onCopyLink: () => void;
}

function WorkspaceCard({
  workspace,
  location,
  archived,
  busy,
  onOpen,
  onPin,
  onDuplicate,
  onArchive,
  onRestore,
  onCopyLink,
}: WorkspaceCardProps) {
  const { name, role, dataset_count: count, first_dataset_url: url } = workspace;
  const isPinned = Boolean(workspace.pinned_at);
  const detailsId = useId();
  const LocationIcon = url && isRemoteDatasetUrl(url) ? CloudIcon : FolderIcon;
  const [when, timestamp] = archived && workspace.archived_at
    ? ["Archived", workspace.archived_at]
    : workspace.last_opened_at
      ? ["Opened", workspace.last_opened_at]
      : ["Updated", workspace.updated_at];

  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    // A modified click opens the workspace in a new tab, as a link should.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen();
  };

  return (
    <li className="lc-ws-card" data-pinned={isPinned || undefined} aria-busy={busy || undefined}>
      <WorkspacePreview workspaceId={workspace.id} updatedAt={workspace.preview_updated_at} />
      <div className="lc-ws-card-body">
        <div className="lc-ws-card-title">
          <a
            className="lc-ws-card-link"
            href={workspaceHref(workspace.id)}
            aria-label={`Open workspace ${name}`}
            aria-describedby={`${detailsId}-location ${detailsId}-meta`}
            onClick={open}
          >
            <span className="lc-ws-card-name" title={name}>
              {name}
            </span>
          </a>
          <div className="lc-ws-card-actions">
            {!archived && (
              <IconButton
                icon={isPinned ? PushPinFilledIcon : PushPinIcon}
                label={`Pin ${name}`}
                size="sm"
                isSelected={isPinned}
                onSelectedChange={onPin}
                isDisabled={busy}
              />
            )}
            <Menu
              label={`Actions for ${name}`}
              placement="bottom end"
              trigger={<IconButton icon={DotsThreeIcon} label={`More actions for ${name}`} size="sm" />}
            >
              {/* Duplicate is open to any role; the copy becomes the user's own. */}
              {!archived && (
                <MenuItem icon={CopyIcon} onAction={onDuplicate} isDisabled={busy}>
                  Duplicate
                </MenuItem>
              )}
              <MenuItem icon={LinkIcon} onAction={onCopyLink}>
                Copy link
              </MenuItem>
              {role === "owner" &&
                (archived ? (
                  <MenuItem icon={ArrowCounterClockwiseIcon} onAction={onRestore} isDisabled={busy}>
                    Restore
                  </MenuItem>
                ) : (
                  <MenuItem icon={ArchiveIcon} onAction={onArchive} isDisabled={busy}>
                    Archive
                  </MenuItem>
                ))}
            </Menu>
          </div>
        </div>
        <p id={`${detailsId}-location`} className="lc-ws-card-location" title={url ?? undefined}>
          {location ? (
            <>
              <LocationIcon size={14} aria-hidden />
              <span className="lc-ws-card-location-text">{location}</span>
            </>
          ) : (
            // A listing from an older server has the count but not where
            // the data lives.
            <span className="lc-ws-card-location-text" data-empty="">
              {count > 0 ? "Location unknown" : "No datasets yet"}
            </span>
          )}
        </p>
        <div id={`${detailsId}-meta`} className="lc-ws-card-meta">
          <span>
            {count} dataset{count === 1 ? "" : "s"}
          </span>
          <span aria-hidden="true">·</span>
          <time dateTime={timestamp} title={new Date(timestamp).toLocaleString()}>
            {when} {relativeTimeFromIso(timestamp)}
          </time>
          <Badge className="lc-ws-card-role">{ROLE_LABELS[role]}</Badge>
        </div>
      </div>
    </li>
  );
}

function EmptyState({
  kind,
  query,
  onClearSearch,
  onBrowse,
}: {
  kind: Shelf | "search";
  query: string;
  onClearSearch: () => void;
  onBrowse: () => void;
}) {
  if (kind === "search") {
    return (
      <div className="lc-dashboard-empty">
        <MagnifyingGlassIcon className="lc-dashboard-empty-icon" size={32} aria-hidden />
        <p className="lc-dashboard-empty-title">No workspaces match “{query}”</p>
        <p className="lc-dashboard-empty-text">Search looks at workspace names and where their data lives.</p>
        <Button variant="ghost" onPress={onClearSearch}>
          Clear search
        </Button>
      </div>
    );
  }
  if (kind === "archived") {
    return (
      <div className="lc-dashboard-empty">
        <ArchiveIcon className="lc-dashboard-empty-icon" size={32} aria-hidden />
        <p className="lc-dashboard-empty-title">Nothing archived</p>
        <p className="lc-dashboard-empty-text">
          Archiving a workspace takes it off your list without deleting it. Restore it from here.
        </p>
      </div>
    );
  }
  return (
    <div className="lc-dashboard-empty">
      <SquaresFourIcon className="lc-dashboard-empty-icon" size={32} aria-hidden />
      <p className="lc-dashboard-empty-title">No workspaces yet</p>
      <p className="lc-dashboard-empty-text">
        Open a dataset above to start one. A workspace keeps its datasets, saved views, and
        annotations together, and you can share it.
      </p>
      <Button icon={FolderOpenIcon} onPress={onBrowse}>
        Browse files…
      </Button>
    </div>
  );
}
