import { useCallback, useEffect, useMemo, useState } from "react";
import App from "./App.tsx";
import { WatchStreamBanner } from "./monitor/WatchToggle.tsx";
import { WorkspaceDashboard } from "./WorkspaceDashboard.tsx";
import { createWorkspaceFromDatasets } from "./workspaceFromDataset.ts";
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
  // Dataset URLs for `<App>` to auto-open in a just-created workspace. Keyed by
  // workspace id so a stale seed can't bleed into a different workspace, and
  // single-use so a later re-open opens nothing extra.
  const [pendingSeed, setPendingSeed] = useState<{
    workspaceId: string;
    datasetUrls: readonly string[];
  } | null>(null);

  useEffect(() => {
    // Back/forward always leaves the create-then-open the seed was made for
    // (a create navigates via pushState, never popstate), so drop the seed.
    const onPopState = () => {
      setPendingSeed(null);
      setPath(currentPath());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((nextPath: string) => {
    // Keep the seed only when navigating straight into the workspace it was
    // created for; any other navigation drops it.
    setPendingSeed((seed) =>
      seed && nextPath === `/w/${encodeURIComponent(seed.workspaceId)}`
        ? seed
        : null,
    );
    window.history.pushState({}, "", nextPath);
    setPath(nextPath);
  }, []);

  const openWorkspaceById = useCallback(
    (id: string, datasetUrls?: readonly string[]) => {
      if (datasetUrls && datasetUrls.length > 0) {
        // Set the seed before navigating; navigate keeps it because the
        // destination matches this workspace's route.
        setPendingSeed({ workspaceId: id, datasetUrls });
      }
      navigate(`/w/${encodeURIComponent(id)}`);
    },
    [navigate],
  );

  // In-viewer "create workspace from selection". Failures go to the caller's
  // catch; the dataset open happens in the destination viewer.
  const createWorkspaceFrom = useCallback(
    async (paths: string[]) => {
      const cleaned = paths.map((p) => p.trim()).filter((p) => p.length > 0);
      if (cleaned.length === 0) return;
      const workspace = await createWorkspaceFromDatasets(cleaned);
      openWorkspaceById(workspace.id, cleaned);
    },
    [openWorkspaceById],
  );

  const workspaceId = useMemo(() => parseWorkspaceId(path), [path]);

  // Only forward the seed when it belongs to the workspace being opened.
  const seedForThisWorkspace =
    pendingSeed && workspaceId && pendingSeed.workspaceId === workspaceId
      ? pendingSeed.datasetUrls
      : undefined;

  return (
    <>
      {workspaceId ? (
        <WorkspaceViewerRoute
          key={workspaceId}
          workspaceId={workspaceId}
          initialDatasetUrls={seedForThisWorkspace}
          onBackToDashboard={() => navigate("/")}
          onCreateWorkspaceFromDatasets={createWorkspaceFrom}
        />
      ) : (
        <WorkspaceDashboard onOpenWorkspace={openWorkspaceById} />
      )}
      {/* Above the routes, because the stream is per session and outlives the
          dock the toggle lives in. */}
      <WatchStreamBanner />
    </>
  );
}

interface WorkspaceViewerRouteProps {
  workspaceId: string;
  /** Seed dataset URLs to auto-open, forwarded to <App>. */
  initialDatasetUrls?: readonly string[];
  onBackToDashboard: () => void;
  /** Create a new workspace from datasets chosen in the viewer. */
  onCreateWorkspaceFromDatasets: (paths: string[]) => Promise<void>;
}

function WorkspaceViewerRoute({
  workspaceId,
  initialDatasetUrls,
  onBackToDashboard,
  onCreateWorkspaceFromDatasets,
}: WorkspaceViewerRouteProps) {
  const [workspace, setWorkspace] = useState<WorkspaceRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Separate from `error`, which replaces the route with the access-denied
  // page. A failed create-from-selection must leave the current workspace in
  // place, so it renders as a dismissible notice beside <App>.
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void openWorkspace(workspaceId)
      .then((record) => {
        if (!cancelled) setWorkspace(record);
      })
      .catch((e) => {
        // Never leak: this console belongs to the deep-link recipient, and the
        // raw error would tell a denied workspace from a missing one. Log one
        // generic line even though the server already returns a uniform 404.
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
    // Never leak: denied and missing workspaces (and annotation deep-links,
    // whose access is workspace access) render the same message, so the page
    // never confirms that one exists. The raw `error` is not shown.
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
    <>
      {createError && (
        <div className="workspace-create-error" role="alert">
          <span data-testid="workspace-create-error">
            Couldn&rsquo;t create the workspace: {createError}
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setCreateError(null)}
          >
            Dismiss
          </button>
        </div>
      )}
      <App
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        workspaceRole={workspace.role}
        defaultSavedViewId={workspace.default_saved_view_id}
        canRenameWorkspace={workspace.role === "owner"}
        initialDatasetUrls={initialDatasetUrls}
        onBackToDashboard={onBackToDashboard}
        onRenameWorkspace={handleRename}
        onSetDefaultSavedView={handleSetDefaultSavedView}
        onCreateWorkspaceFromDatasets={(paths) => {
          // Clear a stale notice when re-attempting.
          setCreateError(null);
          void onCreateWorkspaceFromDatasets(paths).catch((e) => {
            // Only the create step can fail here; keep the current workspace.
            console.warn("[WorkspaceRoot] create workspace from datasets failed", e);
            setCreateError(e instanceof Error ? e.message : String(e));
          });
        }}
      />
    </>
  );
}
