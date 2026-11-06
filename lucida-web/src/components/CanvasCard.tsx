import { CaretDownIcon, CaretUpIcon, XIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { usePreference, type Preference } from "../theme/preferences.ts";
import { IconButton } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { PanelHeader } from "../ui/PanelHeader.tsx";
import { Switch } from "../ui/Switch.tsx";
import { toast } from "../ui/toastQueue.ts";
import { CANVAS_CARDS, type CanvasCardEntry, type CanvasCardState } from "./canvasCards.ts";
import "./CanvasCard.css";

export interface CanvasCardProps {
  title: string;
  /** A short status after the title. */
  meta?: ReactNode;
  /** The card's name for its buttons and assistive tech, as settings lists it. */
  label: string;
  preference: Preference<CanvasCardState>;
  /** Default `none`, for content that runs to the card's edges. */
  padding?: "none" | "sm";
  children: ReactNode;
}

/**
 * A card over the canvas with a header that folds it or hides it. The content
 * stays mounted while folded or hidden, so a card holding a canvas keeps its
 * context; a card that draws should read the preference and stop drawing.
 */
export function CanvasCard({ title, meta, label, preference, padding = "none", children }: CanvasCardProps) {
  const [state, setState] = usePreference(preference);
  const collapsed = state === "collapsed";
  const name = label.toLowerCase();

  const hide = () => {
    setState("hidden");
    toast({
      title: `${label} hidden`,
      description: "Show it again from Settings.",
      action: { label: "Show", onPress: () => setState("open") },
      timeout: 8000,
    });
  };

  return (
    <div className="lc-canvas-card" data-state={state} hidden={state === "hidden"}>
      <Card padding="none" aria-label={label} className="lc-canvas-card-surface">
        <PanelHeader
          title={title}
          meta={meta}
          className="lc-canvas-card-header"
          actions={
            <>
              <IconButton
                icon={collapsed ? CaretUpIcon : CaretDownIcon}
                label={collapsed ? `Expand ${name}` : `Collapse ${name}`}
                size="sm"
                onPress={() => setState(collapsed ? "open" : "collapsed")}
              />
              <IconButton icon={XIcon} label={`Hide ${name}`} size="sm" onPress={hide} />
            </>
          }
        />
        <div className="lc-canvas-card-body" data-padding={padding} hidden={collapsed}>
          {children}
        </div>
      </Card>
    </div>
  );
}

/** A switch per card, for the settings menu: off hides the card, on shows it whole. */
export function CanvasCardSwitches() {
  return CANVAS_CARDS.map((card) => <CanvasCardSwitch key={card.preference.key} {...card} />);
}

function CanvasCardSwitch({ preference, label }: CanvasCardEntry) {
  const [state, setState] = usePreference(preference);
  return (
    <Switch label={label} isSelected={state !== "hidden"} onChange={(on) => setState(on ? "open" : "hidden")} />
  );
}
