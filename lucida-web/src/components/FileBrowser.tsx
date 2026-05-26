import { useCallback, useEffect, useState } from "react";

interface BrowseEntry {
  name: string;
  type: "directory" | "file";
}

interface BrowseResponse {
  path: string;
  entries: BrowseEntry[];
}

interface FileBrowserProps {
  onSelect: (path: string) => void;
  onClose: () => void;
  serverPort?: number;
}

/**
 * Cross-platform filesystem browser. The server owns "what's the root?"
 * — sending an empty `path` asks for the platform-default root:
 *   - Unix: listing of `/` (response `path` = `"/"`)
 *   - Windows: synthetic drives list `c:`, `d:`, … (response `path` = `""`)
 *
 * The component is platform-agnostic: it stores whatever path the server
 * returned and joins entries onto it with `/` (canonical form is always
 * forward-slash). On Windows the empty string is the explicit sentinel
 * for "synthetic drives root" so `"" + "/" + name` would yield a bogus
 * `"/c:"`; `navigateTo` special-cases the empty-root case.
 */
export function FileBrowser({
  onSelect,
  onClose,
  serverPort = 9876,
}: FileBrowserProps) {
  const [currentPath, setCurrentPath] = useState(() => {
    // On first-ever open `saved` is null → use `""`, which the server
    // interprets as "give me the platform-default root." This avoids
    // hardcoding `"/"` (broken on Windows) on the client.
    const saved = sessionStorage.getItem("lucida-browse-path");
    return saved ?? "";
  });
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasZarrJson, setHasZarrJson] = useState(false);

  const browse = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      try {
        // Empty path → omit the query param so the server falls into
        // its platform-default-root branch. Otherwise URL-encode the
        // canonical-form path verbatim (it's already forward-slashed).
        const url = path
          ? `http://localhost:${serverPort}/api/browse?path=${encodeURIComponent(path)}`
          : `http://localhost:${serverPort}/api/browse`;
        const res = await fetch(url);
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || res.statusText);
        }
        const data: BrowseResponse = await res.json();
        setCurrentPath(data.path);
        setEntries(data.entries);
        setHasZarrJson(data.entries.some((e) => e.name === "zarr.json"));
        sessionStorage.setItem("lucida-browse-path", data.path);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [serverPort]
  );

  useEffect(() => {
    // Initial-mount fetch — `browse` setStates loading/entries internally.
    // The fetch IS the side effect we want; running it once on mount is the
    // intent (currentPath is already the prop value at this point).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    browse(currentPath);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const navigateTo = useCallback(
    (name: string) => {
      // Windows drives-root case: `currentPath` is `""` and entries are
      // already top-level paths like `c:` — joining with `"/"` would
      // produce a bogus `"/c:"` that doesn't canonicalize. Use the
      // entry name as the new path directly. On Unix `currentPath` is
      // `"/"` here, never empty, so the normal join branch applies.
      const next = currentPath ? `${currentPath}/${name}` : name;
      browse(next);
    },
    [browse, currentPath]
  );

  const navigateUp = useCallback(() => {
    // Strip the last `/segment` if there is one.
    const stripped = currentPath.replace(/\/[^/]*$/, "");
    if (stripped === currentPath) {
      // No `/` found — we're at a single-segment path like `c:`
      // (Windows drive root reached via the drives list). Going up
      // returns to the synthetic drives root (empty path).
      browse("");
      return;
    }
    if (stripped === "") {
      // Stripping took us back to platform root. On Unix this means
      // we were at `/foo` and the regex left `""`; sending `""` makes
      // the server reply with the platform-default root.
      browse("");
      return;
    }
    browse(stripped);
  }, [browse, currentPath]);

  const handleOpen = useCallback(() => {
    onSelect(currentPath);
    onClose();
  }, [currentPath, onSelect, onClose]);

  // Breadcrumb segments — works for both Unix (`/foo/bar`) and Windows
  // (`c:/Users/me`) because both use forward slashes throughout.
  const segments = currentPath.split("/").filter(Boolean);
  // Preserve a leading `/` when rebuilding segment paths so Unix paths
  // stay absolute (`/foo/bar`) and Windows paths stay drive-letter form
  // (`c:/Users/me`). The first character is the only signal we need.
  const leadingSlash = currentPath.startsWith("/") ? "/" : "";
  // True when we're at the platform-default root (synthetic drives root
  // on Windows, `/` on Unix). The `..` button and root-vs-not styling
  // both key off this.
  const atRoot = currentPath === "" || currentPath === "/";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.5)",
        backdropFilter: "blur(4px)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "#1a1a1a",
          border: "1px solid rgba(255, 255, 255, 0.1)",
          borderRadius: 8,
          width: 520,
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          fontFamily: "system-ui, -apple-system, sans-serif",
          color: "white",
          fontSize: 13,
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid rgba(255, 255, 255, 0.1)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ fontWeight: 600 }}>Browse Local Files</span>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "rgba(255,255,255,0.5)",
              fontSize: 18,
              cursor: "pointer",
              padding: "0 4px",
            }}
          >
            ×
          </button>
        </div>

        {/* Breadcrumb path */}
        <div
          style={{
            padding: "8px 16px",
            borderBottom: "1px solid rgba(255, 255, 255, 0.05)",
            display: "flex",
            alignItems: "center",
            gap: 2,
            fontSize: 12,
            overflow: "hidden",
          }}
        >
          <button
            onClick={() => browse("")}
            style={{
              background: "none",
              border: "none",
              color: "rgba(255,255,255,0.5)",
              cursor: "pointer",
              padding: "2px 4px",
              fontSize: 12,
            }}
          >
            /
          </button>
          {segments.map((seg, i) => (
            <span key={i} style={{ display: "flex", alignItems: "center" }}>
              <span style={{ color: "rgba(255,255,255,0.3)", margin: "0 2px" }}>
                /
              </span>
              <button
                onClick={() =>
                  browse(leadingSlash + segments.slice(0, i + 1).join("/"))
                }
                style={{
                  background: "none",
                  border: "none",
                  color:
                    i === segments.length - 1
                      ? "rgba(255,255,255,0.9)"
                      : "rgba(255,255,255,0.5)",
                  cursor: "pointer",
                  padding: "2px 4px",
                  fontSize: 12,
                  whiteSpace: "nowrap",
                }}
              >
                {seg}
              </button>
            </span>
          ))}
        </div>

        {/* Entry list */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "4px 0",
            minHeight: 200,
          }}
        >
          {loading && (
            <div
              style={{
                padding: 16,
                textAlign: "center",
                color: "rgba(255,255,255,0.4)",
              }}
            >
              Loading...
            </div>
          )}
          {error && (
            <div style={{ padding: 16, color: "#f44" }}>{error}</div>
          )}
          {!loading && !error && (
            <>
              {/* Up directory — hidden at the platform-default root */}
              {!atRoot && (
                <button
                  onClick={navigateUp}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    padding: "6px 16px",
                    background: "none",
                    border: "none",
                    color: "rgba(255,255,255,0.5)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 13,
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background =
                      "rgba(255,255,255,0.05)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "none")
                  }
                >
                  ..
                </button>
              )}
              {entries.map((entry) => (
                <button
                  key={entry.name}
                  onClick={() => {
                    if (entry.type === "directory") navigateTo(entry.name);
                  }}
                  disabled={entry.type !== "directory"}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    padding: "6px 16px",
                    background: "none",
                    border: "none",
                    color:
                      entry.type === "directory"
                        ? "rgba(255,255,255,0.85)"
                        : "rgba(255,255,255,0.35)",
                    cursor:
                      entry.type === "directory" ? "pointer" : "default",
                    textAlign: "left",
                    fontSize: 13,
                  }}
                  onMouseEnter={(e) => {
                    if (entry.type === "directory")
                      e.currentTarget.style.background =
                        "rgba(255,255,255,0.05)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "none";
                  }}
                >
                  <span style={{ opacity: 0.5, fontSize: 11 }}>
                    {entry.type === "directory" ? "\u{1F4C1}" : "\u{1F4C4}"}
                  </span>
                  {entry.name}
                </button>
              ))}
              {entries.length === 0 && !loading && (
                <div
                  style={{
                    padding: 16,
                    textAlign: "center",
                    color: "rgba(255,255,255,0.3)",
                  }}
                >
                  Empty directory
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer with Open button */}
        <div
          style={{
            padding: "12px 16px",
            borderTop: "1px solid rgba(255, 255, 255, 0.1)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: hasZarrJson
                ? "rgba(100, 200, 100, 0.8)"
                : "rgba(255,255,255,0.3)",
            }}
          >
            {hasZarrJson ? "Zarr dataset detected" : "Navigate to a .zarr directory"}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onClose}
              style={{
                padding: "6px 16px",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 4,
                background: "none",
                color: "rgba(255,255,255,0.7)",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleOpen}
              disabled={!hasZarrJson}
              style={{
                padding: "6px 16px",
                border: "none",
                borderRadius: 4,
                background: hasZarrJson
                  ? "rgba(100, 108, 255, 0.8)"
                  : "rgba(100, 108, 255, 0.2)",
                color: hasZarrJson ? "white" : "rgba(255,255,255,0.3)",
                cursor: hasZarrJson ? "pointer" : "default",
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              Open
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
