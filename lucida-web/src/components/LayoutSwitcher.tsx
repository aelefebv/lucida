export interface LayoutSwitcherOption {
  id: string;
  name: string;
}

interface Props {
  layouts: readonly LayoutSwitcherOption[];
  activeLayoutId: string | null;
  onSelect: (layoutId: string) => void;
}

/**
 * Small dropdown that lets the user switch between available layouts for a
 * dataset. Renders nothing when there are <= 1 layouts to choose from
 * (single-image datasets) or when the registry isn't available yet.
 */
export function LayoutSwitcher({ layouts, activeLayoutId, onSelect }: Props) {
  if (layouts.length <= 1) return null;
  const activeId = activeLayoutId ?? layouts[0]?.id ?? "";

  return (
    <div className="layer-detail-row">
      <span className="layer-detail-label">Layout</span>
      <select
        aria-label="Layout"
        value={activeId}
        onChange={(event) => onSelect(event.target.value)}
      >
        {layouts.map((l) => (
          <option key={l.id} value={l.id}>{l.name}</option>
        ))}
      </select>
    </div>
  );
}
