import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  defaultBookmarkName,
  relativeTimeFromIso,
  useBookmarks,
  type Bookmark,
} from "../savedView/useBookmarks.ts";
import type { Bridge } from "../bridge.ts";
import type { SavedView } from "../savedView/types.ts";
import "./BookmarkSidebar.css";

export interface BookmarkSidebarProps {
  /** Live URLs of currently-loaded datasets — drives the `?dataset=…` filter. */
  loadedDatasets: readonly string[];
  /** Email of the authed principal, or null while loading. Drives "Mine only". */
  currentUserEmail: string | null;
  /** Current SavedView used as the basis for "Save current view". */
  getCurrentSavedView: () => SavedView | null;
  /** Active layout name for the default-name suggestion. May be null. */
  activeLayoutName?: string | null;
  /** Style for parent layout (width / height passed through). */
  style?: React.CSSProperties;
  /** Visible flag. Parent toggles this to collapse/expand the panel. */
  visible: boolean;
  /** WebSocket bridge for live cross-peer sidebar updates. When
   *  provided, the hook subscribes to `bookmark_changed` broadcasts
   *  and reconciles local state on Created/Updated/Deleted events
   *  without requiring a refresh. May be `null` until the bridge is
   *  constructed (initial render). */
  bridge?: Bridge | null;
}

interface ToastMessage {
  text: string;
  kind: "info" | "warn";
}

interface ConfirmRequest {
  bookmark: Bookmark;
}

interface MenuState {
  bookmarkId: string;
  /** Anchor pixel coords for absolute positioning. */
  x: number;
  y: number;
}

