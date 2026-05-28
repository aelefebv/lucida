// ProfileMenu — avatar + display name + email + Sign Out, dropdown
// menu in the bottom-left corner of the app chrome.
//
// Reads the current principal and `signOut` from `<AuthGate>`'s
// `AuthSessionContext` rather than props, so dropping it anywhere
// inside the authed subtree works without rewiring the host.
//
// Avatar: uses `picture_url` when present (real OAuth); falls back to
// a coloured circle showing the first letter of the display name.
// Dev sessions arrive with `picture_url = null`, so the fallback
// path is the visible default in development.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthSession } from "./AuthSession.ts";
import { fetchDevAuthStatus, postDevLogin } from "./whoami.ts";

export function ProfileMenu() {
  const { principal, refresh, signOut } = useAuthSession();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [pending, setPending] = useState(false);
  const [devAuthEnabled, setDevAuthEnabled] = useState(false);
  const [devEmail, setDevEmail] = useState(principal.email);
  const [devDisplayName, setDevDisplayName] = useState(principal.display_name);
  const [devAdmin, setDevAdmin] = useState(false);
  const [devPending, setDevPending] = useState(false);
  const [devError, setDevError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nameVisible = hovered || open;

  useEffect(() => {
    let cancelled = false;
    void fetchDevAuthStatus().then((status) => {
      if (!cancelled) setDevAuthEnabled(status.enabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const handleToggle = useCallback(() => {
    const nextOpen = !open;
    if (nextOpen) {
      setDevEmail(principal.email);
      setDevDisplayName(principal.display_name);
      setDevAdmin(false);
      setDevError(null);
    }
    setOpen(nextOpen);
  }, [open, principal.display_name, principal.email]);

  const handleDevSwitch = useCallback(async () => {
    if (devPending) return;
    setDevPending(true);
    setDevError(null);
    try {
      await postDevLogin({
        email: devEmail,
        display_name: devDisplayName,
        is_admin: devAdmin,
      });
      await refresh();
      setOpen(false);
    } catch (e) {
      setDevError(e instanceof Error ? e.message : String(e));
    } finally {
      setDevPending(false);
    }
  }, [devAdmin, devDisplayName, devEmail, devPending, refresh]);

  return (
    <div
      ref={containerRef}
      data-testid="profile-menu"
      style={{
        position: "absolute",
        bottom: 8,
        left: 12,
        zIndex: 100,
        fontSize: "0.875rem",
      }}
    >
      <button
        type="button"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={handleToggle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: nameVisible ? 8 : 0,
          padding: nameVisible ? "4px 8px" : 4,
          background: "rgba(20, 20, 24, 0.85)",
          color: "#eee",
          border: "1px solid #444",
          borderRadius: 999,
          cursor: "pointer",
          font: "inherit",
          transition: "padding 150ms ease, gap 150ms ease",
        }}
      >
        <Avatar
          pictureUrl={principal.picture_url}
          displayName={principal.display_name}
        />
        <span
          style={{
            maxWidth: nameVisible ? 160 : 0,
            opacity: nameVisible ? 1 : 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            transition: "max-width 150ms ease, opacity 150ms ease",
          }}
        >
          {principal.display_name}
        </span>
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            bottom: "calc(100% + 4px)",
            left: 0,
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
          {devAuthEnabled && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleDevSwitch();
              }}
              style={{
                padding: "8px 12px",
                borderBottom: "1px solid #333",
                display: "grid",
                gap: 6,
              }}
            >
              <div style={{ fontWeight: 600, fontSize: "0.8125rem" }}>Dev user</div>
              <input
                type="email"
                aria-label="Dev user email"
                value={devEmail}
                onChange={(e) => setDevEmail(e.target.value)}
                placeholder="viewer@example.com"
                disabled={devPending}
                style={devInputStyle}
              />
              <input
                type="text"
                aria-label="Dev display name"
                value={devDisplayName}
                onChange={(e) => setDevDisplayName(e.target.value)}
                placeholder="Display name"
                disabled={devPending}
                style={devInputStyle}
              />
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  color: "#ccc",
                  fontSize: "0.8125rem",
                }}
              >
                <input
                  type="checkbox"
                  checked={devAdmin}
                  disabled={devPending}
                  onChange={(e) => setDevAdmin(e.target.checked)}
                />
                Admin override
              </label>
              {devError && (
                <div style={{ color: "#ffb4b4", fontSize: "0.8125rem" }}>
                  {devError}
                </div>
              )}
              <button
                type="submit"
                disabled={devPending || !devEmail.trim()}
                style={{
                  ...menuButtonStyle,
                  color: devPending || !devEmail.trim() ? "#888" : "#eee",
                  cursor: devPending || !devEmail.trim() ? "default" : "pointer",
                }}
              >
                {devPending ? "Switching..." : "Switch dev user"}
              </button>
            </form>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={handleSignOut}
            disabled={pending}
            style={{
              ...menuButtonStyle,
              color: pending ? "#888" : "#eee",
              cursor: pending ? "default" : "pointer",
            }}
          >
            {pending ? "Signing out..." : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}

const menuButtonStyle = {
  display: "block",
  width: "100%",
  padding: "8px 12px",
  background: "none",
  border: "none",
  textAlign: "left" as const,
  font: "inherit",
};

const devInputStyle = {
  minWidth: 0,
  padding: "6px 8px",
  border: "1px solid #444",
  borderRadius: 6,
  background: "#111",
  color: "#eee",
  font: "inherit",
};

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
