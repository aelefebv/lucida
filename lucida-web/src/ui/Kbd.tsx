import { formatKeyCombo, type KeyCombo } from "./shortcuts.ts";
import "./Kbd.css";

export interface KbdProps {
  keys: KeyCombo;
  className?: string;
}

/** A key combo drawn as keycaps, in the platform's words (⌘ K or Ctrl K). */
export function Kbd({ keys, className }: KbdProps) {
  return (
    <kbd className={className ? `lc-kbd ${className}` : "lc-kbd"}>
      {formatKeyCombo(keys).map((cap, i) => (
        <kbd key={i} className="lc-kbd-cap">
          {cap}
        </kbd>
      ))}
    </kbd>
  );
}
