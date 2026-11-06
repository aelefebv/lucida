import { XIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { IconButton } from "../ui/Button.tsx";
import "./Banner.css";

export interface BannerProps {
  children: ReactNode;
  /** Default `neutral`. */
  tone?: "neutral" | "info" | "danger";
  /** Shows a dismiss button. */
  onDismiss?: () => void;
  /** `alert` interrupts a screen reader; keep it for failures. Default `status`. */
  role?: "status" | "alert";
  "data-testid"?: string;
}

/** A short notice over the top of the canvas, in the top-center slot. */
export function Banner({ children, tone = "neutral", onDismiss, role = "status", ...rest }: BannerProps) {
  return (
    <div className="lc-banner" data-tone={tone} role={role} data-testid={rest["data-testid"]}>
      <div className="lc-banner-text">{children}</div>
      {onDismiss && <IconButton icon={XIcon} label="Dismiss" size="sm" tooltipPlacement="bottom" onPress={onDismiss} />}
    </div>
  );
}
