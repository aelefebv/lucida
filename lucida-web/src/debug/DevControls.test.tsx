// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DevControls, type LiveCacheKnobs } from "./DevControls.tsx";
import { configStore, PLANNING_KNOB_PREFERENCES } from "../pipeline/planning/configStore.ts";
import { DEFAULT_PLANNING_CONFIG } from "../pipeline/planning/config.ts";
import { CACHE_KNOB_PREFERENCES, readCacheKnobs } from "../pipeline/fetch/cacheKnobs.ts";
import {
  PREFERENCES_STORAGE_KEY,
  __resetPreferencesForTesting,
  developerToolsPreference,
  getPreference,
  setPreference,
} from "../theme/preferences.ts";
import {
  DEBUG_OVERLAYS,
  getRenderRadiusPreviewTier,
  setRenderRadiusPreviewTier,
  setOverlayEnabled,
} from "./logging.ts";

// The panel shows only while developer tools are on, and its knobs apply only then.
beforeEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
  setPreference(developerToolsPreference, true);
  setRenderRadiusPreviewTier(null);
});

afterEach(() => {
  cleanup();
  setRenderRadiusPreviewTier(null);
  localStorage.clear();
  __resetPreferencesForTesting();
});

/**
 * Stand-in for the live `CpuCache`, which Dev controls only reads config
 * from. It runs under the knobs as the session's cache does.
 */
function fakeCache(overrides: Partial<ReturnType<LiveCacheKnobs["getConfig"]>> = {}): LiveCacheKnobs {
  const own = {
    mainBudgetBytes: 512 * 1024 * 1024,
    overviewBudgetBytes: 128 * 1024 * 1024,
    maxConcurrentFetches: 12,
    maxBytesInFlight: 64 * 1024 * 1024,
    ...overrides,
  };
  return { getConfig: () => ({ ...own, ...readCacheKnobs() }) };
}

/** A tunable's slider: the range input React Aria keeps under the thumb. */
const slider = (label: string) => screen.getByRole("slider", { name: label }) as HTMLInputElement;
/** A tunable's editable value, beside its label. */
const valueField = (label: string) => screen.getByRole("textbox", { name: label }) as HTMLInputElement;
/** A field commits on Enter, as a person typing a value would. */
async function typeInto(field: HTMLInputElement, text: string) {
  const user = userEvent.setup();
  await user.clear(field);
  await user.type(field, `${text}{Enter}`);
}

describe("DevControls — planning config rendering", () => {
  it("renders each tunable's label and current value", () => {
    render(<DevControls />);
    // Prefetch.
    expect(screen.getByText(/Prefetch depth/)).toBeTruthy();

    // Priority weights.
    expect(screen.getByText(/Importance weight/)).toBeTruthy();
    expect(screen.getByText(/Distance weight/)).toBeTruthy();
    expect(screen.getByText(/Detail render radius/)).toBeTruthy();
    expect(screen.getByText(/Coarse render radius/)).toBeTruthy();

    expect(Number(slider("Importance weight").value)).toBe(DEFAULT_PLANNING_CONFIG.importanceWeight);
    expect(Number(valueField("Importance weight").value)).toBe(DEFAULT_PLANNING_CONFIG.importanceWeight);
  });

  it("collapses lane-offsets section by default", () => {
    render(<DevControls />);
    // Lane offset rows are not in the DOM until toggled open.
    expect(screen.queryByRole("slider", { name: "MINIMAP lane offset" })).toBeNull();
    expect(screen.queryByRole("slider", { name: "DETAIL lane offset" })).toBeNull();
    // The section header + toggle are present.
    expect(screen.getByText(/Lane offsets/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /show/i })).toBeTruthy();
  });

  it("renders lane-offsets and the structural-warning banner once expanded", async () => {
    const user = userEvent.setup();
    render(<DevControls />);
    await user.click(screen.getByRole("button", { name: /show/i }));
    expect(slider("MINIMAP lane offset")).toBeTruthy();
    expect(slider("COARSE lane offset")).toBeTruthy();
    // Warning banner mentions the canonical priority order.
    expect(screen.getByText(/canonical order/i)).toBeTruthy();
  });

  it("offers each planning knob over exactly the range its preference clamps to", async () => {
    const user = userEvent.setup();
    render(<DevControls />);
    await user.click(screen.getByRole("button", { name: /show/i }));
    for (const [field, pref] of Object.entries(PLANNING_KNOB_PREFERENCES)) {
      const range = within(screen.getByTestId(`cfg-${field}`)).getByRole("slider") as HTMLInputElement;
      expect(Number(range.min), field).toBe(pref.parse(-1e12));
      expect(Number(range.max), field).toBe(pref.parse(1e12));
    }
  });
});

