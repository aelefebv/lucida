import type { Icon } from "@phosphor-icons/react";
import { Fragment, type ReactNode } from "react";
import { usePreference } from "../theme/preferences.ts";
import { IconButton } from "../ui/Button.tsx";
import { useShortcut } from "../ui/shortcuts.ts";
import { rightPanelOpenPreference, rightPanelPreference } from "./layoutPreferences.ts";
import "./RightRail.css";

export interface RailPanel {
  /** Stable; the rail remembers the last one opened by it. */
  id: string;
  /** The rail button's name and tooltip. */
  label: string;
  icon: Icon;
  /**
   * Renders the panel. Called for every panel on every render, open or not,
   * so a panel keeps its state while another is showing; `active` says
   * whether this one is.
   */
  render: (active: boolean) => ReactNode;
}

export interface RightRailProps {
  panels: readonly RailPanel[];
}

/**
 * An icon rail at the right whose panels open one at a time. Closed by
 * default; which panel was last open and whether one is persist per browser.
 * `Alt ]` opens or closes the last panel.
 */
export function RightRail({ panels }: RightRailProps) {
  const [open, setOpen] = usePreference(rightPanelOpenPreference);
  const [storedId, setStoredId] = usePreference(rightPanelPreference);
  const activeId = panels.some((p) => p.id === storedId) ? storedId : (panels[0]?.id ?? null);

  useShortcut({
    id: "panels.toggleRight",
    keys: "Alt+]",
    label: "Show or hide the right panel",
    group: "Panels",
    onTrigger: () => setOpen(!open),
    enabled: panels.length > 0,
  });

  const choose = (id: string) => {
    if (open && id === activeId) {
      setOpen(false);
      return;
    }
    setStoredId(id);
    setOpen(true);
  };

  return (
    <div className="lc-right-rail-region">
      <nav className="lc-right-rail" aria-label="Panels">
        {panels.map((panel) => (
          <IconButton
            key={panel.id}
            icon={panel.icon}
            label={panel.label}
            size="lg"
            tooltipPlacement="left"
            isSelected={open && panel.id === activeId}
            onSelectedChange={() => choose(panel.id)}
          />
        ))}
      </nav>
      <div className="lc-right-panel" hidden={!open}>
        {panels.map((panel) => (
          <Fragment key={panel.id}>{panel.render(open && panel.id === activeId)}</Fragment>
        ))}
      </div>
    </div>
  );
}
