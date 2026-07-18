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
import { useModalDialog } from "./hooks/useModalDialog.ts";
import { useLatestOperation } from "./hooks/useLatestOperation.ts";
import { OperationStatus } from "./components/OperationStatus.tsx";

interface Props {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
}

const memberRoles: WorkspaceRole[] = ["viewer", "editor", "owner"];
const linkRoles: Array<Exclude<WorkspaceRole, "owner">> = ["viewer", "editor"];

export function WorkspaceSharingDialog({ workspaceId, open, onClose }: Props) {
  const [reloadKey, setReloadKey] = useState(0);
  if (!open) return null;
  return (
    <WorkspaceSharingDialogContent
      key={`${workspaceId}:${reloadKey}`}
      workspaceId={workspaceId}
      onClose={onClose}
      onRetry={() => setReloadKey((key) => key + 1)}
    />
  );
}

interface ContentProps {
  workspaceId: string;
  onClose: () => void;
  onRetry: () => void;
}

/**
 * A load attempt is a fresh component instance. Re-keying on Retry (and
 * naturally unmounting while closed) gives loading/error/settings state a
 * single lifecycle instead of synchronously resetting several state cells in
 * an effect whenever the dialog reopens.
 */
function WorkspaceSharingDialogContent({ workspaceId, onClose, onRetry }: ContentProps) {
  const [settings, setSettings] = useState<WorkspaceSharingSettings | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("viewer");
  const { dialogRef, onKeyDown } = useModalDialog({ open: true, onClose });
  const {
    state: operationState,
    begin: beginOperation,
    dismiss: dismissOperation,
    isPending: isOperationPending,
    hasPending,
  } = useLatestOperation();
  const loading = settings === null && operationState.phase !== "error";
  const saving = hasPending && !isOperationPending("load:sharing");

  useEffect(() => {
    const attempt = beginOperation({
      key: "load:sharing",
      pendingMessage: "Loading sharing settings…",
      successMessage: "Sharing settings loaded.",
      failureMessage: "Could not load sharing settings.",
      retry: onRetry,
      replaceActive: true,
    });
    if (!attempt) return;
    void getWorkspaceSharing(workspaceId)
      .then((nextSettings) => {
        if (attempt.isCurrent()) setSettings(nextSettings);
        attempt.succeed();
      })
      .catch((e) => {
        attempt.fail(e);
      });
  }, [onRetry, beginOperation, workspaceId]);

  const sortedMembers = useMemo(() => settings?.members ?? [], [settings]);

  const handleAdd = useCallback(async function addMember() {
    const trimmed = email.trim();
    if (!trimmed) return;
    const attempt = beginOperation({
      key: `add:${trimmed.toLocaleLowerCase()}`,
      pendingMessage: `Adding ${trimmed}…`,
      successMessage: `Added ${trimmed}.`,
      failureMessage: `Could not add ${trimmed}.`,
      retry: () => { void addMember(); },
    });
    if (!attempt) return;
    try {
      const member = await addWorkspaceMember(workspaceId, trimmed, role);
      if (attempt.isCurrent()) {
        setSettings((prev) => upsertLocalMember(prev, member));
        setEmail("");
        setRole("viewer");
      }
      attempt.succeed();
    } catch (e) {
      attempt.fail(e);
    }
  }, [email, beginOperation, role, workspaceId]);

  const handleLinkChange = useCallback(async function changeLinkAccess(
    linkAccess: WorkspaceLinkAccess,
    linkRole: Exclude<WorkspaceRole, "owner">,
  ) {
    const attempt = beginOperation({
      key: "update:link",
      pendingMessage: "Updating link access…",
      successMessage: "Link access updated.",
      failureMessage: "Could not update link access.",
      retry: () => { void changeLinkAccess(linkAccess, linkRole); },
    });
    if (!attempt) return;
    try {
      const nextSettings = await updateWorkspaceLinkAccess(
        workspaceId,
        linkAccess,
        linkRole,
      );
      if (attempt.isCurrent()) {
        // This endpoint returns the full sharing document, but another
        // disjoint member mutation may have completed while it was in flight.
        // Commit only the fields this operation owns so both authoritative
        // successes remain visible regardless of completion order.
        setSettings((prev) => prev ? {
          ...prev,
          link_access: nextSettings.link_access,
          link_role: nextSettings.link_role,
        } : nextSettings);
      }
      attempt.succeed();
    } catch (e) {
      attempt.fail(e);
    }
  }, [beginOperation, workspaceId]);

  const handleMemberRoleChange = useCallback(async function changeMemberRole(
    member: WorkspaceMember,
    nextRole: WorkspaceRole,
  ) {
    const attempt = beginOperation({
      key: `update:member:${member.email.toLocaleLowerCase()}`,
      pendingMessage: `Updating ${member.email}…`,
      successMessage: `Updated ${member.email}.`,
      failureMessage: `Could not update ${member.email}.`,
      retry: () => { void changeMemberRole(member, nextRole); },
    });
    if (!attempt) return;
    try {
      const updated = await updateWorkspaceMemberRole(workspaceId, member.email, nextRole);
      if (attempt.isCurrent()) {
        setSettings((prev) => upsertLocalMember(prev, updated));
      }
      attempt.succeed();
    } catch (e) {
      attempt.fail(e);
    }
  }, [beginOperation, workspaceId]);

  const handleRemove = useCallback(async function removeMember(member: WorkspaceMember) {
    const attempt = beginOperation({
      key: `remove:${member.email.toLocaleLowerCase()}`,
      pendingMessage: `Removing ${member.email}…`,
      successMessage: `Removed ${member.email}.`,
      failureMessage: `Could not remove ${member.email}.`,
      retry: () => { void removeMember(member); },
    });
    if (!attempt) return;
    try {
      await removeWorkspaceMember(workspaceId, member.email);
      if (attempt.isCurrent()) {
        setSettings((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            members: prev.members.filter((m) => m.email !== member.email),
          };
        });
      }
      attempt.succeed();
    } catch (e) {
      attempt.fail(e);
    }
  }, [beginOperation, workspaceId]);

  const linkAccess = settings?.link_access ?? "restricted";
  const linkRole = settings?.link_role ?? "viewer";

  return (
    <div className="workspace-share-backdrop" role="presentation">
      <button
        type="button"
        className="workspace-share-backdrop-dismiss"
        aria-label="Close share dialog"
        tabIndex={-1}
        onClick={onClose}
      />
      {/* A focus-managed ARIA dialog has no native HTML equivalent; key events
          own Escape and focus wrapping inside useModalDialog. */}
      {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions -- focus-managed ARIA dialog */}
      <div
        ref={dialogRef}
        className="workspace-share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-share-title"
        aria-busy={hasPending}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="workspace-share-header">
          <h2 id="workspace-share-title">Share Workspace</h2>
          <button type="button" onClick={onClose}>Close</button>
        </div>

        <OperationStatus
          state={operationState}
          onDismiss={settings ? dismissOperation : onClose}
          className="workspace-share-operation"
        />

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
                  aria-label="Member email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="person@example.com"
                  disabled={saving}
                />
                <select
                  aria-label="Role for new member"
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
                    aria-label={`Role for ${member.email}`}
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
      {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions */}
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
