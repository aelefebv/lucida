import { useCallback, useEffect, useMemo, useState } from "react";
import App from "./App.tsx";
import { WorkspaceDashboard } from "./WorkspaceDashboard.tsx";
import {
  openWorkspace,
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
    void openWorkspace(workspaceId)
      .then((record) => {
        if (!cancelled) setWorkspace(record);
      })
      .catch((e) => {
        // NEVER-LEAK: this code runs in the *recipient's* browser, so the
        // console is theirs, not an operator log. Logging the raw error (e.g.
        // "403 Forbidden" vs "404 Not Found") would let a deep-link recipient
        // distinguish a denied workspace from a missing one straight from
        // devtools, defeating the unified message below. We therefore log a
        // single non-distinguishing line (no status, no cause). The server now
        // returns a uniform 404 for any non-member open, but we keep the client
        // generic regardless so the never-leak invariant doesn't depend on it.
        console.warn("[WorkspaceRoot] could not open workspace");
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
    // NEVER-LEAK (annotation-views slice 3): a denied workspace (403) and a
    // missing one (404) — and a denied/missing annotation deep-link, which lands
    // here too because annotation access == workspace access — must render the
    // SAME friendly message, so the page never confirms whether a given
    // workspace/annotation exists. The raw `error` (e.g. "403 Forbidden" vs
    // "404 Not Found") would leak that distinction, so we deliberately don't
    // show it. No "request access" backend flow — just a clear dead-end with a
    // way back. (Genuine non-access errors degrade to the same message; we
    // deliberately do not log the distinguishing detail — see the catch above.)
    return (
      <div className="workspace-route-message">
        <button onClick={onBackToDashboard}>Workspaces</button>
        <p data-testid="workspace-access-message">
          You don&rsquo;t have access to this workspace, or it doesn&rsquo;t
          exist — ask the person who shared it for an invite.
        </p>
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
