import { useState, type CSSProperties } from "react";
import "./Avatar.css";

export interface AvatarProps {
  /** The person's name: the accessible name, and the initials fallback. */
  name: string;
  /** Picture URL. Falls back to initials when missing or broken. */
  src?: string;
  /**
   * Fill behind the initials, e.g. a collaborator's presence color. The text
   * color follows it for contrast. Default the accent.
   */
  color?: string;
  /** 20, 24, or 32px. Default `md`. */
  size?: "sm" | "md" | "lg";
  className?: string;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]][0] ?? "";
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + last).toUpperCase();
}

export function Avatar({ name, src, color, size = "md", className }: AvatarProps) {
  const [broken, setBroken] = useState<string | null>(null);
  const showImage = src !== undefined && broken !== src;
  return (
    <span
      className={className ? `lc-avatar ${className}` : "lc-avatar"}
      data-size={size}
      role="img"
      aria-label={name}
      title={name}
      style={color ? ({ "--avatar-color": color } as CSSProperties) : undefined}
    >
      {showImage ? (
        <img className="lc-avatar-image" src={src} alt="" onError={() => setBroken(src)} />
      ) : (
        <span aria-hidden>{initials(name)}</span>
      )}
    </span>
  );
}
