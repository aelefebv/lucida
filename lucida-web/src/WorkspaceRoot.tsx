import { useCallback, useEffect, useMemo, useState } from "react";
import App from "./App.tsx";
import { WorkspaceDashboard } from "./WorkspaceDashboard.tsx";
import {
  getWorkspace,
  renameWorkspace,
  updateWorkspaceDefaultSavedView,
  type WorkspaceRecord,
} from "./workspaceApi.ts";

function currentPath(): string {
  return window.location.pathname || "/";
}

function parseWorkspaceId(path: string): string | null {
  const match = path.match(/^\/w\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function WorkspaceRoot() {
  const [path, setPath] = useState(currentPath);

  useEffect(() => {
    const onPopState = () => setPath(currentPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((nextPath: string) => {
    window.history.pushState({}, "", nextPath);
    setPath(nextPath);
  }, []);

  const workspaceId = useMemo(() => parseWorkspaceId(path), [path]);

  if (!workspaceId) {
    return (
      <WorkspaceDashboard
        onOpenWorkspace={(id) => navigate(`/w/${encodeURIComponent(id)}`)}
      />
    );
  }

  return (
    <WorkspaceViewerRoute
      key={workspaceId}
      workspaceId={workspaceId}
      onBackToDashboard={() => navigate("/")}
    />
  );
}

interface WorkspaceViewerRouteProps {
  workspaceId: string;
  onBackToDashboard: () => void;
}

function WorkspaceViewerRoute({ workspaceId, onBackToDashboard }: WorkspaceViewerRouteProps) {
  const [workspace, setWorkspace] = useState<WorkspaceRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getWorkspace(workspaceId)
      .then((record) => {
        if (!cancelled) setWorkspace(record);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const handleRename = useCallback(async (name: string) => {
    const updated = await renameWorkspace(workspaceId, name);
    setWorkspace(updated);
  }, [workspaceId]);

  const handleSetDefaultSavedView = useCallback(async (savedViewId: string | null) => {
    const updated = await updateWorkspaceDefaultSavedView(workspaceId, savedViewId);
    setWorkspace(updated);
  }, [workspaceId]);

  if (error) {
    return (
      <div className="workspace-route-message">
        <button onClick={onBackToDashboard}>Workspaces</button>
        <p>{error}</p>
      </div>
    );
  }

  if (!workspace) {
    return <div className="workspace-route-message">Loading workspace...</div>;
  }

  return (
    <App
      workspaceId={workspace.id}
      workspaceName={workspace.name}
      workspaceRole={workspace.role}
      defaultSavedViewId={workspace.default_saved_view_id}
      canRenameWorkspace={workspace.role === "owner"}
      onBackToDashboard={onBackToDashboard}
      onRenameWorkspace={handleRename}
      onSetDefaultSavedView={handleSetDefaultSavedView}
    />
  );
}
