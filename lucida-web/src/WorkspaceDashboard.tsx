import { useCallback, useEffect, useMemo, useState } from "react";
import {
  archiveWorkspace,
  createWorkspace,
  duplicateWorkspace,
  listArchivedWorkspaces,
  listWorkspaces,
  restoreWorkspace,
  updateWorkspacePin,
  type WorkspaceSummary,
} from "./workspaceApi.ts";
import { createWorkspaceFromDatasets } from "./workspaceFromDataset.ts";
import { FileBrowser } from "./components/FileBrowser.tsx";
import { OperationStatus } from "./components/OperationStatus.tsx";
import { ProfileMenu } from "./auth/ProfileMenu.tsx";
import { useLatestOperation } from "./hooks/useLatestOperation.ts";
import { sortWorkspaceDashboardRows } from "./workspaceDashboardOrder.ts";
import "./WorkspaceDashboard.css";

// Every mutation in this lane creates a workspace and immediately navigates
// into it. Only one may be in flight: otherwise two successful creates race
// to decide which workspace the user sees. Other row mutations keep their own
// keys and can proceed independently without suppressing this navigation.
const CREATE_AND_OPEN_OPERATION_KEY = "create-and-open:workspace";

interface Props {
  /** Open a workspace. When `datasetUrls` is given (create-from-dataset flow,
   *  #697), the viewer auto-opens those datasets once connected. */
  onOpenWorkspace: (id: string, datasetUrls?: readonly string[]) => void;
}

