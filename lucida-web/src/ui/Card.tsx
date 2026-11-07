import type { ReactNode } from "react";
import "./Card.css";

export interface CardProps {
  children: ReactNode;
  /** Inner padding. Default `md` (12px); `none` for edge-to-edge content. */
  padding?: "none" | "sm" | "md";
  /** Names the card for assistive tech when it holds a control group. */
  "aria-label"?: string;
  /** For layout and placement only. */
  className?: string;
}

/**
 * A floating surface over the canvas: translucent, blurred, bordered, and
 * lifted by a soft shadow.
 */
export function Card({ children, padding = "md", className, ...aria }: CardProps) {
  return (
    <div
      className={className ? `lc-card ${className}` : "lc-card"}
      data-padding={padding}
      role={aria["aria-label"] ? "group" : undefined}
      {...aria}
    >
      {children}
    </div>
  );
}
