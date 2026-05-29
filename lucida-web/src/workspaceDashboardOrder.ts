import type { WorkspaceSummary } from "./workspaceApi.ts";

export function sortWorkspaceDashboardRows(rows: WorkspaceSummary[]): WorkspaceSummary[] {
  return [...rows].sort((a, b) => {
    if (Boolean(a.pinned_at) !== Boolean(b.pinned_at)) {
      return a.pinned_at ? -1 : 1;
    }
    const aTime = Date.parse(a.pinned_at ?? a.last_opened_at ?? a.updated_at);
    const bTime = Date.parse(b.pinned_at ?? b.last_opened_at ?? b.updated_at);
    if (aTime !== bTime) return bTime - aTime;
    return a.name.localeCompare(b.name);
  });
}
