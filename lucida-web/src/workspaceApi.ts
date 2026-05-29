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

export interface WorkspaceSavedView {
  id: string;
  workspace_id: string;
  name: string;
  created_by: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
  view: SavedView;
}

export interface WorkspaceUserState {
  workspace_id: string;
  last_opened_at: string | null;
  pinned_at: string | null;
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

export function createWorkspace(name?: string): Promise<WorkspaceRecord> {
  return requestJson<WorkspaceRecord>("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function getWorkspace(id: string): Promise<WorkspaceRecord> {
  return requestJson<WorkspaceRecord>(`/api/workspaces/${encodeURIComponent(id)}`);
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
): Promise<WorkspaceSavedView> {
  return requestJson<WorkspaceSavedView>(workspaceSavedViewsUrl(workspaceId), {
    method: "POST",
    body: JSON.stringify({ name, view }),
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
