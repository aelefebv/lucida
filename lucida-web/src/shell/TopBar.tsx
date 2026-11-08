import {
  CaretDownIcon,
  ChartLineIcon,
  CopyIcon,
  GaugeIcon,
  ImageSquareIcon,
  MagnifyingGlassIcon,
  SidebarSimpleIcon,
  SquaresFourIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Input, TextField as AriaTextField } from "react-aria-components";
import { ProfileMenu } from "../auth/ProfileMenu.tsx";
import { IconButton } from "../ui/Button.tsx";
import { showKeyboardHelp } from "../ui/keyboardHelpState.ts";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { toast } from "../ui/toastQueue.ts";
import { LucidaMark } from "./LucidaMark.tsx";
import { PresenceAvatars, type PresenceAvatarsProps } from "./PresenceAvatars.tsx";
import { SettingsMenu } from "./SettingsMenu.tsx";
import { usePanelOpen } from "./sidePanels.ts";
import type { DeveloperSurfaces } from "./useDeveloperSurfaces.ts";
import "./TopBar.css";

export interface TopBarProps {
  workspaceId: string;
  workspaceName: string;
  /** Renames the workspace; omit when the user may not. */
  onRenameWorkspace?: (name: string) => Promise<void>;
  onBackToDashboard: () => void;
  /** Makes the current view the workspace's dashboard preview; omit when the user may not. */
  onUseViewAsPreview?: () => void;
  presence: PresenceAvatarsProps;
  /** The Share control. */
  share?: ReactNode;
  developer: DeveloperSurfaces;
}

/** One row across the top: where you are, who else is here, and settings. */
export function TopBar({
  workspaceId,
  workspaceName,
  onRenameWorkspace,
  onBackToDashboard,
  onUseViewAsPreview,
  presence,
  share,
  developer,
}: TopBarProps) {
  const [leftOpen, setLeftOpen] = usePanelOpen("left");

  const goToDashboard = (event: MouseEvent<HTMLAnchorElement>) => {
    // A modified click opens the list in a new tab, as a link should.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onBackToDashboard();
  };

  const copyWorkspaceId = () => {
    navigator.clipboard.writeText(workspaceId).then(
      () => toast({ title: "Workspace id copied", tone: "success" }),
      () => toast({ title: "Couldn't copy the workspace id", description: workspaceId, tone: "danger" }),
    );
  };

  return (
    <header className="lc-topbar">
      <div className="lc-topbar-start">
        <IconButton
          icon={SidebarSimpleIcon}
          label="Layers panel"
          shortcut="Alt+["
          tooltipPlacement="bottom"
          isSelected={leftOpen}
          onSelectedChange={setLeftOpen}
        />
        <a className="lc-topbar-mark" href="/" title="All workspaces" aria-label="All workspaces" onClick={goToDashboard}>
          <LucidaMark />
        </a>
        <span className="lc-topbar-separator" aria-hidden="true">
          /
        </span>
        <WorkspaceName name={workspaceName} onRename={onRenameWorkspace} />
        <Menu
          label="Workspace"
          trigger={<IconButton icon={CaretDownIcon} label="Workspace menu" size="sm" tooltipPlacement="bottom" />}
        >
          <MenuItem icon={CopyIcon} onAction={copyWorkspaceId}>
            Copy workspace id
          </MenuItem>
          {onUseViewAsPreview && (
            <MenuItem icon={ImageSquareIcon} onAction={onUseViewAsPreview}>
              Use this view as the preview
            </MenuItem>
          )}
          <MenuItem icon={SquaresFourIcon} onAction={onBackToDashboard}>
            All workspaces
          </MenuItem>
        </Menu>
      </div>
      <div className="lc-topbar-end">
        {/* The palette's way in without a keyboard. */}
        <IconButton
          icon={MagnifyingGlassIcon}
          label="Search commands"
          shortcut="Mod+K"
          tooltipPlacement="bottom"
          onPress={() => showKeyboardHelp("commandPalette")}
        />
        {developer.enabled && (
          <div className="lc-topbar-group" role="group" aria-label="Developer tools">
            <IconButton
              icon={ChartLineIcon}
              label="Pipeline monitor"
              tooltipPlacement="bottom"
              isSelected={developer.monitor}
              onSelectedChange={developer.toggleMonitor}
            />
            <IconButton
              icon={GaugeIcon}
              label="Pipeline HUD"
              shortcut="H"
              tooltipPlacement="bottom"
              isSelected={developer.hud}
              onSelectedChange={developer.toggleHud}
            />
            <IconButton
              icon={WrenchIcon}
              label="Dev controls"
              tooltipPlacement="bottom"
              isSelected={developer.devControls}
              onSelectedChange={developer.toggleDevControls}
            />
          </div>
        )}
        <PresenceAvatars {...presence} />
        {share}
        <SettingsMenu />
        <ProfileMenu />
      </div>
    </header>
  );
}

/**
 * The workspace's name, edited in place by those who may rename it. Enter or
 * leaving the field saves; Escape restores the saved name.
 */
export function WorkspaceName({ name, onRename }: { name: string; onRename?: (name: string) => Promise<void> }) {
  // The draft follows a rename that lands from elsewhere, unless one is being typed.
  const [edit, setEdit] = useState({ source: name, value: name });
  const draft = edit.source === name ? edit.value : name;
  const inputRef = useRef<HTMLInputElement>(null);

  if (!onRename) {
    return (
      <span className="lc-workspace-name" title={name}>
        {name}
      </span>
    );
  }

  const reset = () => setEdit({ source: name, value: name });
  const commit = () => {
    const next = draft.trim();
    if (!next || next === name) {
      reset();
      return;
    }
    void onRename(next).catch(reset);
  };

  // React Aria's field rather than TextField: this one reads as the title it
  // edits, not as a boxed form field.
  return (
    <AriaTextField
      className="lc-workspace-name-field"
      aria-label="Workspace name"
      value={draft}
      onChange={(value) => setEdit({ source: name, value })}
      onBlur={commit}
      onKeyDown={(e) => {
        const input = inputRef.current;
        if (e.key === "Enter") input?.blur();
        if (e.key === "Escape") {
          reset();
          // Blur after the reset renders, so the commit it runs sees the
          // saved name and does nothing.
          setTimeout(() => input?.blur(), 0);
        }
      }}
    >
      <Input
        ref={inputRef}
        className="lc-workspace-name"
        data-editable=""
        title="Rename the workspace"
        spellCheck={false}
      />
    </AriaTextField>
  );
}
