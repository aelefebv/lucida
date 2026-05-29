import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createWorkspaceSavedView as apiCreate,
  deleteWorkspaceSavedView as apiDelete,
  listWorkspaceSavedViews as apiList,
  updateWorkspaceSavedView as apiUpdate,
  type WorkspaceSavedView,
} from "../workspaceApi.ts";
import type { SavedView } from "./types.ts";

export type { WorkspaceSavedView } from "../workspaceApi.ts";

export interface WorkspaceSavedViewFilter {
  search: string;
  mineOnly: boolean;
}

export interface UseWorkspaceSavedViewsOptions {
  workspaceId: string;
  currentUserEmail: string | null;
}

export interface UseWorkspaceSavedViewsHandle {
  savedViews: WorkspaceSavedView[];
  allSavedViews: WorkspaceSavedView[];
  isLoading: boolean;
  error: string | null;
  filter: WorkspaceSavedViewFilter;
  setSearch: (s: string) => void;
  setMineOnly: (v: boolean) => void;
  refresh: () => Promise<void>;
  createSavedView: (name: string, view: SavedView) => Promise<WorkspaceSavedView>;
  renameSavedView: (id: string, name: string) => Promise<WorkspaceSavedView>;
  replaceSavedView: (id: string, view: SavedView) => Promise<WorkspaceSavedView>;
  deleteSavedView: (id: string) => Promise<void>;
}

export function useWorkspaceSavedViews({
  workspaceId,
  currentUserEmail,
}: UseWorkspaceSavedViewsOptions): UseWorkspaceSavedViewsHandle {
  const [allSavedViews, setAllSavedViews] = useState<WorkspaceSavedView[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<WorkspaceSavedViewFilter>({
    search: "",
    mineOnly: false,
  });
  const reqIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const rows = await apiList(workspaceId);
      if (reqIdRef.current === reqId) {
        setAllSavedViews(rows);
      }
    } catch (e) {
      if (reqIdRef.current === reqId) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (reqIdRef.current === reqId) {
        setIsLoading(false);
      }
    }
  }, [workspaceId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const normalizedCurrentUserEmail = currentUserEmail?.toLowerCase() ?? null;
  const savedViews = useMemo(() => {
    const needle = filter.search.trim().toLowerCase();
    return allSavedViews.filter((view) => {
      if (filter.mineOnly) {
        if (normalizedCurrentUserEmail === null) return false;
        if (view.created_by.toLowerCase() !== normalizedCurrentUserEmail) return false;
      }
      if (needle.length > 0) {
        const hay = `${view.name}\n${view.created_by_name}\n${view.created_by}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [allSavedViews, filter, normalizedCurrentUserEmail]);

  const setSearch = useCallback((s: string) => {
    setFilter((f) => ({ ...f, search: s }));
  }, []);
  const setMineOnly = useCallback((v: boolean) => {
    setFilter((f) => ({ ...f, mineOnly: v }));
  }, []);

  const createSavedView = useCallback(
    async (name: string, view: SavedView): Promise<WorkspaceSavedView> => {
      const created = await apiCreate(workspaceId, name, view);
      setAllSavedViews((prev) => {
        if (prev.some((item) => item.id === created.id)) return prev;
        return [created, ...prev];
      });
      return created;
    },
    [workspaceId],
  );

  const renameSavedView = useCallback(
    async (id: string, name: string): Promise<WorkspaceSavedView> => {
      const original = allSavedViews.find((item) => item.id === id) ?? null;
      setAllSavedViews((prev) => prev.map((item) => (
        item.id === id ? { ...item, name } : item
      )));
      try {
        const updated = await apiUpdate(workspaceId, id, { name });
        setAllSavedViews((prev) => prev.map((item) => (
          item.id === id ? updated : item
        )));
        return updated;
      } catch (e) {
        if (original) {
          setAllSavedViews((prev) => prev.map((item) => (
            item.id === id ? original : item
          )));
        }
        throw e;
      }
    },
    [allSavedViews, workspaceId],
  );

  const replaceSavedView = useCallback(
    async (id: string, view: SavedView): Promise<WorkspaceSavedView> => {
      const updated = await apiUpdate(workspaceId, id, { view });
      setAllSavedViews((prev) => prev.map((item) => (
        item.id === id ? updated : item
      )));
      return updated;
    },
    [workspaceId],
  );

  const deleteSavedView = useCallback(async (id: string): Promise<void> => {
    const original = allSavedViews.find((item) => item.id === id) ?? null;
    setAllSavedViews((prev) => prev.filter((item) => item.id !== id));
    try {
      await apiDelete(workspaceId, id);
    } catch (e) {
      if (original) {
        setAllSavedViews((prev) => [original, ...prev.filter((item) => item.id !== id)]);
      }
      throw e;
    }
  }, [allSavedViews, workspaceId]);

  return {
    savedViews,
    allSavedViews,
    isLoading,
    error,
    filter,
    setSearch,
    setMineOnly,
    refresh,
    createSavedView,
    renameSavedView,
    replaceSavedView,
    deleteSavedView,
  };
}

export function defaultWorkspaceSavedViewName(
  datasetNames: readonly string[],
  activeLayoutName: string | null,
): string {
  if (datasetNames.length === 0) return "Untitled";
  let base = datasetNames.filter((name) => name.trim().length > 0).join(", ");
  if (base.length === 0) base = "Untitled";
  if (activeLayoutName && activeLayoutName.trim().length > 0) {
    base = `${base} - ${activeLayoutName}`;
  }
  return truncate(base, 60);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}
