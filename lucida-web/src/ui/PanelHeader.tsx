import type { ReactNode } from "react";
import "./PanelHeader.css";

export interface PanelHeaderProps {
  title: string;
  /** A count or short status after the title, e.g. "3". */
  meta?: ReactNode;
  /** Small IconButtons (size `sm`) at the right. */
  actions?: ReactNode;
  /** Heading level for the document outline. Default 2. */
  level?: 2 | 3 | 4;
  className?: string;
}

/** The title row of a panel or card. */
export function PanelHeader({ title, meta, actions, level = 2, className }: PanelHeaderProps) {
  const Heading = `h${level}` as const;
  return (
    <div className={className ? `lc-panel-header ${className}` : "lc-panel-header"}>
      <Heading className="lc-panel-header-title">{title}</Heading>
      {meta !== undefined && <span className="lc-panel-header-meta">{meta}</span>}
      {actions && <div className="lc-panel-header-actions">{actions}</div>}
    </div>
  );
}
