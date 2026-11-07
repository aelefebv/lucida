// ProfileMenu: the signed-in person's avatar at the end of the top bar, and a
// dropdown with their name and email, "Restore my last view", the dev-user
// switcher when dev auth is on, and Sign out.
//
// Reads the current principal and `signOut` from `<AuthGate>`'s
// `AuthSessionContext` rather than props, so dropping it anywhere inside the
// authed subtree works without rewiring the host.
//
// A non-null `signOut` means the auth mode declared a sign-out URL. Disabled
// mode declares none, so the menu leaves the item out rather than offering one
// that clears nothing.
//
// The avatar is the `picture_url` image when there is one and it loads,
// otherwise initials. Dev sessions arrive with `picture_url = null`, so the
// initials are the visible default in development.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthSession } from "./AuthSession.ts";
import { useDevAuthEnabled } from "./useDevAuthEnabled.ts";
import { postDevLogin } from "./whoami.ts";
import {
  getRestoreLastViewEnabled,
  setRestoreLastViewEnabled,
} from "../lastViewPreference.ts";
import { Avatar } from "../ui/Avatar.tsx";
import "./ProfileMenu.css";

export function ProfileMenu() {
  const { principal } = useAuthSession();
  const devAuthEnabled = useDevAuthEnabled();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Close on a click outside or on Escape, which also returns focus to the
  // avatar. Bound only while open.
  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="lc-profile" data-testid="profile-menu">
      <button
        ref={triggerRef}
        type="button"
        className="lc-profile-trigger"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        title={principal.display_name}
        onClick={() => setOpen(!open)}
      >
        <Avatar name={principal.display_name} src={principal.picture_url ?? undefined} />
      </button>
      {open && (
        <div role="menu" className="lc-profile-menu" data-lc-overlay="">
          <ProfilePanel devAuthEnabled={devAuthEnabled} onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

export interface ProfilePanelProps {
  /** From `useDevAuthEnabled`, read where the panel's opener mounts. */
  devAuthEnabled: boolean;
  /** Runs after a dev-user switch or a sign-out. */
  onDone: () => void;
}

/**
 * What the account menu holds, for anywhere that shows it: who is signed in,
 * "Restore my last view", the dev-user switcher, and Sign out. Mount it as it
 * opens, since it reads its starting values then.
 */
export function ProfilePanel({ devAuthEnabled, onDone }: ProfilePanelProps) {
  const { principal, refresh, signOut } = useAuthSession();
  const [pending, setPending] = useState(false);
  const [devEmail, setDevEmail] = useState(principal.email);
  const [devDisplayName, setDevDisplayName] = useState(principal.display_name);
  const [devPending, setDevPending] = useState(false);
  const [devError, setDevError] = useState<string | null>(null);
  // Browser-local, default on; read as the panel opens so an edit made in
  // another tab shows.
  const [restoreLastView, setRestoreLastView] = useState(getRestoreLastViewEnabled);

  const handleRestoreLastViewToggle = useCallback((next: boolean) => {
    setRestoreLastView(next);
    setRestoreLastViewEnabled(next);
  }, []);

  const handleSignOut = useCallback(async () => {
    if (pending || !signOut) return;
    setPending(true);
    try {
      await signOut();
      // onDone runs before unmount; AuthGate re-renders to the unauth
      // branch once the refresh completes.
      onDone();
    } finally {
      setPending(false);
    }
  }, [pending, signOut, onDone]);

  const handleDevSwitch = useCallback(async () => {
    if (devPending) return;
    setDevPending(true);
    setDevError(null);
    try {
      await postDevLogin({
        email: devEmail,
        display_name: devDisplayName,
      });
      await refresh();
      onDone();
    } catch (e) {
      setDevError(e instanceof Error ? e.message : String(e));
    } finally {
      setDevPending(false);
    }
  }, [devDisplayName, devEmail, devPending, refresh, onDone]);

  return (
    <>
      <div className="lc-profile-section lc-profile-identity">
        <div className="lc-profile-name">{principal.display_name}</div>
        <div className="lc-profile-email">{principal.email}</div>
      </div>
      <div className="lc-profile-section">
        <label className="lc-profile-check">
          <input
            type="checkbox"
            checked={restoreLastView}
            onChange={(e) => handleRestoreLastViewToggle(e.target.checked)}
          />
          Restore my last view
        </label>
        <div className="lc-profile-hint">
          Reopen each workspace where you left off (a link with a view
          always wins).
        </div>
      </div>
      {devAuthEnabled && (
        <form
          className="lc-profile-section lc-profile-dev"
          onSubmit={(e) => {
            e.preventDefault();
            void handleDevSwitch();
          }}
        >
          <div className="lc-profile-dev-title">Dev user</div>
          <input
            type="email"
            className="lc-profile-input"
            aria-label="Dev user email"
            value={devEmail}
            onChange={(e) => setDevEmail(e.target.value)}
            placeholder="viewer@example.com"
            disabled={devPending}
          />
          <input
            type="text"
            className="lc-profile-input"
            aria-label="Dev display name"
            value={devDisplayName}
            onChange={(e) => setDevDisplayName(e.target.value)}
            placeholder="Display name"
            disabled={devPending}
          />
          {devError && <div className="lc-profile-error">{devError}</div>}
          <button
            type="submit"
            className="lc-profile-item"
            disabled={devPending || !devEmail.trim()}
          >
            {devPending ? "Switching…" : "Switch dev user"}
          </button>
        </form>
      )}
      {signOut && (
        <button
          type="button"
          role="menuitem"
          className="lc-profile-item"
          onClick={handleSignOut}
          disabled={pending}
        >
          {pending ? "Signing out…" : "Sign out"}
        </button>
      )}
    </>
  );
}
