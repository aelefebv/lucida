import {
  GlobeHemisphereWestIcon,
  LinkSimpleIcon,
  LockSimpleIcon,
  ShareNetworkIcon,
  UsersIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useRef, useState } from "react";
import type { SavedView } from "../savedView/types.ts";
import { Button } from "../ui/Button.tsx";
import { Popover } from "../ui/Popover.tsx";
import { getWorkspaceSharing, type WorkspaceSharingSettings } from "../workspaceApi.ts";
import { copyViewLink, viewLink } from "./viewLink.ts";
import { WorkspaceSharingDialog } from "./WorkspaceSharingDialog.tsx";
import "./ShareButton.css";

export interface ShareButtonProps {
  workspaceId: string;
  /** Whether this person may change who has access. Only owners may. */
  canManageAccess: boolean;
  /** The live view, checked for links that may not open elsewhere. */
  getCurrentSavedView: () => SavedView | null;
}

// Tagged with its workspace, so switching workspaces never shows the last one's access.
type AccessState =
  | { workspaceId: string; settings: WorkspaceSharingSettings }
  | { workspaceId: string; failed: true };

function accessSummary(
  canManageAccess: boolean,
  access: AccessState | null,
): { icon: Icon; text: string } {
  // Only owners may read the sharing settings.
  if (!canManageAccess) return { icon: UsersIcon, text: "Only the owner can change who has access" };
  if (access === null) return { icon: LockSimpleIcon, text: "Checking who has access…" };
  if ("failed" in access) return { icon: LockSimpleIcon, text: "Couldn’t check who has access" };
  const { link_access, link_role } = access.settings;
  if (link_access === "restricted") return { icon: LockSimpleIcon, text: "Only people with access" };
  return {
    icon: GlobeHemisphereWestIcon,
    text: link_role === "editor" ? "Anyone with the link can edit" : "Anyone with the link can view",
  };
}

/**
 * The one Share entry point. Copying a link to the current view comes first,
 * since that is what most people open it for; who can open the workspace
 * sits below.
 */
export function ShareButton({ workspaceId, canManageAccess, getCurrentSavedView }: ShareButtonProps) {
  const [manageOpen, setManageOpen] = useState(false);
  const [access, setAccess] = useState<AccessState | null>(null);
  const current = access?.workspaceId === workspaceId ? access : null;
  const { icon: AccessIcon, text: accessText } = accessSummary(canManageAccess, current);
  // Encoded as the popover opens, so Copy can write the clipboard straight
  // from the press.
  const linkRef = useRef<string | null>(null);

  const prepareLink = () => {
    linkRef.current = null;
    viewLink(getCurrentSavedView()).then(
      (link) => {
        linkRef.current = link;
      },
      () => {
        // Copy encodes again and reports the failure.
      },
    );
  };

  // Read on every opening, since another owner may have changed it.
  const refreshAccess = () => {
    if (!canManageAccess) return;
    getWorkspaceSharing(workspaceId).then(
      (settings) => setAccess({ workspaceId, settings }),
      () =>
        // Keep the last known access over a failed refresh.
        setAccess((prev) =>
          prev?.workspaceId === workspaceId && "settings" in prev ? prev : { workspaceId, failed: true },
        ),
    );
  };

  return (
    <>
      <Popover
        label="Share"
        placement="bottom end"
        className="lc-share-popover"
        onOpenChange={(isOpen) => {
          if (!isOpen) return;
          prepareLink();
          refreshAccess();
        }}
        trigger={
          <Button variant="primary" icon={ShareNetworkIcon}>
            Share
          </Button>
        }
      >
        {(close) => (
          <div className="lc-share">
            <Button
              variant="primary"
              icon={LinkSimpleIcon}
              autoFocus
              className="lc-share-copy"
              onPress={() => {
                close();
                const view = getCurrentSavedView();
                void copyViewLink(linkRef.current ?? viewLink(view), view);
              }}
            >
              Copy link to this view
            </Button>
            <div className="lc-share-divider" role="presentation" />
            <div className="lc-share-access">
              <AccessIcon className="lc-share-access-icon" size={16} aria-hidden />
              <span className="lc-share-access-text">{accessText}</span>
              {canManageAccess && (
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => {
                    close();
                    setManageOpen(true);
                  }}
                >
                  Manage access&hellip;
                </Button>
              )}
            </div>
          </div>
        )}
      </Popover>
      {canManageAccess && (
        <WorkspaceSharingDialog
          workspaceId={workspaceId}
          isOpen={manageOpen}
          onOpenChange={setManageOpen}
          onSettingsChange={(settings) => setAccess({ workspaceId, settings })}
        />
      )}
    </>
  );
}
