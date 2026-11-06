import { GlobeHemisphereWestIcon, LockSimpleIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useEffectEvent, useState } from "react";
import { Avatar } from "../ui/Avatar.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import { TextField } from "../ui/TextField.tsx";
import { toast } from "../ui/toastQueue.ts";
import {
  addWorkspaceMember,
  getWorkspaceSharing,
  removeWorkspaceMember,
  updateWorkspaceLinkAccess,
  updateWorkspaceMemberRole,
  type WorkspaceLinkAccess,
  type WorkspaceMember,
  type WorkspaceRole,
  type WorkspaceSharingSettings,
} from "../workspaceApi.ts";
import "./WorkspaceSharingDialog.css";

type LinkRole = Exclude<WorkspaceRole, "owner">;

const MEMBER_ROLES: readonly SelectOption<WorkspaceRole>[] = [
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
  { value: "owner", label: "Owner" },
];

const LINK_ACCESS: readonly SelectOption<WorkspaceLinkAccess>[] = [
  { value: "restricted", label: "Only people with access" },
  { value: "anyone_with_link", label: "Anyone with the link" },
];

const LINK_ROLES: readonly SelectOption<LinkRole>[] = [
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
];

export interface WorkspaceSharingDialogProps {
  workspaceId: string;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Hears every loaded or saved state, so a summary elsewhere stays current. */
  onSettingsChange?: (settings: WorkspaceSharingSettings) => void;
}

