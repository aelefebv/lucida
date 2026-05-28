import { useCallback, useEffect, useMemo, useState } from "react";
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
} from "./workspaceApi.ts";

interface Props {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
}

const memberRoles: WorkspaceRole[] = ["viewer", "editor", "owner"];
const linkRoles: Array<Exclude<WorkspaceRole, "owner">> = ["viewer", "editor"];

export function WorkspaceSharingDialog({ workspaceId, open, onClose }: Props) {
  const [settings, setSettings] = useState<WorkspaceSharingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("viewer");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getWorkspaceSharing(workspaceId)
      .then((nextSettings) => {
        if (!cancelled) setSettings(nextSettings);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId]);

  const sortedMembers = useMemo(() => settings?.members ?? [], [settings]);

  const handleAdd = useCallback(async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      const member = await addWorkspaceMember(workspaceId, trimmed, role);
      setSettings((prev) => upsertLocalMember(prev, member));
      setEmail("");
      setRole("viewer");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [email, role, workspaceId]);

  const handleLinkChange = useCallback(async (
    linkAccess: WorkspaceLinkAccess,
    linkRole: Exclude<WorkspaceRole, "owner">,
  ) => {
    setSaving(true);
    setError(null);
    try {
      setSettings(await updateWorkspaceLinkAccess(workspaceId, linkAccess, linkRole));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [workspaceId]);

  const handleMemberRoleChange = useCallback(async (member: WorkspaceMember, nextRole: WorkspaceRole) => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateWorkspaceMemberRole(workspaceId, member.email, nextRole);
      setSettings((prev) => upsertLocalMember(prev, updated));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [workspaceId]);

  const handleRemove = useCallback(async (member: WorkspaceMember) => {
    setSaving(true);
    setError(null);
    try {
      await removeWorkspaceMember(workspaceId, member.email);
      setSettings((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          members: prev.members.filter((m) => m.email !== member.email),
        };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [workspaceId]);

  if (!open) return null;

  const linkAccess = settings?.link_access ?? "restricted";
  const linkRole = settings?.link_role ?? "viewer";

  return (
    <div className="workspace-share-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="workspace-share-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Workspace sharing"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="workspace-share-header">
          <h2>Share Workspace</h2>
          <button type="button" onClick={onClose}>Close</button>
        </div>

        {error && <div className="workspace-share-error">{error}</div>}
        {loading && <div className="workspace-share-muted">Loading...</div>}

        {!loading && settings && (
          <>
            <div className="workspace-share-section">
              <label>
                <span>Link access</span>
                <select
                  value={linkAccess}
                  disabled={saving}
                  onChange={(e) => {
                    void handleLinkChange(e.target.value as WorkspaceLinkAccess, linkRole);
                  }}
                >
                  <option value="restricted">Restricted</option>
                  <option value="anyone_with_link">Anyone with link</option>
                </select>
              </label>
              <label>
                <span>Link role</span>
                <select
                  value={linkRole}
                  disabled={saving || linkAccess === "restricted"}
                  onChange={(e) => {
                    void handleLinkChange(linkAccess, e.target.value as Exclude<WorkspaceRole, "owner">);
                  }}
                >
                  {linkRoles.map((r) => (
                    <option key={r} value={r}>{roleLabel(r)}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="workspace-share-section">
              <form
                className="workspace-share-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleAdd();
                }}
              >
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="person@example.com"
                  disabled={saving}
                />
                <select
                  value={role}
                  disabled={saving}
                  onChange={(e) => setRole(e.target.value as WorkspaceRole)}
                >
                  {memberRoles.map((r) => (
                    <option key={r} value={r}>{roleLabel(r)}</option>
                  ))}
                </select>
                <button type="submit" disabled={saving || !email.trim()}>
                  Add
                </button>
              </form>
            </div>

            <div className="workspace-share-members">
              {sortedMembers.map((member) => (
                <div className="workspace-share-member" key={member.email}>
                  <div className="workspace-share-person">
                    <strong>{member.display_name || member.email}</strong>
                    <span>{member.email}</span>
                  </div>
                  <select
                    value={member.role}
                    disabled={saving}
                    onChange={(e) => {
                      void handleMemberRoleChange(member, e.target.value as WorkspaceRole);
                    }}
                  >
                    {memberRoles.map((r) => (
                      <option key={r} value={r}>{roleLabel(r)}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      void handleRemove(member);
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function roleLabel(role: WorkspaceRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function upsertLocalMember(
  settings: WorkspaceSharingSettings | null,
  member: WorkspaceMember,
): WorkspaceSharingSettings | null {
  if (!settings) return settings;
  const existing = settings.members.findIndex((m) => m.email === member.email);
  if (existing < 0) {
    return { ...settings, members: [...settings.members, member] };
  }
  const members = settings.members.slice();
  members[existing] = member;
  return { ...settings, members };
}
