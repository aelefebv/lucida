import { useCallback, useEffect, useMemo, useState } from "react";
import { createWorkspace, listWorkspaces, type WorkspaceSummary } from "./workspaceApi.ts";
import { ProfileMenu } from "./auth/ProfileMenu.tsx";
import "./WorkspaceDashboard.css";

interface Props {
  onOpenWorkspace: (id: string) => void;
}

export function WorkspaceDashboard({ onOpenWorkspace }: Props) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    void listWorkspaces()
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
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return workspaces;
    return workspaces.filter((w) => w.name.toLocaleLowerCase().includes(q));
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

  return (
    <div className="workspace-dashboard">
      <ProfileMenu />
      <div className="workspace-dashboard-inner">
        <div className="workspace-dashboard-toolbar">
          <h1>Workspaces</h1>
          <button onClick={handleCreate} disabled={creating}>
            {creating ? "Creating..." : "New Workspace"}
          </button>
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
            {query.trim() ? "No matching workspaces." : "No workspaces yet."}
          </div>
        ) : (
          <div className="workspace-list">
            {filtered.map((workspace) => (
              <button
                key={workspace.id}
                className="workspace-list-row"
                onClick={() => onOpenWorkspace(workspace.id)}
              >
                <span className="workspace-list-name">{workspace.name}</span>
                <span className="workspace-list-meta">
                  {workspace.role} | {workspace.dataset_count} dataset
                  {workspace.dataset_count === 1 ? "" : "s"}
                </span>
                <span className="workspace-list-updated">
                  {new Date(workspace.updated_at).toLocaleString()}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
