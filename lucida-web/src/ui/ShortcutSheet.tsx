import { Dialog } from "./Dialog.tsx";
import { Kbd } from "./Kbd.tsx";
import { SHORTCUT_GROUPS, useShortcutList } from "./shortcuts.ts";
import "./ShortcutSheet.css";

export interface ShortcutSheetProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}

/**
 * Every shortcut bound right now, grouped. Read from the registry, so it
 * lists exactly the keys that work and can never go stale.
 */
export function ShortcutSheet({ isOpen, onOpenChange }: ShortcutSheetProps) {
  const shortcuts = useShortcutList();
  const groups = SHORTCUT_GROUPS.map((group) => ({
    group,
    shortcuts: shortcuts.filter((s) => s.group === group),
  })).filter((g) => g.shortcuts.length > 0);

  return (
    <Dialog title="Keyboard shortcuts" size="lg" isOpen={isOpen} onOpenChange={onOpenChange}>
      <div className="lc-shortcut-sheet">
        {groups.map(({ group, shortcuts: rows }) => {
          const scopes = [...new Set(rows.map((s) => s.scope).filter((s) => s !== "global"))];
          return (
            <section key={group} className="lc-shortcut-group" aria-label={group}>
              <h3 className="lc-shortcut-group-title">
                {group}
                {scopes.length > 0 && <span className="lc-shortcut-scope">in {scopes.join(", ")} mode</span>}
              </h3>
              <dl className="lc-shortcut-list">
                {rows.map((s) => (
                  <div key={s.id} className="lc-shortcut-row">
                    <dt>{s.label}</dt>
                    <dd>
                      {s.keys.map((k) => (
                        <Kbd key={k} keys={k} />
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
      <p className="lc-shortcut-note">Shortcuts stay quiet while you type in a field.</p>
    </Dialog>
  );
}
