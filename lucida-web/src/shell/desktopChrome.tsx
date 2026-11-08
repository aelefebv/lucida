import { CollectionSelector } from "../components/CollectionSelector.tsx";
import { ShareButton } from "../share/ShareButton.tsx";
import type { ChromeInputs, ChromeParts } from "./chrome.ts";
import { LeftPanel } from "./LeftPanel.tsx";
import { RightRail } from "./RightRail.tsx";
import { TopBar } from "./TopBar.tsx";

/**
 * The wider screens' chrome: the top bar, the layers panel on the left, the
 * rail on the right, and the navigator and dimension bar over the canvas. The
 * capture surface keeps only what sits over the canvas, which its bare stage
 * hides.
 */
export function desktopChrome(inputs: ChromeInputs, { captureSurface }: { captureSurface: boolean }): ChromeParts {
  const ui = !captureSurface;
  return {
    top: ui && (
      <TopBar
        workspaceId={inputs.workspaceId}
        workspaceName={inputs.workspaceName}
        onRenameWorkspace={inputs.onRenameWorkspace}
        onBackToDashboard={inputs.onBackToDashboard}
        onUseViewAsPreview={inputs.onUseViewAsPreview}
        presence={inputs.presence}
        share={<ShareButton {...inputs.share} />}
        developer={inputs.developer}
      />
    ),
    left: ui && <LeftPanel label="Layers">{inputs.layerPanel}</LeftPanel>,
    right: ui && <RightRail panels={inputs.railPanels} />,
    below: null,
    canvasBottomLeft: inputs.navigator && <CollectionSelector {...inputs.navigator} />,
    canvasBottomCenter: inputs.dimensionBar,
  };
}