export function BookmarkSidebar({
  loadedDatasets,
  currentUserEmail,
  getCurrentSavedView,
  activeLayoutName,
  style,
  visible,
  bridge,
}: BookmarkSidebarProps) {
  const {
    bookmarks,
    isLoading,
    error,
    filter,
    setSearch,
    setMineOnly,
    createBookmark,
    renameBookmark,
    deleteBookmark,
  } = useBookmarks({
    loadedDatasets,
    currentUserEmail,
    bridge,
  });

  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ConfirmRequest | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const dismissToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((text: string, kind: ToastMessage["kind"] = "info") => {
    setToast({ text, kind });
    if (dismissToastTimer.current) clearTimeout(dismissToastTimer.current);
    dismissToastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  // Close the popover menu on any outside click or Esc.
  useEffect(() => {
    if (menu === null) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".bookmark-menu")) return;
      if (target?.closest(".bookmark-menu-btn")) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const openByHash = useCallback((id: string) => {
    // The single-origin replaceState here would also work, but assigning
    // window.location.hash triggers the popstate-equivalent path that
    // urlSync's bootstrap already handles. We use replaceState +
    // dispatchEvent to keep history clean and ensure even Safari fires
    // the listener (it doesn't always for direct hash assignment).
    const newHash = `#b=${encodeURIComponent(id)}`;
    const url = `${window.location.pathname}${window.location.search}${newHash}`;
    window.history.replaceState(window.history.state, "", url);
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  }, []);

  const handleSave = useCallback(
    async (name: string) => {
      const view = getCurrentSavedView();
      if (!view) {
        showToast("No active view to save", "warn");
        return;
      }
      try {
        await createBookmark(name, view.datasets, view);
        showToast(`Saved "${name}"`);
      } catch (e) {
        showToast(`Save failed: ${e instanceof Error ? e.message : String(e)}`, "warn");
      }
    },
    [createBookmark, getCurrentSavedView, showToast],
  );

  const handleRenameCommit = useCallback(
    async (id: string, name: string) => {
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        setRenameId(null);
        return;
      }
      try {
        await renameBookmark(id, trimmed);
      } catch (e) {
        showToast(`Rename failed: ${e instanceof Error ? e.message : String(e)}`, "warn");
      } finally {
        setRenameId(null);
      }
    },
    [renameBookmark, showToast],
  );

  const handleDelete = useCallback(
    async (b: Bookmark) => {
      try {
        await deleteBookmark(b.id);
        showToast(`Deleted "${b.name}"`);
      } catch (e) {
        showToast(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "warn");
      } finally {
        setConfirmDelete(null);
      }
    },
    [deleteBookmark, showToast],
  );

  const handleCopyLink = useCallback(
    async (b: Bookmark) => {
      const url = `${window.location.origin}/#b=${encodeURIComponent(b.id)}`;
      try {
        await navigator.clipboard.writeText(url);
        showToast("Bookmark link copied");
      } catch (e) {
        showToast(`Copy failed: ${e instanceof Error ? e.message : String(e)}`, "warn");
      }
    },
    [showToast],
  );

  const defaultName = useMemo(() => {
    const view = getCurrentSavedView();
    const datasets = view?.datasets ?? [];
    return defaultBookmarkName(datasets, activeLayoutName ?? null);
  }, [getCurrentSavedView, activeLayoutName]);

  if (!visible) return null;

  const list = bookmarks;
  const showEmptyState = !isLoading && list.length === 0;
  const emptyText = pickEmptyMessage({
    hasAnyDatasets: loadedDatasets.length > 0,
    filterActive: filter.search.trim().length > 0 || filter.mineOnly,
  });

  return (
    <div className="bookmark-sidebar" style={style}>
      <div className="bookmark-sidebar-header">
        <h3>Bookmarks</h3>
        <button
          type="button"
          className="primary"
          onClick={() => setSavePromptOpen(true)}
          title="Save the current view as a bookmark"
        >
          Save current view
        </button>
      </div>

      <div className="bookmark-filter-row">
        <input
          type="text"
          className="bookmark-search"
          placeholder="Search name or creator…"
          value={filter.search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="bookmark-mine-toggle">
          <input
            type="checkbox"
            checked={filter.mineOnly}
            onChange={(e) => setMineOnly(e.target.checked)}
          />
          Mine only
        </label>
      </div>

      {error && <div className="bookmark-error">Error: {error}</div>}
      {isLoading && <div className="bookmark-loading">Loading bookmarks…</div>}

      <div className="bookmark-list" role="list">
        {list.map((b) => (
          <div
            key={b.id}
            role="listitem"
            className="bookmark-row"
            onClick={(e) => {
              // Skip if click originated in the menu button or in the
              // inline rename input.
              const target = e.target as HTMLElement | null;
              if (target?.closest(".bookmark-menu-btn")) return;
              if (target?.closest(".bookmark-name-input")) return;
              if (renameId === b.id) return;
              openByHash(b.id);
            }}
          >
            <div className="bookmark-row-top">
              {renameId === b.id ? (
                <RenameInput
                  initial={b.name}
                  onCommit={(n) => handleRenameCommit(b.id, n)}
                  onCancel={() => setRenameId(null)}
                />
              ) : (
                <span className="bookmark-name" title={b.name}>{b.name}</span>
              )}
              <button
                type="button"
                className="bookmark-menu-btn"
                aria-label="Bookmark actions"
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setMenu({ bookmarkId: b.id, x: rect.right, y: rect.bottom });
                }}
              >
                ⋯
              </button>
            </div>
            <div className="bookmark-row-meta">
              {b.created_by_name || b.created_by} · {relativeTimeFromIso(b.created_at)}
            </div>
          </div>
        ))}
        {showEmptyState && <div className="bookmark-empty">{emptyText}</div>}
      </div>

      {menu && (
        <BookmarkActionsMenu
          x={menu.x}
          y={menu.y}
          onRename={() => {
            setRenameId(menu.bookmarkId);
            setMenu(null);
          }}
          onDelete={() => {
            const b = list.find((x) => x.id === menu.bookmarkId);
            setMenu(null);
            if (b) setConfirmDelete({ bookmark: b });
          }}
          onCopyLink={() => {
            const b = list.find((x) => x.id === menu.bookmarkId);
            setMenu(null);
            if (b) void handleCopyLink(b);
          }}
        />
      )}

      {savePromptOpen && (
        <SaveBookmarkModal
          defaultName={defaultName}
          onCancel={() => setSavePromptOpen(false)}
          onSave={async (name) => {
            setSavePromptOpen(false);
            await handleSave(name);
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmDeleteModal
          name={confirmDelete.bookmark.name}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => handleDelete(confirmDelete.bookmark)}
        />
      )}

      {toast && (
        <div
          role="status"
          className={`bookmark-toast${toast.kind === "warn" ? " warn" : ""}`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

function pickEmptyMessage({
  hasAnyDatasets,
  filterActive,
}: {
  hasAnyDatasets: boolean;
  filterActive: boolean;
}): string {
  if (filterActive) return "No bookmarks match the current filter.";
  if (!hasAnyDatasets) {
    return "No bookmarks yet — save the current view to get started.";
  }
  return "No bookmarks for currently loaded datasets — try clearing the filter or saving the current view.";
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      type="text"
      className="bookmark-name-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

function BookmarkActionsMenu({
  x,
  y,
  onRename,
  onDelete,
  onCopyLink,
}: {
  x: number;
  y: number;
  onRename: () => void;
  onDelete: () => void;
  onCopyLink: () => void;
}) {
  // Position so the menu's right edge aligns with the anchor's right edge.
  return (
    <div
      className="bookmark-menu"
      style={{ left: x - 160, top: y + 4 }}
      role="menu"
    >
      <button type="button" role="menuitem" onClick={onRename}>Rename</button>
      <button type="button" role="menuitem" onClick={onCopyLink}>Copy bookmark link</button>
      <button type="button" role="menuitem" className="danger" onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}

function SaveBookmarkModal({
  defaultName,
  onCancel,
  onSave,
}: {
  defaultName: string;
  onCancel: () => void;
  onSave: (name: string) => void | Promise<void>;
}) {
  const [name, setName] = useState(defaultName);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className="bookmark-save-overlay" onClick={onCancel}>
      <div
        className="bookmark-save-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Save current view"
      >
        <h4>Save current view</h4>
        <input
          ref={ref}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (name.trim()) onSave(name.trim());
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        <div className="bookmark-save-modal-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="primary"
            disabled={name.trim().length === 0}
            onClick={() => onSave(name.trim())}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmDeleteModal({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="bookmark-confirm-overlay" onClick={onCancel}>
      <div
        className="bookmark-confirm-modal"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-label="Confirm delete"
      >
        <h4>Delete bookmark?</h4>
        <p>
          Delete bookmark <strong>"{name}"</strong>? This can't be undone.
        </p>
        <div className="bookmark-confirm-modal-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="danger" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