export function WorkspaceDashboard({ onOpenWorkspace }: Props) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  // "New workspace from dataset" composer (#697): the typed URL/path and a
  // shared in-flight flag (covers both the typed-URL create and the file-browser
  // create) so the buttons disable while a workspace is being spun up.
  const [datasetUrlInput, setDatasetUrlInput] = useState("");
  const [showFileBrowser, setShowFileBrowser] = useState(false);
  const {
    state: operationState,
    begin: beginOperation,
    dismiss: dismissOperation,
    isPending: isOperationPending,
  } = useLatestOperation();
  const creatingAndOpening = isOperationPending(CREATE_AND_OPEN_OPERATION_KEY);

  useEffect(() => {
    const label = showArchived ? "archived" : "active";
    const load = showArchived ? listArchivedWorkspaces : listWorkspaces;
    setLoading(true);
    setWorkspaces([]);
    const attempt = beginOperation({
      key: "load:workspaces",
      pendingMessage: `Loading ${label} workspaces…`,
      successMessage: `${showArchived ? "Archived" : "Active"} workspaces loaded.`,
      failureMessage: `Could not load ${label} workspaces.`,
      retry: () => setReloadKey((key) => key + 1),
      replaceActive: true,
    });
    if (!attempt) return;
    void load()
      .then((rows) => {
        if (attempt.isCurrent()) {
          setWorkspaces(rows);
          setLoading(false);
        }
        attempt.succeed();
      })
      .catch((e) => {
        if (attempt.isCurrent()) setLoading(false);
        attempt.fail(e);
      });
  }, [beginOperation, reloadKey, showArchived]);

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const ordered = sortWorkspaceDashboardRows(workspaces);
    if (!q) return ordered;
    return ordered.filter((w) => w.name.toLocaleLowerCase().includes(q));
  }, [query, workspaces]);

  const handleCreate = useCallback(async function createBlankWorkspace() {
    const attempt = beginOperation({
      key: CREATE_AND_OPEN_OPERATION_KEY,
      pendingMessage: "Creating workspace…",
      successMessage: "Workspace created.",
      failureMessage: "Could not create the workspace.",
      retry: () => { void createBlankWorkspace(); },
    });
    if (!attempt) return;
    try {
      const workspace = await createWorkspace();
      if (attempt.isCurrent()) onOpenWorkspace(workspace.id);
      attempt.succeed();
    } catch (e) {
      attempt.fail(e);
    }
  }, [onOpenWorkspace, beginOperation]);

  // Create a NEW workspace around the given dataset URL(s)/path(s) and open it
  // (#697). The workspace is created with the server's default sharing
  // (restricted, owner-only, link OFF — `createWorkspaceFromDatasets` only sends
  // a name), then we navigate in and hand the urls to the viewer, which opens
  // them and (on failure) surfaces the error there while KEEPING the workspace.
  // Only the workspace-creation step can fail here; if it does, we surface it on
  // the dashboard and no navigation happens.
  const handleCreateFromDatasets = useCallback(
    async function createFromDatasets(urls: readonly string[]) {
      const cleaned = urls.map((u) => u.trim()).filter((u) => u.length > 0);
      if (cleaned.length === 0) return;
      const attempt = beginOperation({
        key: CREATE_AND_OPEN_OPERATION_KEY,
        pendingMessage: "Creating workspace from selected data…",
        successMessage: "Workspace created from selected data.",
        failureMessage: "Could not create a workspace from the selected data.",
        retry: () => { void createFromDatasets(cleaned); },
      });
      if (!attempt) return;
      try {
        const workspace = await createWorkspaceFromDatasets(cleaned);
        if (attempt.isCurrent()) onOpenWorkspace(workspace.id, cleaned);
        attempt.succeed();
      } catch (e) {
        attempt.fail(e);
      }
    },
    [onOpenWorkspace, beginOperation],
  );

  const handlePin = useCallback(async function setWorkspacePinned(
    workspace: WorkspaceSummary,
    pinned: boolean,
  ) {
    const verb = pinned ? "Pin" : "Unpin";
    const attempt = beginOperation({
      key: `pin:${workspace.id}`,
      pendingMessage: `${verb}ning ${workspace.name}…`,
      successMessage: `${pinned ? "Pinned" : "Unpinned"} ${workspace.name}.`,
      failureMessage: `Could not ${verb.toLocaleLowerCase()} ${workspace.name}.`,
      retry: () => { void setWorkspacePinned(workspace, pinned); },
    });
    if (!attempt) return;
    try {
      const state = await updateWorkspacePin(workspace.id, pinned);
      if (attempt.isCurrent()) {
        setWorkspaces((rows) =>
          sortWorkspaceDashboardRows(
            rows.map((row) =>
              row.id === workspace.id
                ? {
                  ...row,
                  last_opened_at: state.last_opened_at ?? row.last_opened_at,
                  pinned_at: state.pinned_at,
                }
                : row
            ),
          )
        );
      }
      attempt.succeed();
    } catch (e) {
      attempt.fail(e);
    }
  }, [beginOperation]);

  const handleArchive = useCallback(async function archiveDashboardWorkspace(
    workspace: WorkspaceSummary,
  ) {
    const attempt = beginOperation({
      key: `archive:${workspace.id}`,
      pendingMessage: `Archiving ${workspace.name}…`,
      successMessage: `Archived ${workspace.name}.`,
      failureMessage: `Could not archive ${workspace.name}.`,
      retry: () => { void archiveDashboardWorkspace(workspace); },
    });
    if (!attempt) return;
    try {
      await archiveWorkspace(workspace.id);
      if (attempt.isCurrent()) {
        setWorkspaces((rows) => rows.filter((row) => row.id !== workspace.id));
      }
      attempt.succeed();
    } catch (e) {
      attempt.fail(e);
    }
  }, [beginOperation]);

  const handleRestore = useCallback(async function restoreDashboardWorkspace(
    workspace: WorkspaceSummary,
  ) {
    const attempt = beginOperation({
      key: `restore:${workspace.id}`,
      pendingMessage: `Restoring ${workspace.name}…`,
      successMessage: `Restored ${workspace.name}.`,
      failureMessage: `Could not restore ${workspace.name}.`,
      retry: () => { void restoreDashboardWorkspace(workspace); },
    });
    if (!attempt) return;
    try {
      await restoreWorkspace(workspace.id);
      if (attempt.isCurrent()) {
        setWorkspaces((rows) => rows.filter((row) => row.id !== workspace.id));
      }
      attempt.succeed();
    } catch (e) {
      attempt.fail(e);
    }
  }, [beginOperation]);

  // Make a private copy of any workspace the user can access (#698) and open
  // it. The copy is owned by the user with default sharing (restricted,
  // owner-only) — no members/permissions are carried over. On success we
  // navigate straight into the copy; on failure the error surfaces here and
  // the user stays on the dashboard.
  const handleDuplicate = useCallback(
    async function duplicateDashboardWorkspace(workspace: WorkspaceSummary) {
      const attempt = beginOperation({
        key: CREATE_AND_OPEN_OPERATION_KEY,
        pendingMessage: `Duplicating ${workspace.name}…`,
        successMessage: `Duplicated ${workspace.name}.`,
        failureMessage: `Could not duplicate ${workspace.name}.`,
        retry: () => { void duplicateDashboardWorkspace(workspace); },
      });
      if (!attempt) return;
      try {
        const copy = await duplicateWorkspace(workspace.id);
        if (attempt.isCurrent()) onOpenWorkspace(copy.id);
        attempt.succeed();
      } catch (e) {
        attempt.fail(e);
      }
    },
    [onOpenWorkspace, beginOperation],
  );

  return (
    <div className="workspace-dashboard">
      <ProfileMenu />
      <div className="workspace-dashboard-inner">
        <div className="workspace-dashboard-toolbar">
          <h1>Workspaces</h1>
          <div className="workspace-dashboard-actions">
            <button
              type="button"
              className="workspace-dashboard-secondary"
              onClick={() => {
                setShowArchived((value) => !value);
              }}
            >
              {showArchived ? "Active" : "Archived"}
            </button>
            <button
              onClick={handleCreate}
              disabled={creatingAndOpening || showArchived}
            >
              {creatingAndOpening ? "Creating..." : "New Workspace"}
            </button>
          </div>
        </div>
        {!showArchived && (
          <form
            className="workspace-from-dataset"
            data-testid="new-workspace-from-dataset"
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreateFromDatasets([datasetUrlInput]);
            }}
          >
            <input
              className="workspace-from-dataset-input"
              value={datasetUrlInput}
              onChange={(e) => setDatasetUrlInput(e.target.value)}
              placeholder="New workspace from dataset — file path or remote URL"
              aria-label="New workspace from dataset URL or path"
              disabled={creatingAndOpening}
            />
            <button
              type="submit"
              disabled={creatingAndOpening || !datasetUrlInput.trim()}
            >
              {creatingAndOpening ? "Creating..." : "Create from URL"}
            </button>
            <button
              type="button"
              className="workspace-dashboard-secondary"
              onClick={() => setShowFileBrowser(true)}
              disabled={creatingAndOpening}
            >
              Browse files…
            </button>
          </form>
        )}
        <input
          className="workspace-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search visible workspaces"
          aria-label="Search workspaces"
        />
        <OperationStatus
          state={operationState}
          onDismiss={dismissOperation}
          className="workspace-dashboard-operation"
        />
        {loading ? (
          <div className="workspace-dashboard-empty" role="status" aria-live="polite">
            Loading workspaces...
          </div>
        ) : filtered.length === 0 ? (
          <div className="workspace-dashboard-empty">
            {query.trim()
              ? "No matching workspaces."
              : showArchived
                ? "No archived workspaces."
                : "No workspaces yet. Create a blank workspace, or start from a dataset above."}
          </div>
        ) : (
          <div className="workspace-list">
            {filtered.map((workspace) => (
              <div
                key={workspace.id}
                className="workspace-list-row"
              >
                <button
                  className="workspace-list-open"
                  onClick={() => onOpenWorkspace(workspace.id)}
                  aria-label={`Open workspace ${workspace.name}`}
                >
                  <span className="workspace-list-name">{workspace.name}</span>
                  <span className="workspace-list-meta">
                    {workspace.role} | {workspace.dataset_count} dataset
                    {workspace.dataset_count === 1 ? "" : "s"}
                  </span>
                  <span className="workspace-list-updated">
                    {workspace.last_opened_at
                      ? `Opened ${new Date(workspace.last_opened_at).toLocaleString()}`
                      : `Updated ${new Date(workspace.updated_at).toLocaleString()}`}
                  </span>
                </button>
                <div className="workspace-row-actions">
                  {!showArchived && (
                    <button
                      className="workspace-pin-button"
                      disabled={isOperationPending(`pin:${workspace.id}`)}
                      aria-pressed={Boolean(workspace.pinned_at)}
                      aria-label={`${workspace.pinned_at ? "Unpin" : "Pin"} ${workspace.name}`}
                      onClick={() => {
                        void handlePin(workspace, !workspace.pinned_at);
                      }}
                    >
                      {workspace.pinned_at ? "Unpin" : "Pin"}
                    </button>
                  )}
                  {/* Duplicate is available for ANY workspace the user can
                      access (any role) — the copy becomes their own. */}
                  {!showArchived && (
                    <button
                      className="workspace-duplicate-button"
                      disabled={creatingAndOpening}
                      aria-label={`Duplicate ${workspace.name}`}
                      onClick={() => {
                        void handleDuplicate(workspace);
                      }}
                    >
                      {creatingAndOpening ? "Duplicating…" : "Duplicate"}
                    </button>
                  )}
                  {workspace.role === "owner" && (
                    <button
                      className="workspace-archive-button"
                      disabled={isOperationPending(`${showArchived ? "restore" : "archive"}:${workspace.id}`)}
                      aria-label={`${showArchived ? "Restore" : "Archive"} ${workspace.name}`}
                      onClick={() => {
                        void (showArchived
                          ? handleRestore(workspace)
                          : handleArchive(workspace));
                      }}
                    >
                      {isOperationPending(`${showArchived ? "restore" : "archive"}:${workspace.id}`)
                        ? `${showArchived ? "Restoring" : "Archiving"}…`
                        : showArchived ? "Restore" : "Archive"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {showFileBrowser && (
        <FileBrowser
          onClose={() => setShowFileBrowser(false)}
          onCreateWorkspace={(paths) => {
            setShowFileBrowser(false);
            void handleCreateFromDatasets(paths);
          }}
        />
      )}
    </div>
  );
}
