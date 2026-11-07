import type { Icon } from "@phosphor-icons/react";
import { Fragment, useCallback, type ReactNode } from "react";
import { usePreference } from "../theme/preferences.ts";
import { IconButton } from "../ui/Button.tsx";
import { useShortcut } from "../ui/shortcuts.ts";
import { rightPanelPreference } from "./layoutPreferences.ts";
import { PanelScrim } from "./PanelScrim.tsx";
import { useEscapeCloses, usePanelMode, usePanelOpen } from "./sidePanels.ts";
import "./RightRail.css";

export interface RailPanel {
  /** Stable; the rail remembers the last one opened by it. */
  id: string;
  /** The rail button's name and tooltip. */
  label: string;
  /** A shorter name where it is written out in a tight row, as on a phone. */
  shortLabel?: string;
  icon: Icon;
  /**
   * A count drawn on the icon, e.g. unread items; zero draws none. `label`
   * says what it counts and joins the button's name and tooltip.
   */
  badge?: { count: number; label: string };
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
 * default; which panel was last open persists per browser, and on desktop
 * whether one is open does too. As an overlay the panel slides over the
 * canvas beside the rail and closes on a tap outside or Escape.
 * `Alt ]` opens or closes the last panel.
 */
export function RightRail({ panels }: RightRailProps) {
  const overlay = usePanelMode() === "overlay";
  const [open, setOpen] = usePanelOpen("right");
  const close = useCallback(() => setOpen(false), [setOpen]);
  useEscapeCloses(overlay && open, close);
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
    <>
      {overlay && open && <PanelScrim onDismiss={close} />}
      <div className="lc-right-rail-region" data-mode={overlay ? "overlay" : "docked"}>
        <nav className="lc-right-rail" aria-label="Panels">
          {panels.map((panel) => {
            const count = panel.badge?.count ?? 0;
            return (
              <span key={panel.id} className="lc-right-rail-item">
                <IconButton
                  icon={panel.icon}
                  label={count > 0 ? `${panel.label} (${panel.badge?.label})` : panel.label}
                  size="lg"
                  tooltipPlacement="left"
                  isSelected={open && panel.id === activeId}
                  onSelectedChange={() => choose(panel.id)}
                  data-testid={`rail-${panel.id}`}
                />
                {count > 0 && (
                  <span className="lc-right-rail-badge" aria-hidden="true">
                    {count > 99 ? "99+" : count}
                  </span>
                )}
              </span>
            );
          })}
        </nav>
        <div className="lc-right-panel" hidden={!open}>
          {panels.map((panel) => (
            <Fragment key={panel.id}>{panel.render(open && panel.id === activeId)}</Fragment>
          ))}
        </div>
      </div>
    </>
  );
}
