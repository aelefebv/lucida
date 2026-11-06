import {
  BoundingBoxIcon,
  EyeIcon,
  EyeSlashIcon,
  HandIcon,
  KeyboardIcon,
  LineSegmentIcon,
  MapPinIcon,
  PencilSimpleIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useLayoutEffect, useRef, useState } from "react";
import type { Tool } from "../components/annotationTool.ts";
import { IconButton } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { useCommand } from "../ui/commands.ts";
import { escapeTopLayer, hasEscapeLayer } from "../ui/escape.ts";
import { showKeyboardHelp } from "../ui/keyboardHelpState.ts";
import { Popover } from "../ui/Popover.tsx";
import { useShortcut, type KeyCombo } from "../ui/shortcuts.ts";
import { Toolbar, ToolbarSeparator } from "../ui/Toolbar.tsx";
import "./ToolPalette.css";

const TOOL_BUTTONS: readonly { tool: Tool; label: string; icon: Icon; combo: KeyCombo }[] = [
  { tool: "pan", label: "Pan tool", icon: HandIcon, combo: "V" },
  { tool: "point", label: "Point tool", icon: MapPinIcon, combo: "P" },
  { tool: "line", label: "Line tool", icon: LineSegmentIcon, combo: "L" },
  { tool: "box", label: "Box tool", icon: BoundingBoxIcon, combo: "B" },
];

export interface ToolPaletteProps {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  annotationsVisible: boolean;
  onAnnotationsVisibleChange: (visible: boolean) => void;
  /**
   * One Annotate button that opens the tools, for a phone, where a column of
   * them would cover the canvas. It shows the active tool.
   */
  compact?: boolean;
}

/**
 * The canvas tools, in the stage's top-left slot. Pan navigates; point, line,
 * and box draw an annotation with a plain press. Shift-click from the pan
 * tool still drops a point. A column, or a row where the stage is too short
 * for one, as on a phone held sideways.
 */
export function ToolPalette({
  tool,
  onToolChange,
  annotationsVisible,
  onAnnotationsVisibleChange,
  compact,
}: ToolPaletteProps) {
  useToolCommand("pan", tool, onToolChange);
  useToolCommand("point", tool, onToolChange);
  useToolCommand("line", tool, onToolChange);
  useToolCommand("box", tool, onToolChange);
  useCommand({
    id: "annotations.toggleVisible",
    keys: ["Shift+A"],
    label: annotationsVisible ? "Hide annotations" : "Show annotations",
    group: "Annotations",
    run: () => onAnnotationsVisibleChange(!annotationsVisible),
  });
  useShortcut({
    id: "general.escape",
    keys: ["Escape"],
    label: "Close, cancel the drawing, or go back to the pan tool",
    group: "General",
    when: () => hasEscapeLayer() || tool !== "pan",
    onTrigger: () => {
      if (!escapeTopLayer()) onToolChange("pan");
    },
  });

  const { roomRef, orientation } = useFittedOrientation(!compact);
  const tooltipPlacement = orientation === "vertical" ? "right" : "bottom";

  const tools = (placement: "right" | "bottom", onPicked?: () => void) => (
    <>
      {TOOL_BUTTONS.map((button) => (
        <IconButton
          key={button.tool}
          icon={button.icon}
          label={button.label}
          shortcut={button.combo}
          tooltipPlacement={placement}
          isSelected={tool === button.tool}
          onSelectedChange={() => {
            onToolChange(button.tool);
            onPicked?.();
          }}
        />
      ))}
      <ToolbarSeparator />
      <IconButton
        icon={annotationsVisible ? EyeIcon : EyeSlashIcon}
        label="Hide annotations"
        shortcut="Shift+A"
        tooltipPlacement={placement}
        isSelected={!annotationsVisible}
        onSelectedChange={(hidden) => onAnnotationsVisibleChange(!hidden)}
        data-testid="annot-visibility-toggle"
      />
    </>
  );

  if (compact) {
    const active = TOOL_BUTTONS.find((button) => button.tool === tool);
    const drawing = active && active.tool !== "pan" ? active : null;
    return (
      <div className="lc-tool-palette">
        <Card padding="sm">
          <Popover
            label="Annotate"
            placement="bottom start"
            trigger={
              <IconButton
                icon={drawing?.icon ?? PencilSimpleIcon}
                label={drawing ? `Annotate: ${drawing.label}` : "Annotate"}
                tooltipPlacement="bottom"
                variant={drawing ? "secondary" : "ghost"}
                data-testid="annotate-button"
              />
            }
          >
            {(close) => (
              <Toolbar label="Tools" orientation="horizontal">
                {tools("bottom", close)}
              </Toolbar>
            )}
          </Popover>
        </Card>
      </div>
    );
  }

  return (
    <div ref={roomRef} className="lc-tool-palette">
      <Card padding="sm">
        <Toolbar label="Tools" orientation={orientation}>
          {tools(tooltipPlacement)}
          <ToolbarSeparator />
          <IconButton
            icon={KeyboardIcon}
            label="Keyboard shortcuts"
            shortcut="?"
            tooltipPlacement={tooltipPlacement}
            onPress={() => showKeyboardHelp("shortcutSheet")}
          />
        </Toolbar>
      </Card>
    </div>
  );
}

/**
 * A column while the slot is tall enough for one, else a row. The buttons are
 * square and the padding even, so the row is exactly as long as the column
 * is tall, and the palette's longer side is what a column needs either way.
 */
function useFittedOrientation(enabled: boolean) {
  const roomRef = useRef<HTMLDivElement>(null);
  const [orientation, setOrientation] = useState<"vertical" | "horizontal">("vertical");
  useLayoutEffect(() => {
    const room = roomRef.current;
    const card = room?.firstElementChild;
    if (!enabled || !room || !(card instanceof HTMLElement) || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const column = Math.max(card.offsetWidth, card.offsetHeight);
      setOrientation(column <= room.clientHeight ? "vertical" : "horizontal");
    };
    const observer = new ResizeObserver(fit);
    observer.observe(room);
    observer.observe(card);
    fit();
    return () => observer.disconnect();
  }, [enabled]);
  return { roomRef, orientation };
}

function useToolCommand(id: Tool, current: Tool, onToolChange: (tool: Tool) => void): void {
  const button = TOOL_BUTTONS.find((b) => b.tool === id)!;
  useCommand({
    id: `tools.${id}`,
    keys: [button.combo],
    label: button.label,
    group: "Tools",
    keywords: id === "pan" ? ["navigate", "move"] : ["annotate", "draw"],
    run: () => {
      if (current !== id) onToolChange(id);
    },
  });
}