describe("DevControls — developer tools", () => {
  it("edits knobs that apply only while developer tools are on", () => {
    render(<DevControls />);
    fireEvent.change(slider("Importance weight"), { target: { value: "120" } });
    expect(configStore.get().importanceWeight).toBe(120);
    act(() => setPreference(developerToolsPreference, false));
    expect(configStore.get().importanceWeight).toBe(DEFAULT_PLANNING_CONFIG.importanceWeight);
  });
});

describe("DevControls — slider + value edits", () => {
  it("moving the importance weight slider updates the configStore", () => {
    render(<DevControls />);
    fireEvent.change(slider("Importance weight"), { target: { value: "120" } });
    expect(configStore.get().importanceWeight).toBe(120);
  });

  it("moving the detail radius slider updates the configStore", () => {
    render(<DevControls />);
    fireEvent.change(slider("Detail render radius (view)"), { target: { value: "0.75" } });
    expect(configStore.get().detailRenderRadiusView).toBe(0.75);
  });

  it("previews only the active radius tier while a radius is adjusted", () => {
    render(<DevControls />);

    fireEvent.change(slider("Detail render radius (view)"), { target: { value: "1" } });
    expect(getRenderRadiusPreviewTier()).toBe("detail");
    fireEvent.pointerUp(window);
    expect(getRenderRadiusPreviewTier()).toBeNull();

    fireEvent.change(slider("Coarse render radius (view)"), { target: { value: "1" } });
    expect(getRenderRadiusPreviewTier()).toBe("coarse");
    fireEvent.pointerCancel(window);
    expect(getRenderRadiusPreviewTier()).toBeNull();

    fireEvent.change(slider("Coarse render radius (view)"), { target: { value: "1.5" } });
    expect(getRenderRadiusPreviewTier()).toBe("coarse");
    fireEvent.keyUp(window);
    expect(getRenderRadiusPreviewTier()).toBeNull();
  });

  it("does not preview radius visuals for unrelated sliders", () => {
    render(<DevControls />);
    fireEvent.change(slider("Importance weight"), { target: { value: "120" } });
    expect(getRenderRadiusPreviewTier()).toBeNull();
  });

  it("typing a value updates the configStore", async () => {
    render(<DevControls />);
    await typeInto(valueField("Importance weight"), "120");
    expect(configStore.get().importanceWeight).toBe(120);
  });

  it("clamps a typed value above the slider max", async () => {
    render(<DevControls />);
    await typeInto(valueField("Importance weight"), "999999");
    // Importance weight slider max is 2000 in the schema.
    expect(configStore.get().importanceWeight).toBe(2000);
  });
});

describe("DevControls — reset arrow", () => {
  it("does not appear when value matches default", () => {
    render(<DevControls />);
    expect(screen.queryByRole("button", { name: /Reset Importance weight/i })).toBeNull();
  });

  it("appears when value differs from default and restores on click", async () => {
    const user = userEvent.setup();
    render(<DevControls />);

    fireEvent.change(slider("Importance weight"), { target: { value: "120" } });

    const resetBtn = await screen.findByRole("button", { name: /Reset Importance weight/i });
    await user.click(resetBtn);

    expect(configStore.get().importanceWeight).toBe(
      DEFAULT_PLANNING_CONFIG.importanceWeight,
    );
  });
});

