import { XIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { IconButton } from "../ui/Button.tsx";
import "./Banner.css";

export interface BannerProps {
  children: ReactNode;
  /** Default `neutral`. */
  tone?: "neutral" | "info" | "warning" | "danger";
  /** Lines under the message, e.g. what failed. Scrolls past a few lines. */
  details?: readonly ReactNode[];
  /** Shows a dismiss button. */
  onDismiss?: () => void;
  /** `alert` interrupts a screen reader; keep it for failures. Default `status`. */
  role?: "status" | "alert";
  "data-testid"?: string;
}

/** A short notice over the top of the canvas, in the top-center slot. */
export function Banner({ children, tone = "neutral", details, onDismiss, role = "status", ...rest }: BannerProps) {
  return (
    <div className="lc-banner" data-tone={tone} role={role} data-testid={rest["data-testid"]}>
      <div className="lc-banner-text">
        {children}
        {details && details.length > 0 && (
          <ul className="lc-banner-details">
            {details.map((detail, index) => (
              <li key={index}>{detail}</li>
            ))}
          </ul>
        )}
      </div>
      {onDismiss && <IconButton icon={XIcon} label="Dismiss" size="sm" tooltipPlacement="bottom" onPress={onDismiss} />}
    </div>
  );
}
