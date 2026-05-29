import { useCallback, useEffect, useMemo, useState } from "react";
import {
  archiveWorkspace,
  createWorkspace,
  listArchivedWorkspaces,
  listWorkspaces,
  restoreWorkspace,
  updateWorkspacePin,
  type WorkspaceSummary,
} from "./workspaceApi.ts";
import { ProfileMenu } from "./auth/ProfileMenu.tsx";
import { sortWorkspaceDashboardRows } from "./workspaceDashboardOrder.ts";
import "./WorkspaceDashboard.css";

interface Props {
  onOpenWorkspace: (id: string) => void;
}

export function WorkspaceDashboard({ onOpenWorkspace }: Props) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [pinningId, setPinningId] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = showArchived ? listArchivedWorkspaces : listWorkspaces;
    void load()
      .then((rows) => {
        if (!cancelled) setWorkspaces(rows);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showArchived]);

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const ordered = sortWorkspaceDashboardRows(workspaces);
    if (!q) return ordered;
    return ordered.filter((w) => w.name.toLocaleLowerCase().includes(q));
  }, [query, workspaces]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const workspace = await createWorkspace();
      onOpenWorkspace(workspace.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [onOpenWorkspace]);

  const handlePin = useCallback(async (workspace: WorkspaceSummary, pinned: boolean) => {
    setPinningId(workspace.id);
    setError(null);
    try {
      const state = await updateWorkspacePin(workspace.id, pinned);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPinningId(null);
    }
  }, []);

  const handleArchive = useCallback(async (workspace: WorkspaceSummary) => {
    setArchivingId(workspace.id);
    setError(null);
    try {
      await archiveWorkspace(workspace.id);
      setWorkspaces((rows) => rows.filter((row) => row.id !== workspace.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setArchivingId(null);
    }
  }, []);

  const handleRestore = useCallback(async (workspace: WorkspaceSummary) => {
    setArchivingId(workspace.id);
    setError(null);
    try {
      await restoreWorkspace(workspace.id);
      setWorkspaces((rows) => rows.filter((row) => row.id !== workspace.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setArchivingId(null);
    }
  }, []);

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
                setLoading(true);
                setWorkspaces([]);
                setShowArchived((value) => !value);
              }}
            >
              {showArchived ? "Active" : "Archived"}
            </button>
            <button onClick={handleCreate} disabled={creating || showArchived}>
              {creating ? "Creating..." : "New Workspace"}
            </button>
          </div>
        </div>
        <input
          className="workspace-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search visible workspaces"
          aria-label="Search workspaces"
        />
        {error && <div className="workspace-dashboard-error">{error}</div>}
        {loading ? (
          <div className="workspace-dashboard-empty">Loading workspaces...</div>
        ) : filtered.length === 0 ? (
          <div className="workspace-dashboard-empty">
            {query.trim()
              ? "No matching workspaces."
              : showArchived
                ? "No archived workspaces."
                : "No workspaces yet."}
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
                      disabled={pinningId === workspace.id}
                      aria-pressed={Boolean(workspace.pinned_at)}
                      aria-label={`${workspace.pinned_at ? "Unpin" : "Pin"} ${workspace.name}`}
                      onClick={() => {
                        void handlePin(workspace, !workspace.pinned_at);
                      }}
                    >
                      {workspace.pinned_at ? "Unpin" : "Pin"}
                    </button>
                  )}
                  {workspace.role === "owner" && (
                    <button
                      className="workspace-archive-button"
                      disabled={archivingId === workspace.id}
                      aria-label={`${showArchived ? "Restore" : "Archive"} ${workspace.name}`}
                      onClick={() => {
                        void (showArchived
                          ? handleRestore(workspace)
                          : handleArchive(workspace));
                      }}
                    >
                      {showArchived ? "Restore" : "Archive"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
