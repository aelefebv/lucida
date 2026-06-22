import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  approveWorkspaceSavedView as apiApprove,
  createWorkspaceSavedView as apiCreate,
  deleteWorkspaceSavedView as apiDelete,
  listWorkspaceSavedViews as apiList,
  rejectWorkspaceSavedView as apiReject,
  setWorkspaceSavedViewVisibility as apiSetVisibility,
  updateWorkspaceSavedView as apiUpdate,
  type WorkspaceSavedView,
  type WorkspaceSavedViewVisibility,
} from "../workspaceApi.ts";
import type { SavedView, ViewState } from "./types.ts";

export type {
  WorkspaceSavedView,
  WorkspaceSavedViewVisibility,
} from "../workspaceApi.ts";

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
  createSavedView: (
    name: string,
    view: SavedView,
    visibility?: WorkspaceSavedViewVisibility,
  ) => Promise<WorkspaceSavedView>;
  renameSavedView: (id: string, name: string) => Promise<WorkspaceSavedView>;
  replaceSavedView: (id: string, view: SavedView) => Promise<WorkspaceSavedView>;
  setSavedViewVisibility: (
    id: string,
    visibility: WorkspaceSavedViewVisibility,
  ) => Promise<WorkspaceSavedView>;
  /** Approve a pending proposal (editor-only): it becomes shared. Refreshes
   *  the list so the review queue and the shared section both update. */
  approveSavedView: (id: string) => Promise<WorkspaceSavedView>;
  /** Reject a pending proposal (editor-only): it reverts to the proposer's
   *  personal view and leaves the editor's review queue. Refreshes. */
  rejectSavedView: (id: string) => Promise<WorkspaceSavedView>;
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
    async (
      name: string,
      view: SavedView,
      visibility?: WorkspaceSavedViewVisibility,
    ): Promise<WorkspaceSavedView> => {
      const created = await apiCreate(workspaceId, name, view, visibility);
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

  const setSavedViewVisibility = useCallback(
    async (
      id: string,
      visibility: WorkspaceSavedViewVisibility,
    ): Promise<WorkspaceSavedView> => {
      // Use the server's canonical row (it preserves created_by and bumps
      // updated_at) rather than guessing the next shape locally, so the chip,
      // "mine only" filter, and ordering all reflect the real post-promote
      // state.
      const updated = await apiSetVisibility(workspaceId, id, visibility);
      setAllSavedViews((prev) => prev.map((item) => (
        item.id === id ? updated : item
      )));
      return updated;
    },
    [workspaceId],
  );

  const approveSavedView = useCallback(
    async (id: string): Promise<WorkspaceSavedView> => {
      // The proposal becomes shared and stays visible to the reviewing editor,
      // so swap in the server's canonical row immediately for a snappy UI, then
      // refresh so any concurrent review changes reconcile.
      const updated = await apiApprove(workspaceId, id);
      setAllSavedViews((prev) => prev.map((item) => (
        item.id === id ? updated : item
      )));
      void refresh();
      return updated;
    },
    [refresh, workspaceId],
  );

  const rejectSavedView = useCallback(
    async (id: string): Promise<WorkspaceSavedView> => {
      // A rejected proposal reverts to the proposer's PERSONAL view, which the
      // reviewing editor can no longer see — drop it from the list, then
      // refresh to reconcile with the server's authoritative view.
      const updated = await apiReject(workspaceId, id);
      setAllSavedViews((prev) => prev.filter((item) => item.id !== id));
      void refresh();
      return updated;
    },
    [refresh, workspaceId],
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
    setSavedViewVisibility,
    approveSavedView,
    rejectSavedView,
    deleteSavedView,
  };
}

export function defaultWorkspaceSavedViewName(
  datasetNames: readonly string[],
  activeLayoutName: string | null,
  view?: Pick<ViewState, "z_range" | "t" | "c"> | null,
): string {
  if (datasetNames.length === 0) return "Untitled";
  let base = datasetNames.filter((name) => name.trim().length > 0).join(", ");
  if (base.length === 0) base = "Untitled";
  if (activeLayoutName && activeLayoutName.trim().length > 0) {
    base = `${base} - ${activeLayoutName}`;
  }
  // Two views of the same dataset+layout differ only by where they're parked,
  // so append the position. The Z plane (the slab's start) always disambiguates;
  // T and C are added only when non-default, mirroring the URL encoder's
  // `t !== 0` / `c !== 0` defaults so an unmoved time/channel adds no noise.
  const position = positionSuffix(view);
  // Truncate the name part first so the distinguishing position isn't the thing
  // that gets cut off.
  if (position.length > 0) {
    return `${truncate(base, 60 - position.length - 3)} — ${position}`;
  }
  return truncate(base, 60);
}

function positionSuffix(
  view?: Pick<ViewState, "z_range" | "t" | "c"> | null,
): string {
  if (!view) return "";
  const parts = [`Z${view.z_range.start}`];
  if (view.t !== 0) parts.push(`T${view.t}`);
  if (view.c !== 0) parts.push(`C${view.c}`);
  return parts.join(" ");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}
