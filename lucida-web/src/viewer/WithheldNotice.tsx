/**
 * Says in a view what it leaves out, and why: a dataset another view holds
 * in another form, since a dataset's pools hold one cut or one volume at a
 * time for now; and, when the views share too little memory, the chunks of
 * its own that did not fit.
 */
import type { ViewPane, WithheldDataset } from "../sceneStore.ts";
import { coverageMessage, withheldMessage } from "./withheld.ts";
import "./WithheldNotice.css";

/** How much of what a view asks for fit in the memory the views share. */
export interface Coverage {
  wanted: number;
  short: number;
}

interface Props {
  withheld: readonly WithheldDataset[];
  views: readonly ViewPane[];
  /** A dataset's name, as the layer panel shows it. */
  nameOf(datasetId: string): string;
  /** With several views, how much of what the view asks for fit in the memory they share. */
  coverage?: Coverage;
}

export function WithheldNotice({ withheld, views, nameOf, coverage }: Props) {
  const short = coverage && coverage.short > 0 ? coverage : null;
  if (withheld.length === 0 && !short) return null;
  return (
    <div className="lc-withheld-notice" role="status">
      {withheld.map((entry) => (
        <p key={entry.dataset_id}>{withheldMessage(entry, views, nameOf(entry.dataset_id))}</p>
      ))}
      {short && <p>{coverageMessage(short.wanted, short.short)}</p>}
    </div>
  );
}
