import type { ReactNode } from "react";
import "./Badge.css";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

export interface BadgeProps {
  children: ReactNode;
  /** Default `neutral`. */
  tone?: BadgeTone;
  className?: string;
}

/** A short status or count. Not interactive. */
export function Badge({ children, tone = "neutral", className }: BadgeProps) {
  return (
    <span className={className ? `lc-badge ${className}` : "lc-badge"} data-tone={tone}>
      {children}
    </span>
  );
}
