/**
 * A chrome is what the viewer puts around its canvas: the desktop's top bar
 * and side panels, or the phone's top bar and bottom sheet. Both take the same
 * inputs and return their parts for the shell to place, so the canvas stage
 * keeps its place in the tree whichever chrome is around it and a phone
 * turned sideways never remounts the canvas the render worker draws into.
 */
import type { ComponentProps, ReactNode } from "react";
import type { CollectionSelector } from "../components/CollectionSelector.tsx";
import type { ShareButtonProps } from "../share/ShareButton.tsx";
import type { ChannelChipsProps } from "./phone/ChannelChips.tsx";
import type { PresenceAvatarsProps } from "./PresenceAvatars.tsx";
import type { RailPanel } from "./RightRail.tsx";
import type { DeveloperSurfaces } from "./useDeveloperSurfaces.ts";

export interface ChromeInputs {
  workspaceId: string;
  workspaceName: string;
  /** Renames the workspace; omit when the user may not. */
  onRenameWorkspace?: (name: string) => Promise<void>;
  onBackToDashboard: () => void;
  /** Makes the current view the workspace's preview; omit when the user may not. */
  onUseViewAsPreview?: () => void;
  presence: PresenceAvatarsProps;
  share: Omit<ShareButtonProps, "dialog">;
  developer: DeveloperSurfaces;
  layerPanel: ReactNode;
  dimensionBar: ReactNode;
  channelChips: ChannelChipsProps;
  /** The collection navigator, when the selected dataset is a collection in 2D. */
  navigator: ComponentProps<typeof CollectionSelector> | null;
  railPanels: RailPanel[];
}

export interface ChromeParts {
  top: ReactNode;
  left: ReactNode;
  right: ReactNode;
  /** In the canvas column, after the dock. */
  below: ReactNode;
  canvasBottomLeft: ReactNode;
  canvasBottomCenter: ReactNode;
}
