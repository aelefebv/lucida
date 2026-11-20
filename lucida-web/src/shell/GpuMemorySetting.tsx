import { useSyncExternalStore } from "react";
import { gpuBudgetPreference, pageDefaultBudgets, subscribePageBudgets } from "../pageBudgets.ts";
import { resetPreference, usePreference } from "../theme/preferences.ts";
import { Select, type SelectOption } from "../ui/Select.tsx";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** The totals offered, from a laptop's GPU to a workstation's. */
const CHOICES_GIB = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];

const AUTOMATIC = "auto";

/** Bytes as a person reads a memory size: whole MB below 1 GB, GB to a tenth above. */
function formatMemory(bytes: number): string {
  if (bytes < GIB) return `${Math.round(bytes / MIB)} MB`;
  return `${Math.round((bytes / GIB) * 10) / 10} GB`;
}

/**
 * The GPU memory the viewer may hold, as Settings sets it: automatic, which
 * fits it to the device, or a size the person knows their GPU holds. The CPU
 * detail store follows it.
 */
export function GpuMemorySetting({ className }: { className?: string }) {
  const [set, setSet] = usePreference(gpuBudgetPreference);
  const automatic = useSyncExternalStore(subscribePageBudgets, () => pageDefaultBudgets().gpuTotalBytes);
  const choices = CHOICES_GIB.map((gib) => gib * GIB);
  // A size set some other way, such as by the trace driver, still shows.
  if (set !== null && !choices.includes(set)) choices.push(set);
  choices.sort((a, b) => a - b);
  const options: SelectOption<string>[] = [
    { value: AUTOMATIC, label: `Automatic (${formatMemory(automatic)})` },
    ...choices.map((bytes) => ({ value: String(bytes), label: formatMemory(bytes) })),
  ];
  return (
    <Select
      label="GPU memory"
      labelPosition="side"
      description="System memory use follows it"
      options={options}
      value={set === null ? AUTOMATIC : String(set)}
      onChange={(value) => {
        if (value === AUTOMATIC) resetPreference(gpuBudgetPreference);
        else setSet(Number(value));
      }}
      className={className}
    />
  );
}
