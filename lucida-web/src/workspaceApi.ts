export type WorkspaceRole = "viewer" | "editor" | "owner";

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
