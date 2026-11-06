import type { ReactNode } from "react";
import { Separator, Toolbar as AriaToolbar } from "react-aria-components";
import "./Toolbar.css";

export interface ToolbarProps {
  /** Names the group of controls. */
  label: string;
  /** Default `horizontal`. The arrow keys follow it. */
  orientation?: "horizontal" | "vertical";
  /** IconButtons and ToolbarSeparators. */
  children: ReactNode;
  /** For layout only. */
  className?: string;
}

/** A row or column of controls, one tab stop, with arrow keys between them. */
export function Toolbar({ label, orientation = "horizontal", children, className }: ToolbarProps) {
  return (
    <AriaToolbar
      aria-label={label}
      orientation={orientation}
      className={className ? `lc-toolbar ${className}` : "lc-toolbar"}
    >
      {children}
    </AriaToolbar>
  );
}

/** A rule between groups of controls, across the toolbar's direction. */
export function ToolbarSeparator() {
  return <Separator className="lc-toolbar-separator" />;
}
