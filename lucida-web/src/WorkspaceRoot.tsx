import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import App from "./App.tsx";
import "./auth/auth.css";
import { WatchStreamBanner } from "./monitor/WatchToggle.tsx";
import { parseSavedViewHash } from "./savedView/urlSync.ts";
import { Banner } from "./shell/Banner.tsx";
import { Button } from "./ui/Button.tsx";
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

// The open link: `/open?url=<dataset URL>` creates a workspace around the
// named dataset(s) and opens them.
function isOpenLinkPath(path: string): boolean {
  return /^\/open\/?$/.test(path);
}

function openLinkUrls(search: string): string[] {
  return new URLSearchParams(search)
    .getAll("url")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
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

  const navigate = useCallback((nextPath: string, replace = false) => {
    // Keep the seed only when navigating straight into the workspace it was
    // created for; any other navigation drops it.
    setPendingSeed((seed) =>
      seed && nextPath === `/w/${encodeURIComponent(seed.workspaceId)}`
        ? seed
        : null,
    );
    if (replace) {
      window.history.replaceState({}, "", nextPath);
    } else {
      window.history.pushState({}, "", nextPath);
    }
    setPath(nextPath);
  }, []);

  const openWorkspaceById = useCallback(
    (id: string, datasetUrls?: readonly string[], replace = false) => {
      if (datasetUrls && datasetUrls.length > 0) {
        // Set the seed before navigating; navigate keeps it because the
        // destination matches this workspace's route.
        setPendingSeed({ workspaceId: id, datasetUrls });
      }
      navigate(`/w/${encodeURIComponent(id)}`, replace);
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

  // A saved-view link off any workspace (`/#b=<id>`) names a bookmark, and
  // this server keeps none. It lands on the dashboard, which says so.
  const [bookmarkLinkNotice, setBookmarkLinkNotice] = useState(
    () => parseSavedViewHash(window.location.hash) !== null,
  );
  const dismissBookmarkLinkNotice = useCallback(() => {
    setBookmarkLinkNotice(false);
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${search}`);
  }, []);
  const onDashboard = !workspaceId && !isOpenLinkPath(path);

  // Only forward the seed when it belongs to the workspace being opened.
  const seedForThisWorkspace =
    pendingSeed && workspaceId && pendingSeed.workspaceId === workspaceId
      ? pendingSeed.datasetUrls
      : undefined;

  return (
    <>
      {isOpenLinkPath(path) ? (
        <OpenLinkRoute
          datasetUrls={openLinkUrls(window.location.search)}
          onWorkspaceCreated={(id, urls) => openWorkspaceById(id, urls, true)}
          onBackToDashboard={() => navigate("/", true)}
        />
      ) : workspaceId ? (
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
      {onDashboard && bookmarkLinkNotice && (
        <div className="workspace-root-banner">
          <Banner tone="info" onDismiss={dismissBookmarkLinkNotice} data-testid="bookmark-link-notice">
            This link names a bookmark, and this server no longer keeps bookmarks. Saved views
            belong to workspaces now: ask whoever shared the link for a link to the workspace.
          </Banner>
        </div>
      )}
      {/* Above the routes, because the stream is per session and outlives the
          dock the toggle lives in. */}
      <WatchStreamBanner />
    </>
  );
}

interface OpenLinkRouteProps {
  datasetUrls: readonly string[];
  onWorkspaceCreated: (id: string, datasetUrls: readonly string[]) => void;
  onBackToDashboard: () => void;
}

// Every exit replaces the history entry, so Back can't rerun the link.
function OpenLinkRoute({
  datasetUrls,
  onWorkspaceCreated,
  onBackToDashboard,
}: OpenLinkRouteProps) {
  const [error, setError] = useState<string | null>(null);
  // StrictMode runs this effect twice; the second run reuses the first create.
  const createRef = useRef<Promise<WorkspaceRecord> | null>(null);
  useEffect(() => {
    if (datasetUrls.length === 0) {
      onBackToDashboard();
      return;
    }
    let cancelled = false;
    createRef.current ??= createWorkspaceFromDatasets(datasetUrls);
    createRef.current.then(
      (workspace) => {
        if (!cancelled) onWorkspaceCreated(workspace.id, datasetUrls);
      },
      (e: unknown) => {
        if (cancelled) return;
        console.warn("[WorkspaceRoot] open link: create workspace failed", e);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div className="lc-auth-screen">
        <div className="lc-auth-card">
          <h1 className="lc-auth-title">Couldn&rsquo;t open the link</h1>
          <p className="lc-auth-body" data-testid="open-link-error">
            Couldn&rsquo;t create the workspace: {error}
          </p>
          <Button variant="primary" onPress={onBackToDashboard}>
            All workspaces
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="lc-auth-screen">
      <p className="lc-auth-status" role="status">
        Opening…
      </p>
    </div>
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
      <div className="lc-auth-screen">
        <div className="lc-auth-card">
          <h1 className="lc-auth-title">Workspace unavailable</h1>
          <p className="lc-auth-body" data-testid="workspace-access-message">
            You don&rsquo;t have access to this workspace, or it doesn&rsquo;t
            exist — ask the person who shared it for an invite.
          </p>
          <Button variant="primary" onPress={onBackToDashboard}>
            All workspaces
          </Button>
        </div>
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="lc-auth-screen">
        <p className="lc-auth-status" role="status">
          Loading workspace…
        </p>
      </div>
    );
  }

  return (
    <>
      {createError && (
        <div className="workspace-root-banner">
          <Banner tone="danger" role="alert" onDismiss={() => setCreateError(null)} data-testid="workspace-create-error">
            Couldn&rsquo;t create the workspace: {createError}
          </Banner>
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
