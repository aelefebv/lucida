/**
 * Says in a view, when the views share too little memory, that it shows less
 * detail than it asks for, and how much of it did not fit.
 */
import { coverageMessage } from "./coverage.ts";

/** How much of what a view asks for fit in the memory the views share. */
export interface Coverage {
  wanted: number;
  short: number;
}

interface Props {
  /** With several views, how much of what the view asks for fit in the memory they share. */
  coverage?: Coverage;
}

export function CoverageNotice({ coverage }: Props) {
  if (!coverage || coverage.short <= 0) return null;
  return (
    <div className="lc-view-notice" role="status">
      <p>{coverageMessage(coverage.wanted, coverage.short)}</p>
    </div>
  );
}
