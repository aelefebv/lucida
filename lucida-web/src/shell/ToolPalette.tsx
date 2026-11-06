import {
  BoundingBoxIcon,
  EyeIcon,
  EyeSlashIcon,
  HandIcon,
  KeyboardIcon,
  LineSegmentIcon,
  MapPinIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { Tool } from "../components/annotationTool.ts";
import { IconButton } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { useCommand } from "../ui/commands.ts";
import { escapeTopLayer, hasEscapeLayer } from "../ui/escape.ts";
import { showKeyboardHelp } from "../ui/keyboardHelpState.ts";
import { useShortcut, type KeyCombo } from "../ui/shortcuts.ts";
import { Toolbar, ToolbarSeparator } from "../ui/Toolbar.tsx";

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
}

/**
 * The canvas tools, in the stage's top-left slot. Pan navigates; point, line,
 * and box draw an annotation with a plain press. Shift-click from the pan
 * tool still drops a point.
 */
export function ToolPalette({ tool, onToolChange, annotationsVisible, onAnnotationsVisibleChange }: ToolPaletteProps) {
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

  return (
    <Card padding="sm">
      <Toolbar label="Tools" orientation="vertical">
        {TOOL_BUTTONS.map((button) => (
          <IconButton
            key={button.tool}
            icon={button.icon}
            label={button.label}
            shortcut={button.combo}
            tooltipPlacement="right"
            isSelected={tool === button.tool}
            onSelectedChange={() => onToolChange(button.tool)}
          />
        ))}
        <ToolbarSeparator />
        <IconButton
          icon={annotationsVisible ? EyeIcon : EyeSlashIcon}
          label="Hide annotations"
          shortcut="Shift+A"
          tooltipPlacement="right"
          isSelected={!annotationsVisible}
          onSelectedChange={(hidden) => onAnnotationsVisibleChange(!hidden)}
          data-testid="annot-visibility-toggle"
        />
        <ToolbarSeparator />
        <IconButton
          icon={KeyboardIcon}
          label="Keyboard shortcuts"
          shortcut="?"
          tooltipPlacement="right"
          onPress={() => showKeyboardHelp("shortcutSheet")}
        />
      </Toolbar>
    </Card>
  );
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
