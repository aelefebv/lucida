/**
 * Says in a view which datasets it shows but leaves out, and why: another
 * view holds each one's GPU pools in another form, and a dataset's pools hold
 * one cut or one volume at a time for now.
 */
import type { ViewPane, WithheldDataset } from "../sceneStore.ts";
import { withheldMessage } from "./withheld.ts";
import "./WithheldNotice.css";

interface Props {
  withheld: readonly WithheldDataset[];
  views: readonly ViewPane[];
  /** A dataset's name, as the layer panel shows it. */
  nameOf(datasetId: string): string;
}

export function WithheldNotice({ withheld, views, nameOf }: Props) {
  if (withheld.length === 0) return null;
  return (
    <div className="lc-withheld-notice" role="status">
      {withheld.map((entry) => (
        <p key={entry.dataset_id}>{withheldMessage(entry, views, nameOf(entry.dataset_id))}</p>
      ))}
    </div>
  );
}
