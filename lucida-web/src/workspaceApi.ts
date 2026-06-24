import type { SavedView } from "./savedView/types.ts";

export type WorkspaceRole = "viewer" | "editor" | "owner";
export type WorkspaceLinkAccess = "restricted" | "anyone_with_link";

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: WorkspaceRole;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  seq: number;
  dataset_count: number;
  default_saved_view_id: string | null;
  last_opened_at: string | null;
  pinned_at: string | null;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  role: WorkspaceRole;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  seq: number;
  default_saved_view_id: string | null;
  last_opened_at: string | null;
  pinned_at: string | null;
}

export interface WorkspaceMember {
  email: string;
  role: WorkspaceRole;
  display_name: string;
  added_at: string;
}

export interface WorkspaceSharingSettings {
  link_access: WorkspaceLinkAccess;
  link_role: Exclude<WorkspaceRole, "owner">;
  members: WorkspaceMember[];
}

export type WorkspaceSavedViewVisibility = "shared" | "personal" | "proposed";

export interface WorkspaceSavedView {
  id: string;
  workspace_id: string;
  name: string;
  created_by: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
  visibility: WorkspaceSavedViewVisibility;
  view: SavedView;
}

export interface WorkspaceViewerProfile {
  workspace_id: string;
  user_email: string;
  profile: string;
  created_at: string;
  updated_at: string;
  seed_source: string | null;
  view: SavedView;
}