/** Who may open the workspace: its members and its link. Owners only. */
export function WorkspaceSharingDialog({
  workspaceId,
  isOpen,
  onOpenChange,
  onSettingsChange,
}: WorkspaceSharingDialogProps) {
  return (
    <Dialog
      title="Manage access"
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      footer={(close) => (
        <Button variant="primary" onPress={close}>
          Done
        </Button>
      )}
    >
      <SharingSettings workspaceId={workspaceId} onSettingsChange={onSettingsChange} />
    </Dialog>
  );
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function personName(member: WorkspaceMember): string {
  return member.display_name || member.email;
}

// Mounted only while the dialog is open, so each opening loads fresh settings.
function SharingSettings({
  workspaceId,
  onSettingsChange,
}: {
  workspaceId: string;
  onSettingsChange?: (settings: WorkspaceSharingSettings) => void;
}) {
  const [settings, setSettings] = useState<WorkspaceSharingSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  // One request at a time: each response replaces the settings it was based on.
  const [saving, setSaving] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("viewer");

  const reportSettings = useEffectEvent((next: WorkspaceSharingSettings) => onSettingsChange?.(next));
  const show = (next: WorkspaceSharingSettings) => {
    setSettings(next);
    onSettingsChange?.(next);
  };

  useEffect(() => {
    let cancelled = false;
    getWorkspaceSharing(workspaceId).then(
      (next) => {
        if (cancelled) return;
        setSettings(next);
        reportSettings(next);
      },
      (e) => {
        if (!cancelled) setLoadError(errorText(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, loadAttempt]);

  if (loadError !== null) {
    return (
      <div className="lc-sharing-status" role="alert">
        <span>Couldn&rsquo;t load who has access. {loadError}</span>
        <Button
          size="sm"
          onPress={() => {
            setLoadError(null);
            setLoadAttempt((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (settings === null) {
    return <div className="lc-sharing-status">Loading&hellip;</div>;
  }

  const save = async (failure: string, request: () => Promise<WorkspaceSharingSettings>) => {
    setSaving(true);
    try {
      show(await request());
      return true;
    } catch (e) {
      toast({ title: failure, description: errorText(e), tone: "danger" });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const withMember = (member: WorkspaceMember): WorkspaceSharingSettings => {
    const index = settings.members.findIndex((m) => m.email === member.email);
    const members = settings.members.slice();
    if (index < 0) members.push(member);
    else members[index] = member;
    return { ...settings, members };
  };

  const add = async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    const added = await save(`Couldn't add ${trimmed}`, async () =>
      withMember(await addWorkspaceMember(workspaceId, trimmed, role)),
    );
    if (added) {
      setEmail("");
      setRole("viewer");
    }
  };

  const changeRole = (member: WorkspaceMember, next: WorkspaceRole) =>
    void save(`Couldn't change ${personName(member)}'s role`, async () =>
      withMember(await updateWorkspaceMemberRole(workspaceId, member.email, next)),
    );

  const remove = (member: WorkspaceMember) =>
    void save(`Couldn't remove ${personName(member)}`, async () => {
      await removeWorkspaceMember(workspaceId, member.email);
      return { ...settings, members: settings.members.filter((m) => m.email !== member.email) };
    });

  const changeLink = (access: WorkspaceLinkAccess, linkRole: LinkRole) =>
    void save("Couldn't change link access", () =>
      updateWorkspaceLinkAccess(workspaceId, access, linkRole),
    );

  const linkOpen = settings.link_access === "anyone_with_link";
  const LinkIcon = linkOpen ? GlobeHemisphereWestIcon : LockSimpleIcon;

  return (
    <div className="lc-sharing">
      <section className="lc-sharing-section" aria-labelledby="lc-sharing-add-heading">
        <h3 id="lc-sharing-add-heading" className="lc-sharing-heading">
          Add people
        </h3>
        <form
          className="lc-sharing-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <TextField
            label="Email"
            labelPosition="hidden"
            type="email"
            placeholder="name@example.com"
            value={email}
            onChange={setEmail}
            isDisabled={saving}
          />
          <Select
            label="Role for the new person"
            labelPosition="hidden"
            options={MEMBER_ROLES}
            value={role}
            onChange={setRole}
            isDisabled={saving}
          />
          <Button type="submit" isDisabled={saving || !email.trim()}>
            Add
          </Button>
        </form>
      </section>

      <section className="lc-sharing-section" aria-labelledby="lc-sharing-people-heading">
        <h3 id="lc-sharing-people-heading" className="lc-sharing-heading">
          People with access
        </h3>
        {settings.members.length === 0 ? (
          <p className="lc-sharing-empty">No one has been added yet.</p>
        ) : (
          <ul className="lc-sharing-members">
            {settings.members.map((member) => {
              const name = personName(member);
              return (
                <li className="lc-sharing-member" key={member.email}>
                  <Avatar name={name} size="lg" />
                  <div className="lc-sharing-person">
                    <span className="lc-sharing-name">{name}</span>
                    {name !== member.email && <span className="lc-sharing-email">{member.email}</span>}
                  </div>
                  <Select
                    label={`Role for ${name}`}
                    labelPosition="hidden"
                    options={MEMBER_ROLES}
                    value={member.role}
                    onChange={(next) => changeRole(member, next)}
                    isDisabled={saving}
                  />
                  <IconButton
                    icon={XIcon}
                    label={`Remove ${name}`}
                    size="sm"
                    isDisabled={saving}
                    onPress={() => remove(member)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="lc-sharing-section" aria-labelledby="lc-sharing-link-heading">
        <h3 id="lc-sharing-link-heading" className="lc-sharing-heading">
          General access
        </h3>
        <div className="lc-sharing-link" data-open={linkOpen || undefined}>
          <span className="lc-sharing-link-icon" aria-hidden>
            <LinkIcon size={16} />
          </span>
          <Select
            label="Link access"
            labelPosition="hidden"
            options={LINK_ACCESS}
            value={settings.link_access}
            onChange={(next) => changeLink(next, settings.link_role)}
            isDisabled={saving}
            className="lc-sharing-access"
          />
          {linkOpen && (
            <Select
              label="Link role"
              labelPosition="hidden"
              options={LINK_ROLES}
              value={settings.link_role}
              onChange={(next) => changeLink(settings.link_access, next)}
              isDisabled={saving}
              className="lc-sharing-role"
            />
          )}
          <p className="lc-sharing-help">
            {linkOpen
              ? `Anyone who has the link can open the workspace as ${settings.link_role === "editor" ? "an editor" : "a viewer"}.`
              : "Only the people above can open the workspace."}
          </p>
        </div>
      </section>
    </div>
  );
}
