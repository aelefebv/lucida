import {
  CaretLeftIcon,
  DotsThreeVerticalIcon,
  GearSixIcon,
  ImageSquareIcon,
  MagnifyingGlassIcon,
  ShareNetworkIcon,
  UserCircleIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { ProfilePanel } from "../../auth/ProfileMenu.tsx";
import { useDevAuthEnabled } from "../../auth/useDevAuthEnabled.ts";
import { ShareButton, type ShareButtonProps } from "../../share/ShareButton.tsx";
import { IconButton } from "../../ui/Button.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { showKeyboardHelp } from "../../ui/keyboardHelpState.ts";
import { Menu, MenuItem } from "../../ui/Menu.tsx";
import { CompactPresence, type PresenceAvatarsProps } from "../PresenceAvatars.tsx";
import { SettingsPanel } from "../SettingsMenu.tsx";
import { WorkspaceName } from "../TopBar.tsx";
import "./PhoneTopBar.css";

export interface PhoneTopBarProps {
  workspaceName: string;
  /** Renames the workspace; omit when the user may not. */
  onRenameWorkspace?: (name: string) => Promise<void>;
  onBackToDashboard: () => void;
  /** Makes the current view the workspace's dashboard preview; omit when the user may not. */
  onUseViewAsPreview?: () => void;
  share: Omit<ShareButtonProps, "dialog">;
  presence: PresenceAvatarsProps;
}

type MoreDialog = "share" | "settings" | "account";

/**
 * The phone's top bar: back to the workspaces, the workspace's name, who else
 * is here, search (the command palette), and a menu with Share, settings, and
 * the account, each opening as a dialog. The name gives way to the buttons,
 * so they stay reachable whatever its length.
 */
export function PhoneTopBar({
  workspaceName,
  onRenameWorkspace,
  onBackToDashboard,
  onUseViewAsPreview,
  share,
  presence,
}: PhoneTopBarProps) {
  const [dialog, setDialog] = useState<MoreDialog | null>(null);
  const devAuthEnabled = useDevAuthEnabled();
  const close = () => setDialog(null);
  const openChange = (which: MoreDialog) => (isOpen: boolean) => setDialog(isOpen ? which : null);

  return (
    <header className="lc-phone-topbar">
      <IconButton icon={CaretLeftIcon} label="All workspaces" tooltipPlacement="bottom" onPress={onBackToDashboard} />
      <div className="lc-phone-topbar-name">
        <WorkspaceName name={workspaceName} onRename={onRenameWorkspace} />
      </div>
      <CompactPresence {...presence} />
      <IconButton
        icon={MagnifyingGlassIcon}
        label="Search commands"
        shortcut="Mod+K"
        tooltipPlacement="bottom"
        onPress={() => showKeyboardHelp("commandPalette")}
      />
      <Menu
        label="More"
        placement="bottom end"
        trigger={<IconButton icon={DotsThreeVerticalIcon} label="More" tooltipPlacement="bottom" />}
      >
        <MenuItem icon={ShareNetworkIcon} onAction={() => setDialog("share")}>
          Share…
        </MenuItem>
        <MenuItem icon={GearSixIcon} onAction={() => setDialog("settings")}>
          Settings
        </MenuItem>
        <MenuItem icon={UserCircleIcon} onAction={() => setDialog("account")}>
          Account
        </MenuItem>
        {onUseViewAsPreview && (
          <MenuItem icon={ImageSquareIcon} onAction={onUseViewAsPreview}>
            Use this view as the preview
          </MenuItem>
        )}
      </Menu>
      <ShareButton {...share} dialog={{ isOpen: dialog === "share", onOpenChange: openChange("share") }} />
      <Dialog title="Settings" size="sm" isOpen={dialog === "settings"} onOpenChange={openChange("settings")}>
        <SettingsPanel />
      </Dialog>
      <Dialog title="Account" size="sm" isOpen={dialog === "account"} onOpenChange={openChange("account")}>
        <div className="lc-phone-account">
          <ProfilePanel devAuthEnabled={devAuthEnabled} onDone={close} />
        </div>
      </Dialog>
    </header>
  );
}
