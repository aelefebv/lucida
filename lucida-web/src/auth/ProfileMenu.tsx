// ProfileMenu: the signed-in person's avatar at the end of the top bar, and a
// menu with their name and email, "Restore my last view", the dev-user
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

import { useCallback, useState } from "react";
import { useAuthSession } from "./AuthSession.ts";
import { useDevAuthEnabled } from "./useDevAuthEnabled.ts";
import { postDevLogin } from "./whoami.ts";
import { restoreLastViewPreference } from "../lastViewPreference.ts";
import { usePreference } from "../theme/preferences.ts";
import { Avatar } from "../ui/Avatar.tsx";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Menu, MenuItem, MenuSection } from "../ui/Menu.tsx";
import { Switch } from "../ui/Switch.tsx";
import { TextField } from "../ui/TextField.tsx";
import { UnstyledButton } from "../ui/UnstyledButton.tsx";
import "./ProfileMenu.css";

const RESTORE_LAST_VIEW = "Restore my last view";
const RESTORE_LAST_VIEW_HINT =
  "Reopen each workspace where you left off (a link with a view always wins).";
const RESTORE_ITEM = "restore";

export function ProfileMenu() {
  const { principal } = useAuthSession();
  const devAuthEnabled = useDevAuthEnabled();
  const [restoreLastView, setRestoreLastView] = usePreference(restoreLastViewPreference);
  const signOut = useSignOut();
  const [switchingUser, setSwitchingUser] = useState(false);

  return (
    <div className="lc-profile" data-testid="profile-menu">
      <Menu
        label="Account"
        placement="bottom end"
        className="lc-profile-menu"
        trigger={
          <UnstyledButton
            className="lc-profile-trigger"
            aria-label="Account menu"
            title={principal.display_name}
          >
            <Avatar name={principal.display_name} src={principal.picture_url ?? undefined} />
          </UnstyledButton>
        }
      >
        <MenuSection
          header={<Identity />}
          selectionMode="multiple"
          selectedKeys={restoreLastView ? [RESTORE_ITEM] : []}
          onSelectionChange={(keys) => setRestoreLastView(keys === "all" || keys.has(RESTORE_ITEM))}
        >
          <MenuItem id={RESTORE_ITEM} description={RESTORE_LAST_VIEW_HINT}>
            {RESTORE_LAST_VIEW}
          </MenuItem>
        </MenuSection>
        {(devAuthEnabled || signOut) && (
          <MenuSection>
            {devAuthEnabled && (
              <MenuItem onAction={() => setSwitchingUser(true)}>Switch dev user…</MenuItem>
            )}
            {signOut && (
              <MenuItem onAction={signOut.run} isDisabled={signOut.pending}>
                {signOut.pending ? "Signing out…" : "Sign out"}
              </MenuItem>
            )}
          </MenuSection>
        )}
      </Menu>
      {devAuthEnabled && (
        <Dialog title="Switch dev user" size="sm" isOpen={switchingUser} onOpenChange={setSwitchingUser}>
          <DevUserForm onDone={() => setSwitchingUser(false)} />
        </Dialog>
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
 * What the account menu holds, laid out for a dialog: who is signed in,
 * "Restore my last view", the dev-user switcher, and Sign out.
 */
export function ProfilePanel({ devAuthEnabled, onDone }: ProfilePanelProps) {
  const [restoreLastView, setRestoreLastView] = usePreference(restoreLastViewPreference);
  const signOut = useSignOut(onDone);

  return (
    <>
      <div className="lc-profile-section">
        <Identity />
      </div>
      <div className="lc-profile-section">
        <Switch
          label={RESTORE_LAST_VIEW}
          description={RESTORE_LAST_VIEW_HINT}
          isSelected={restoreLastView}
          onChange={setRestoreLastView}
        />
      </div>
      {devAuthEnabled && (
        <div className="lc-profile-section">
          <div className="lc-profile-dev-title">Dev user</div>
          <DevUserForm onDone={onDone} />
        </div>
      )}
      {signOut && (
        <div className="lc-profile-section">
          <Button onPress={signOut.run} isDisabled={signOut.pending}>
            {signOut.pending ? "Signing out…" : "Sign out"}
          </Button>
        </div>
      )}
    </>
  );
}

function Identity() {
  const { principal } = useAuthSession();
  return (
    <>
      <div className="lc-profile-name">{principal.display_name}</div>
      <div className="lc-profile-email">{principal.email}</div>
    </>
  );
}

/** Sign out, or null when the auth mode declares no sign-out URL. */
function useSignOut(onDone?: () => void): { run: () => void; pending: boolean } | null {
  const { signOut } = useAuthSession();
  const [pending, setPending] = useState(false);
  const run = useCallback(async () => {
    if (pending || !signOut) return;
    setPending(true);
    try {
      await signOut();
      // onDone runs before unmount; AuthGate re-renders to the unauth
      // branch once the refresh completes.
      onDone?.();
    } finally {
      setPending(false);
    }
  }, [pending, signOut, onDone]);
  return signOut ? { run: () => void run(), pending } : null;
}

/** Signs in as another local user. Mount it as it opens: it starts from the current one. */
function DevUserForm({ onDone }: { onDone: () => void }) {
  const { principal, refresh } = useAuthSession();
  const [email, setEmail] = useState(principal.email);
  const [displayName, setDisplayName] = useState(principal.display_name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await postDevLogin({ email, display_name: displayName });
      await refresh();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="lc-profile-dev"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextField
        label="Email"
        type="email"
        value={email}
        onChange={setEmail}
        placeholder="viewer@example.com"
        isDisabled={pending}
      />
      <TextField
        label="Display name"
        value={displayName}
        onChange={setDisplayName}
        placeholder="Display name"
        isDisabled={pending}
      />
      {error && (
        <p className="lc-profile-error" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" className="lc-profile-dev-submit" isDisabled={pending || !email.trim()}>
        {pending ? "Switching…" : "Switch dev user"}
      </Button>
    </form>
  );
}
