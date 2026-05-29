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