export interface WorkspaceUserState {
  workspace_id: string;
  last_opened_at: string | null;
  pinned_at: string | null;
  /** The caller's own last-open view in this workspace (#700), restored on
   *  a bare `/w/:id` open behind the "Restore my last view" toggle. Absent /
   *  null until the member records one; never another member's view. */
  last_view?: SavedView | null;
}

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      detail = body.detail || body.error || detail;
    } catch {
      // Keep status text.
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

async function requestOptionalJson<T>(
  input: RequestInfo,
  init?: RequestInit,
): Promise<T | null> {
  const res = await fetch(input, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      detail = body.detail || body.error || detail;
    } catch {
      // Keep status text.
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

async function requestNoContent(input: RequestInfo, init?: RequestInit): Promise<void> {
  const res = await fetch(input, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      detail = body.detail || body.error || detail;
    } catch {
      // Keep status text.
    }
    throw new Error(detail);
  }
}

export function listWorkspaces(): Promise<WorkspaceSummary[]> {
  return requestJson<WorkspaceSummary[]>("/api/workspaces");
}

export function listArchivedWorkspaces(): Promise<WorkspaceSummary[]> {
  return requestJson<WorkspaceSummary[]>("/api/workspaces/archived");
}

export function createWorkspace(name?: string): Promise<WorkspaceRecord> {
  return requestJson<WorkspaceRecord>("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function getWorkspace(id: string): Promise<WorkspaceRecord> {
  return requestJson<WorkspaceRecord>(`/api/workspaces/${encodeURIComponent(id)}`);
}

/**
 * Duplicate a workspace into a private copy owned by the caller (#698).
 *
 * Anyone who can access the source (any role, viewer included) may duplicate
 * it. The copy is a NEW workspace owned by the caller, created with the
 * default sharing (restricted, owner-only, link OFF) — it never inherits the
 * source's members or any permission. It copies datasets (+ display names),
 * the source's *shared* saved views (re-attributed to the caller), the
 * active/default view, and the document, so it opens looking like the
 * original. Defaults to the name `Copy of <source name>`; pass `name` to
 * override. Resolves to the new workspace (id/name) to navigate into.
 */
export function duplicateWorkspace(id: string, name?: string): Promise<WorkspaceRecord> {
  return requestJson<WorkspaceRecord>(
    `/api/workspaces/${encodeURIComponent(id)}/duplicate`,
    {
      method: "POST",
      body: JSON.stringify({ name }),
    },
  );
}

export function openWorkspace(id: string): Promise<WorkspaceRecord> {
  return requestJson<WorkspaceRecord>(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: "POST",
  });
}

export function renameWorkspace(id: string, name: string): Promise<WorkspaceRecord> {
  return requestJson<WorkspaceRecord>(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function archiveWorkspace(id: string): Promise<WorkspaceRecord> {
  return requestJson<WorkspaceRecord>(
    `/api/workspaces/${encodeURIComponent(id)}/archive`,
    { method: "POST" },
  );
}

export function restoreWorkspace(id: string): Promise<WorkspaceRecord> {
  return requestJson<WorkspaceRecord>(
    `/api/workspaces/${encodeURIComponent(id)}/restore`,
    { method: "POST" },
  );
}

export function getWorkspaceSharing(id: string): Promise<WorkspaceSharingSettings> {
  return requestJson<WorkspaceSharingSettings>(
    `/api/workspaces/${encodeURIComponent(id)}/sharing`,
  );
}

export function updateWorkspaceLinkAccess(
  id: string,
  linkAccess: WorkspaceLinkAccess,
  linkRole: Exclude<WorkspaceRole, "owner">,
): Promise<WorkspaceSharingSettings> {
  return requestJson<WorkspaceSharingSettings>(
    `/api/workspaces/${encodeURIComponent(id)}/sharing`,
    {
      method: "PATCH",
      body: JSON.stringify({ link_access: linkAccess, link_role: linkRole }),
    },
  );
}

export function addWorkspaceMember(
  id: string,
  email: string,
  role: WorkspaceRole,
): Promise<WorkspaceMember> {
  return requestJson<WorkspaceMember>(
    `/api/workspaces/${encodeURIComponent(id)}/members`,
    {
      method: "POST",
      body: JSON.stringify({ email, role }),
    },
  );
}

export function updateWorkspaceMemberRole(
  id: string,
  email: string,
  role: WorkspaceRole,
): Promise<WorkspaceMember> {
  return requestJson<WorkspaceMember>(
    `/api/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(email)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ role }),
    },
  );
}

export function removeWorkspaceMember(id: string, email: string): Promise<void> {
  return requestNoContent(
    `/api/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(email)}`,
    { method: "DELETE" },
  );
}

function workspaceSavedViewsUrl(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/saved-views`;
}

function workspaceSavedViewUrl(workspaceId: string, savedViewId: string): string {
  return `${workspaceSavedViewsUrl(workspaceId)}/${encodeURIComponent(savedViewId)}`;
}

function workspaceViewerProfileUrl(workspaceId: string, profile: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/viewer-profiles/${encodeURIComponent(profile)}`;
}

export function listWorkspaceSavedViews(workspaceId: string): Promise<WorkspaceSavedView[]> {
  return requestJson<WorkspaceSavedView[]>(workspaceSavedViewsUrl(workspaceId));
}

export function getWorkspaceSavedView(
  workspaceId: string,
  savedViewId: string,
): Promise<WorkspaceSavedView> {
  return requestJson<WorkspaceSavedView>(
    workspaceSavedViewUrl(workspaceId, savedViewId),
  );
}

export function createWorkspaceSavedView(
  workspaceId: string,
  name: string,
  view: SavedView,
  visibility: WorkspaceSavedViewVisibility = "shared",
): Promise<WorkspaceSavedView> {
  return requestJson<WorkspaceSavedView>(workspaceSavedViewsUrl(workspaceId), {
    method: "POST",
    body: JSON.stringify({ name, view, visibility }),
  });
}

export function updateWorkspaceSavedView(
  workspaceId: string,
  savedViewId: string,
  patch: { name?: string; view?: SavedView },
): Promise<WorkspaceSavedView> {
  return requestJson<WorkspaceSavedView>(
    workspaceSavedViewUrl(workspaceId, savedViewId),
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
  );
}

export function deleteWorkspaceSavedView(
  workspaceId: string,
  savedViewId: string,
): Promise<void> {
  return requestNoContent(workspaceSavedViewUrl(workspaceId, savedViewId), {
    method: "DELETE",
  });
}

/**
 * Re-scope a saved view between `"personal"` and `"shared"` ("Share with team"
 * promotes a personal view). The server preserves `created_by`, enforces
 * creator-only + never-leak, and requires edit access to make a view shared.
 */
export function setWorkspaceSavedViewVisibility(
  workspaceId: string,
  savedViewId: string,
  visibility: WorkspaceSavedViewVisibility,
): Promise<WorkspaceSavedView> {
  return requestJson<WorkspaceSavedView>(
    `${workspaceSavedViewUrl(workspaceId, savedViewId)}/visibility`,
    {
      method: "PATCH",
      body: JSON.stringify({ visibility }),
    },
  );
}

/**
 * Approve a viewer's proposed saved view (#702): an editor accepts the
 * proposal and it becomes a `"shared"` view, with the proposer preserved as
 * `created_by`. Editor-only server-side; resolves to the updated view.
 */
export function approveWorkspaceSavedView(
  workspaceId: string,
  savedViewId: string,
): Promise<WorkspaceSavedView> {
  return requestJson<WorkspaceSavedView>(
    `${workspaceSavedViewUrl(workspaceId, savedViewId)}/approve`,
    { method: "POST" },
  );
}

/**
 * Reject a viewer's proposed saved view (#702): an editor declines the
 * proposal and it reverts to the proposer's own `"personal"` view
 * (non-destructive). Editor-only server-side; resolves to the updated view.
 */
export function rejectWorkspaceSavedView(
  workspaceId: string,
  savedViewId: string,
): Promise<WorkspaceSavedView> {
  return requestJson<WorkspaceSavedView>(
    `${workspaceSavedViewUrl(workspaceId, savedViewId)}/reject`,
    { method: "POST" },
  );
}

export function getWorkspaceViewerProfile(
  workspaceId: string,
  profile: string,
): Promise<WorkspaceViewerProfile | null> {
  return requestOptionalJson<WorkspaceViewerProfile>(
    workspaceViewerProfileUrl(workspaceId, profile),
  );
}

export function updateWorkspaceDefaultSavedView(
  workspaceId: string,
  savedViewId: string | null,
): Promise<WorkspaceRecord> {
  return requestJson<WorkspaceRecord>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/default-saved-view`,
    {
      method: "PATCH",
      body: JSON.stringify({ saved_view_id: savedViewId }),
    },
  );
}

export function updateWorkspacePin(
  workspaceId: string,
  pinned: boolean,
): Promise<WorkspaceUserState> {
  return requestJson<WorkspaceUserState>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/pin`,
    {
      method: "PATCH",
      body: JSON.stringify({ pinned }),
    },
  );
}

/** Record the caller's own last-open view for a workspace (#700). Scoped to
 *  the authenticated principal server-side; never mutates the shared
 *  workspace default. Returns the caller's refreshed state (incl. last_view). */
export function updateWorkspaceLastView(
  workspaceId: string,
  view: SavedView,
): Promise<WorkspaceUserState> {
  return requestJson<WorkspaceUserState>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/last-view`,
    {
      method: "PATCH",
      body: JSON.stringify({ view }),
    },
  );
}

/** Read the caller's own workspace state, including their remembered
 *  `last_view` (#700). Principal-scoped; never another member's state. */
export function getWorkspaceUserState(
  workspaceId: string,
): Promise<WorkspaceUserState> {
  return requestJson<WorkspaceUserState>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/user-state`,
  );
}
