/**
 * PROTOTYPE — throwaway. Issue #892, under map #885.
 *
 * "Three variants of the pipeline monitor's top-level view, switchable via
 *  ?variant=, on a throwaway page at /monitor-prototype.html."
 *
 * Sub-shape B (a new page) is deliberate and is itself part of the answer to
 * the ticket's "where does it live" question: the monitor must not perturb
 * what it measures, and the cheapest way not to perturb the viewer's tab is
 * not to be in it. The page is dev-only and is never part of a production
 * build's routes.
 */

import { useEffect, useMemo, useState } from "react";
import { buildTrace, type RunKey } from "./syntheticTrace.ts";
import { tableBytes } from "./traceModel.ts";
import { toChromeTraceFile } from "./chromeExport.ts";
import { useReplay } from "./useReplay.ts";
import { PrototypeSwitcher } from "./PrototypeSwitcher.tsx";
import { VariantA, NAME as NAME_A } from "./VariantA.tsx";
import { VariantB, NAME as NAME_B } from "./VariantB.tsx";
import { VariantC, NAME as NAME_C } from "./VariantC.tsx";
import "./monitorPrototype.css";

const VARIANTS = [
  { key: "A", name: NAME_A },
  { key: "B", name: NAME_B },
  { key: "C", name: NAME_C },
];

function readParam(name: string, fallback: string): string {
  return new URLSearchParams(window.location.search).get(name) ?? fallback;
}

function writeParam(name: string, value: string) {
  const url = new URL(window.location.href);
  url.searchParams.set(name, value);
  window.history.replaceState(null, "", url);
}

export function MonitorPrototype() {
  const [variant, setVariant] = useState(() => readParam("variant", "A"));
  const [run, setRun] = useState<RunKey>(() => readParam("run", "warm") as RunKey);

  useEffect(() => writeParam("variant", variant), [variant]);
  useEffect(() => writeParam("run", run), [run]);

  return (
    <div className="proto-root">
      <div className="proto-banner">
        PROTOTYPE — issue #892. Synthetic trace, calibrated to #888 / #899.
        Nothing here is instrumentation.
      </div>
      <Run
        key={run}
        run={run}
        variant={variant}
        onVariant={setVariant}
        onRun={setRun}
      />
    </div>
  );
}

/** Keyed on the run: a new run is a remount, not a pile of reset effects. */
function Run({
  run,
  variant,
  onVariant,
  onRun,
}: {
  run: RunKey;
  variant: string;
  onVariant: (v: string) => void;
  onRun: (r: RunKey) => void;
}) {
  const [chromeBytes, setChromeBytes] = useState<number | null>(null);
  const trace = useMemo(() => buildTrace(run), [run]);
  const replay = useReplay(trace.header.durationUs);

  const onExport = () => {
    const json = toChromeTraceFile(trace);
    setChromeBytes(new Blob([json]).size);
    const url = URL.createObjectURL(
      new Blob([json], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `lucida-trace-${run}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="proto-stage">
        {variant === "A" && <VariantA trace={trace} replay={replay} />}
        {variant === "B" && <VariantB trace={trace} replay={replay} />}
        {variant === "C" && <VariantC trace={trace} replay={replay} />}
      </div>
      <PrototypeSwitcher
        variants={VARIANTS}
        current={variant}
        onVariant={onVariant}
        run={run}
        onRun={onRun}
        replay={replay}
        onExport={onExport}
        cost={{ tableBytes: tableBytes(trace), chromeBytes }}
      />
    </>
  );
}