describe("DevControls — reset all", () => {
  it("Reset all to defaults restores every field", async () => {
    const user = userEvent.setup();
    render(<DevControls />);

    fireEvent.change(slider("Distance weight"), { target: { value: "50" } });
    fireEvent.change(slider("Importance weight"), { target: { value: "1500" } });
    expect(configStore.get().distanceWeight).toBe(50);
    expect(configStore.get().importanceWeight).toBe(1500);

    await user.click(screen.getByRole("button", { name: /reset all to defaults/i }));
    expect(configStore.get()).toEqual(DEFAULT_PLANNING_CONFIG);
  });

  it("is disabled when state already matches defaults", () => {
    render(<DevControls />);
    const btn = screen.getByRole("button", { name: /reset all to defaults/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe("DevControls — cross-constraint warnings", () => {
  it("shows lane-order inversion warning when offsets violate the canonical order", async () => {
    const user = userEvent.setup();
    render(<DevControls />);
    await user.click(screen.getByRole("button", { name: /show/i }));

    // Push DETAIL lane offset above PREFETCH lane offset (default 500 vs
    // 1500) by setting DETAIL to 2000.
    fireEvent.change(slider("DETAIL lane offset"), { target: { value: "2000" } });
    expect(screen.getAllByText(/inverts canonical lane order/i).length).toBeGreaterThan(0);
  });
});

describe("DevControls — read-only mode (production builds)", () => {
  it("shows live values with disabled inputs, no per-field resets, and the note", () => {
    act(() => {
      configStore.set("importanceWeight", 120);
    });
    render(<DevControls editable={false} />);

    expect(slider("Importance weight").disabled).toBe(true);
    expect(Number(slider("Importance weight").value)).toBe(120);
    expect(valueField("Importance weight").disabled).toBe(true);

    // Dirty value, but no per-field reset in read-only mode.
    expect(screen.queryByRole("button", { name: /Reset Importance weight/i })).toBeNull();

    expect(screen.getByText(/read-only in this build/i)).toBeTruthy();
  });

  it("keeps Reset all enabled and working — the recovery path for persisted knobs", async () => {
    // A previous session persisted non-default knobs; with developer tools
    // on they apply in this build, so the user must be able to clear them.
    const user = userEvent.setup();
    act(() => {
      configStore.set("distanceWeight", 50);
      configStore.set("importanceWeight", 1500);
    });
    render(<DevControls editable={false} />);

    const resetAll = screen.getByRole("button", { name: /reset all to defaults/i }) as HTMLButtonElement;
    expect(resetAll.disabled).toBe(false);

    await user.click(resetAll);
    expect(configStore.get()).toEqual(DEFAULT_PLANNING_CONFIG);
    // The preferences are forgotten too, so nothing stale is left for the next load.
    const stored = JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? '{"values":{}}').values;
    expect(Object.keys(stored).filter((key) => key.startsWith("planning."))).toEqual([]);
  });

  it("disables Reset all when nothing differs from defaults", () => {
    render(<DevControls editable={false} />);
    const resetAll = screen.getByRole("button", { name: /reset all to defaults/i }) as HTMLButtonElement;
    expect(resetAll.disabled).toBe(true);
  });

  it("ignores edits to sliders and values", async () => {
    render(<DevControls editable={false} />);
    fireEvent.change(slider("Importance weight"), { target: { value: "120" } });
    expect(configStore.get().importanceWeight).toBe(
      DEFAULT_PLANNING_CONFIG.importanceWeight,
    );
    expect(getRenderRadiusPreviewTier()).toBeNull();
  });
});

describe("DevControls — off-step values", () => {
  it("shows a knob stored between its slider's steps as stored", () => {
    act(() => {
      configStore.set("importanceWeight", 125);
      configStore.set("detailRenderRadiusView", 0.137);
    });
    render(<DevControls />);
    expect(valueField("Importance weight").value).toBe("125");
    expect(valueField("Detail render radius (view)").value).toBe("0.137");
    expect(configStore.get().importanceWeight).toBe(125);
  });
});

describe("DevControls — store subscription", () => {
  it("re-renders when configStore changes externally", async () => {
    render(<DevControls />);
    expect(Number(slider("Importance weight").value)).toBe(DEFAULT_PLANNING_CONFIG.importanceWeight);

    // Change the store directly (bypassing the UI).
    await act(async () => {
      configStore.set("importanceWeight", 170);
    });
    expect(Number(slider("Importance weight").value)).toBe(170);
    expect(Number(valueField("Importance weight").value)).toBe(170);
  });
});

describe("DevControls — overlay toggles", () => {
  it("does not show them: the toggles live in the HUD legend", () => {
    setOverlayEnabled("chunkGrid", true);
    render(<DevControls />);
    for (const name of DEBUG_OVERLAYS) {
      expect(screen.queryByLabelText(name)).toBeNull();
    }
    expect(screen.queryByText("Overlays")).toBeNull();
  });
});

describe("DevControls — cache knobs", () => {
  const knob = (label: string) => screen.getByRole("textbox", { name: label }) as HTMLInputElement;

  it("shows the values the live cache runs under", () => {
    render(<DevControls getCpuCache={() => fakeCache()} />);

    expect(knob("Main budget (MB)").value).toBe("512");
    expect(knob("Overview budget (MB)").value).toBe("128");
    expect(knob("Max fetches").value).toBe("12");
    expect(knob("Max in-flight (MB)").value).toBe("64");
  });

  it("writes each knob to its preference, in the cache's units", async () => {
    render(<DevControls getCpuCache={() => fakeCache()} />);

    await typeInto(knob("Main budget (MB)"), "256");
    await typeInto(knob("Overview budget (MB)"), "64");
    await typeInto(knob("Max fetches"), "24");
    await typeInto(knob("Max in-flight (MB)"), "32");

    expect(readCacheKnobs()).toEqual({
      mainBudgetBytes: 256 * 1024 * 1024,
      overviewBudgetBytes: 64 * 1024 * 1024,
      maxConcurrentFetches: 24,
      maxBytesInFlight: 32 * 1024 * 1024,
    });
  });

  it("shows the edited value back without waiting for a telemetry poll", async () => {
    render(<DevControls getCpuCache={() => fakeCache()} />);
    await typeInto(knob("Main budget (MB)"), "256");
    expect(knob("Main budget (MB)").value).toBe("256");
  });

  it("returns a knob to the cache's own value from its reset arrow", async () => {
    const user = userEvent.setup();
    render(<DevControls getCpuCache={() => fakeCache()} />);
    expect(screen.queryByRole("button", { name: /Reset Max fetches/i })).toBeNull();

    await typeInto(knob("Max fetches"), "24");
    await user.click(await screen.findByRole("button", { name: /Reset Max fetches/i }));
    expect(getPreference(CACHE_KNOB_PREFERENCES.maxConcurrentFetches)).toBeNull();
    expect(knob("Max fetches").value).toBe("12");
  });

  it("ignores non-positive values rather than starving the cache", async () => {
    render(<DevControls getCpuCache={() => fakeCache()} />);
    await typeInto(knob("Max fetches"), "0");
    expect(getPreference(CACHE_KNOB_PREFERENCES.maxConcurrentFetches)).toBeNull();
  });

  it("disables the knobs in read-only builds", async () => {
    render(<DevControls getCpuCache={() => fakeCache()} editable={false} />);
    const input = knob("Main budget (MB)");
    expect(input.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "256" } });
    fireEvent.blur(input);
    expect(getPreference(CACHE_KNOB_PREFERENCES.mainBudgetBytes)).toBeNull();
  });

  it("are cleared by Reset all, which a cache knob alone enables", async () => {
    const user = userEvent.setup();
    act(() => setPreference(CACHE_KNOB_PREFERENCES.maxBytesInFlight, 8 * 1024 * 1024));
    render(<DevControls getCpuCache={() => fakeCache()} />);
    const resetAll = screen.getByRole("button", { name: /reset all to defaults/i }) as HTMLButtonElement;
    expect(resetAll.disabled).toBe(false);
    await user.click(resetAll);
    expect(getPreference(CACHE_KNOB_PREFERENCES.maxBytesInFlight)).toBeNull();
  });

  it("explains the absence of the knobs when no session is connected", () => {
    render(<DevControls getCpuCache={() => null} />);
    expect(screen.queryByRole("textbox", { name: "Main budget (MB)" })).toBeNull();
    expect(screen.getByText(/no session/i)).toBeTruthy();
  });

  it("picks up a session that attaches after the surface is already open", async () => {
    // The session arrives independently of this surface (and can be
    // replaced), so an open surface must not stay stuck on "no session".
    vi.useFakeTimers();
    try {
      let cache: ReturnType<typeof fakeCache> | null = null;
      render(<DevControls getCpuCache={() => cache} />);
      expect(screen.queryByRole("textbox", { name: "Main budget (MB)" })).toBeNull();

      cache = fakeCache({ mainBudgetBytes: 384 * 1024 * 1024 });
      await act(async () => {
        vi.advanceTimersByTime(1100);
      });
      expect(knob("Main budget (MB)").value).toBe("384");
    } finally {
      vi.useRealTimers();
    }
  });
});
