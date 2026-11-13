import { ToggleButton, ToggleButtonGroup } from "react-aria-components";
import type { ListingKind } from "./listingsApi.ts";

/** How far back a date chip reaches, in days. */
const DATE_PRESETS = [7, 30, 90] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

const KINDS: readonly { value: ListingKind; label: string }[] = [
  { value: "image", label: "Images" },
  { value: "collection", label: "Collections" },
];

export interface FilterChipsProps {
  kind: ListingKind | null;
  onKindChange: (kind: ListingKind | null) => void;
  within: DatePreset | null;
  onWithinChange: (within: DatePreset | null) => void;
}

/**
 * One chip set per filter: at most one chip on in each, and pressing it again
 * turns it off. A press leaves focus in the search field, which drives the
 * list; Tab still reaches every chip.
 */
export function FilterChips({ kind, onKindChange, within, onWithinChange }: FilterChipsProps) {
  return (
    <div className="lc-open-chips">
      <ToggleButtonGroup
        className="lc-open-chip-set"
        aria-label="Kind"
        selectionMode="single"
        selectedKeys={kind ? [kind] : []}
        onSelectionChange={(keys) => {
          const [next] = keys;
          onKindChange(next === undefined ? null : (next as ListingKind));
        }}
      >
        {KINDS.map(({ value, label }) => (
          <ToggleButton key={value} id={value} className="lc-open-chip" preventFocusOnPress>
            {label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <ToggleButtonGroup
        className="lc-open-chip-set"
        aria-label="Date"
        selectionMode="single"
        selectedKeys={within ? [String(within)] : []}
        onSelectionChange={(keys) => {
          const [next] = keys;
          onWithinChange(next === undefined ? null : (Number(next) as DatePreset));
        }}
      >
        {DATE_PRESETS.map((days) => (
          <ToggleButton key={days} id={String(days)} className="lc-open-chip" preventFocusOnPress>
            Last {days} days
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </div>
  );
}
