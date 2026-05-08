// ProfileMenu — avatar + display name + email + Sign Out, dropdown
// menu in the top-right corner of the app chrome.
//
// Slice 3 (issue #459) introduces this component. Reads the current
// principal and `signOut` from `<AuthGate>`'s `AuthSessionContext`
// rather than props, so dropping it anywhere inside the authed
// subtree works without rewiring the host.
//
// Avatar: uses `picture_url` when present (real OAuth, slice 4+);
// falls back to a coloured circle showing the first letter of the
// display name. Dev sessions land here with `picture_url = null`,
// so the fallback path is the visible default until OAuth lands.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthSession } from "./AuthSession.ts";

export function ProfileMenu() {
  const { principal, signOut } = useAuthSession();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close on click-outside. Bound only while the menu is open so we
  // don't pay for a global listener at all times.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const handleSignOut = useCallback(async () => {
    if (pending) return;
    setPending(true);
    try {
      await signOut();
      // setOpen happens before unmount; AuthGate will re-render to
      // the unauth branch once the refresh completes.
      setOpen(false);
    } finally {
      setPending(false);
    }
  }, [pending, signOut]);

  return (
    <div
      ref={containerRef}
      data-testid="profile-menu"
      style={{
        position: "absolute",
        top: 8,
        right: 12,
        zIndex: 100,
        fontSize: "0.875rem",
      }}
    >
      <button
        type="button"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          background: "rgba(20, 20, 24, 0.85)",
          color: "#eee",
          border: "1px solid #444",
          borderRadius: 999,
          cursor: "pointer",
          font: "inherit",
        }}
      >
        <Avatar
          pictureUrl={principal.picture_url}
          displayName={principal.display_name}
        />
        <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {principal.display_name}
        </span>
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: 220,
            padding: "8px 0",
            background: "#1a1a1f",
            color: "#eee",
            border: "1px solid #444",
            borderRadius: 8,
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{ padding: "4px 12px 8px", borderBottom: "1px solid #333" }}>
            <div style={{ fontWeight: 600 }}>{principal.display_name}</div>
            <div style={{ color: "#aaa", fontSize: "0.8125rem", overflow: "hidden", textOverflow: "ellipsis" }}>
              {principal.email}
            </div>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={handleSignOut}
            disabled={pending}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 12px",
              background: "none",
              color: pending ? "#888" : "#eee",
              border: "none",
              textAlign: "left",
              cursor: pending ? "default" : "pointer",
              font: "inherit",
            }}
          >
            {pending ? "Signing out..." : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}

// Avatar: image when `picture_url` is present, coloured initial circle
// otherwise. Kept inline (rather than a separate file) because it
// only ever renders inside the menu and has no other consumer.
function Avatar({
  pictureUrl,
  displayName,
}: {
  pictureUrl: string | null;
  displayName: string;
}) {
  const initial = (displayName.trim().charAt(0) || "?").toUpperCase();
  const size = 24;
  if (pictureUrl) {
    return (
      <img
        src={pictureUrl}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover" }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        background: "#646cff",
        color: "#fff",
        fontWeight: 600,
        fontSize: "0.8125rem",
      }}
    >
      {initial}
    </span>
  );
}
