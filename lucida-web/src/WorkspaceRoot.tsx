import { useCallback, useEffect, useMemo, useState } from "react";
import App from "./App.tsx";
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
  // Pending seed dataset URLs for a freshly created "workspace from dataset(s)"
  // (#697), keyed by workspace id. The dashboard / file browser create the
  // workspace, then call `onOpenWorkspace(id, urls)`; we stash the urls here and
  // hand them to `<App>` so it auto-opens them once connected. Keyed (not a bare
  // value) so a stale seed can never bleed into a *different* workspace if the
  // user navigates around. Consumed once: a later bare re-open of the same
  // workspace passes no seed and opens nothing extra.
  const [pendingSeed, setPendingSeed] = useState<{
    workspaceId: string;
    datasetUrls: readonly string[];
  } | null>(null);

  useEffect(() => {
    // Browser back/forward always means "leaving the create→open we made the
    // seed for" (a fresh create navigates via pushState, never popstate), so
    // drop any pending seed here. This keeps the seed strictly single-use
    // without a setState-in-effect on the render path.
    const onPopState = () => {
      setPendingSeed(null);
      setPath(currentPath());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((nextPath: string) => {
    // Clear a stale seed when navigating ANYWHERE other than straight into the
    // workspace it was created for. `openWorkspaceById` sets the seed and then
    // calls navigate to that same `/w/<id>` (matched here, so the seed
    // survives); every other navigation — back to the dashboard, opening a
    // different workspace — drops it so a later plain re-open never re-triggers
    // the auto-open.
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
        // Set the seed BEFORE navigating; navigate keeps it because the
        // destination matches this workspace's route.
        setPendingSeed({ workspaceId: id, datasetUrls });
      }
      navigate(`/w/${encodeURIComponent(id)}`);
    },
    [navigate],
  );

  // In-viewer "create workspace from selection" (#697): create a fresh
  // workspace around the chosen datasets, then navigate in with the seed so the
  // viewer auto-opens them. Failures bubble up to the caller's catch (the file
  // browser closed before this runs); the new workspace creation is the only
  // step here, and on success the open happens in the destination viewer.
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

  if (!workspaceId) {
    return <WorkspaceDashboard onOpenWorkspace={openWorkspaceById} />;
  }

  // Only forward the seed when it belongs to the workspace currently being
  // opened (guards against a stale seed from an earlier create).
  const seedForThisWorkspace =
    pendingSeed && pendingSeed.workspaceId === workspaceId
      ? pendingSeed.datasetUrls
      : undefined;

  return (
    <WorkspaceViewerRoute
      key={workspaceId}
      workspaceId={workspaceId}
      initialDatasetUrls={seedForThisWorkspace}
      onBackToDashboard={() => navigate("/")}
      onCreateWorkspaceFromDatasets={createWorkspaceFrom}
    />
  );
}

interface WorkspaceViewerRouteProps {
  workspaceId: string;
  /** Seed dataset URLs to auto-open (#697), forwarded to <App>. */
  initialDatasetUrls?: readonly string[];
  onBackToDashboard: () => void;
  /** Create a new workspace from datasets chosen in the viewer (#697). */
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
  // Error from the in-viewer "create workspace from selection" create-step
  // (#697). Surfaced to the user (not just logged) so a failed create isn't
  // silent — mirrors how the dashboard's create-from-dataset path shows its
  // failure. Kept SEPARATE from `error` above: that one replaces the whole
  // route with the access-denied page, but a create-from-selection failure must
  // LEAVE the current workspace in place (the create is a side action), so this
  // renders as a dismissible inline notice alongside the mounted <App>.
  const [createError, setCreateError] = useState<string | null>(null);

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
            // The new-workspace creation step failed (the only thing that can
            // fail here — the dataset open happens in the destination viewer).
            // Surface it to the user without unwinding the current workspace,
            // consistent with the dashboard's create-from-dataset failure path.
            console.warn("[WorkspaceRoot] create workspace from datasets failed", e);
            setCreateError(e instanceof Error ? e.message : String(e));
          });
        }}
      />
    </>
  );
}
