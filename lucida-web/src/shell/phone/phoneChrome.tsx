import { SquaresFourIcon, StackIcon } from "@phosphor-icons/react";
import { CollectionSelector } from "../../components/CollectionSelector.tsx";
import type { ChromeInputs, ChromeParts } from "../chrome.ts";
import { ChannelChips } from "./ChannelChips.tsx";
import { PhoneSheet } from "./PhoneSheet.tsx";
import { PhoneTopBar } from "./PhoneTopBar.tsx";

/**
 * A phone's chrome: a compact top bar, and a bottom sheet that holds the
 * channel chips and dimension bar in its peek, and the layers, the navigator,
 * and the rail's panels in its tabs.
 */
export function phoneChrome(inputs: ChromeInputs): ChromeParts {
  const navigator = inputs.navigator;
  return {
    top: (
      <PhoneTopBar
        workspaceName={inputs.workspaceName}
        onRenameWorkspace={inputs.onRenameWorkspace}
        onBackToDashboard={inputs.onBackToDashboard}
        onUseViewAsPreview={inputs.onUseViewAsPreview}
        share={inputs.share}
        presence={inputs.presence}
      />
    ),
    left: null,
    right: null,
    below: (
      <PhoneSheet
        peek={
          <>
            <ChannelChips {...inputs.channelChips} />
            {inputs.dimensionBar}
          </>
        }
        layerTabs={[
          { id: "layers", label: "Layers", icon: StackIcon, render: () => inputs.layerPanel },
          ...(navigator
            ? [
                {
                  id: "groups",
                  label: "Groups",
                  icon: SquaresFourIcon,
                  render: (active: boolean) => (
                    <CollectionSelector {...navigator} variant="panel" visible={active} />
                  ),
                },
              ]
            : []),
        ]}
        railTabs={inputs.railPanels}
      />
    ),
    canvasBottomLeft: null,
    canvasBottomCenter: null,
  };
}
