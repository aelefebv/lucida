// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { __resetKeyboardSeenForTesting } from "../input/fineInput.ts";
import { __resetShortcutsForTesting } from "../ui/shortcuts.ts";
import { DimensionBar, PLAYBACK_INTERVAL_MS } from "./DimensionBar.tsx";
import type { SlicePlane } from "../renderer/slicePlane.ts";

// The segmented control's selection indicator animates through the Web
// Animations API, which happy-dom lacks.
if (!("getAnimations" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "getAnimations", { value: () => [] });
}

afterEach(() => {
  cleanup();
  __resetShortcutsForTesting();
  vi.useRealTimers();
});

interface Shape {
  mode?: "2d" | "3d";
  dimZ?: number;
  dimT?: number;
  /** Planes along Y, which an XZ view cuts. */
  dimY?: number;
  z?: number;
  t?: number;
}

/** The bar wired to its own state, the way App wires it to `useDimensions`. */
function Harness({ mode = "2d", dimZ = 1, dimT = 1, dimY = 1, z: z0 = 0, t: t0 = 0 }: Shape) {
  const [viewMode, setViewMode] = useState(mode);
  const [z, setZ] = useState(z0);
  const [t, setT] = useState(t0);
  const [y, setY] = useState(0);
  const [plane, setPlane] = useState<SlicePlane>("xy");
  const [cameraMode, setCameraMode] = useState<"arcball" | "fly">("arcball");
  const [split, setSplit] = useState(false);
  const side = plane !== "xy";
  return (
    <>
      <output data-testid="state">{`${viewMode} z=${z} t=${t} ${plane} y=${y} ${cameraMode}${split ? " split" : ""}`}</output>
      <DimensionBar
        viewMode={viewMode}
        onViewModeToggle={() => setViewMode((m) => (m === "2d" ? "3d" : "2d"))}
        split={split}
        stacked={false}
        onSplitToggle={() => setSplit((on) => !on)}
        slicePlane={plane}
        onSlicePlaneChange={setPlane}
        dimZ={dimZ}
        cut={side ? y : z}
        dimCut={side ? dimY : dimZ}
        onCutChange={side ? setY : setZ}
        t={t}
        dimT={dimT}
        onTChange={setT}
        cameraMode={cameraMode}
        onCameraModeToggle={() => setCameraMode((m) => (m === "fly" ? "arcball" : "fly"))}
      />
    </>
  );
}

const state = () => screen.getByTestId("state").textContent;
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(document.body, { key, ...init });
  });

describe("DimensionBar", () => {
  it("shows only the mode switch for one plane and one timepoint", () => {
    render(<Harness dimZ={1} dimT={1} />);
    expect(screen.getByRole("radio", { name: "2D" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "3D" })).toBeTruthy();
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Camera" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
  });

  it("shows Z only in 2D, and T and the camera in 3D", async () => {
    render(<Harness mode="3d" dimZ={128} dimT={2} />);
    expect(screen.queryByRole("slider", { name: "Z plane" })).toBeNull();
    expect(screen.getByRole("slider", { name: "Timepoint" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Camera" })).toBeTruthy();

    press("m");
    expect(state()).toMatch(/^2d /);
    expect(screen.getByRole("slider", { name: "Z plane" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Camera" })).toBeNull();
  });

  it("switches the camera from its popover", async () => {
    render(<Harness mode="3d" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Camera" }));
    });
    const fly = await screen.findByRole("radio", { name: "Fly" });
    await act(async () => {
      fireEvent.click(fly);
    });
    expect(state()).toMatch(/ fly$/);
    expect(screen.getByRole("slider", { name: "Focal depth" })).toBeTruthy();
  });

  it("splits the canvas into two views and shows one again", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Split view" }));
    expect(screen.getByTestId("state").textContent).toContain("split");
    fireEvent.click(screen.getByRole("button", { name: "Show one view" }));
    expect(screen.getByTestId("state").textContent).not.toContain("split");
  });

  it("offers the view links only while two views divide the canvas", () => {
    const links = { links: { basis: "physical" as const, properties: [] }, onChange: vi.fn() };
    const bar = (split: boolean) => (
      <DimensionBar
        viewMode="2d"
        onViewModeToggle={() => {}}
        split={split}
        stacked={false}
        onSplitToggle={() => {}}
        links={links}
        slicePlane="xy"
        onSlicePlaneChange={() => {}}
        dimZ={1}
        cut={0}
        dimCut={1}
        onCutChange={() => {}}
        t={0}
        dimT={1}
        onTChange={() => {}}
        cameraMode="arcball"
        onCameraModeToggle={() => {}}
      />
    );
    const { rerender } = render(bar(true));
    expect(screen.getByRole("button", { name: "Link views" })).toBeTruthy();
    rerender(bar(false));
    expect(screen.queryByRole("button", { name: "Link views" })).toBeNull();
  });

  it("offers the clip plane in the camera popover when there is a volume to clip", async () => {
    const depth = { read: () => 0, write: vi.fn() };
    render(
      <DimensionBar
        viewMode="3d"
        onViewModeToggle={() => {}}
        split={false}
        stacked={false}
        onSplitToggle={() => {}}
        slicePlane="xy"
        onSlicePlaneChange={() => {}}
        dimZ={8}
        cut={0}
        dimCut={8}
        onCutChange={() => {}}
        t={0}
        dimT={1}
        onTChange={() => {}}
        cameraMode="arcball"
        onCameraModeToggle={() => {}}
        clipDepth={depth}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Camera" }));
    });
    fireEvent.change(await screen.findByRole("slider", { name: "Clip plane" }), { target: { value: "0.3" } });
    expect(depth.write).toHaveBeenCalledWith(0.3);
  });

  it("leaves fly mode out with no mouse, trackpad, or keyboard, unless already flying", async () => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) =>
      query.includes("pointer: fine")
        ? { matches: false, addEventListener: () => {}, removeEventListener: () => {} }
        : realMatchMedia(query)) as unknown as typeof window.matchMedia;
    __resetKeyboardSeenForTesting();
    try {
      render(<Harness mode="3d" />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Camera" }));
      });
      expect(screen.queryByRole("radio", { name: "Fly" })).toBeNull();
      expect(screen.getByRole("slider", { name: "Focal depth" })).toBeTruthy();

      // A key pressed outside a text field means a keyboard is attached.
      press("x");
      expect(await screen.findByRole("radio", { name: "Fly" })).toBeTruthy();
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  it("shows where the cut stands as a physical coordinate beside its position", () => {
    const bar = (cutPlace?: { label: string; width: number }) => (
      <DimensionBar
        viewMode="2d"
        onViewModeToggle={() => {}}
        split={false}
        stacked={false}
        onSplitToggle={() => {}}
        slicePlane="xy"
        onSlicePlaneChange={() => {}}
        dimZ={96}
        cut={48}
        cutPlace={cutPlace}
        dimCut={96}
        onCutChange={() => {}}
        t={0}
        dimT={1}
        onTChange={() => {}}
        cameraMode="arcball"
        onCameraModeToggle={() => {}}
      />
    );
    const { rerender } = render(bar({ label: "48.5 µm", width: 7 }));
    const readout = document.querySelector(".lc-dim-readout")!;
    expect(readout.textContent).toBe("49 / 9648.5 µm");
    expect((readout.querySelector(".lc-dim-place") as HTMLElement).style.minWidth).toBe("7ch");
    rerender(bar());
    expect(document.querySelector(".lc-dim-place")).toBeNull();
  });

  it("steps Z and T from their keys, which the buttons name", () => {
    render(<Harness dimZ={10} dimT={5} z={4} t={2} />);
    press("PageDown");
    press("ArrowDown", { shiftKey: true });
    expect(state()).toContain("z=6");
    press("PageUp");
    expect(state()).toContain("z=5");
    press("ArrowUp", { shiftKey: true });
    expect(state()).toContain("z=4");
    press(".");
    expect(state()).toContain("t=3");
    press(",");
    press(",");
    expect(state()).toContain("t=1");

    expect(
      screen.getByRole("button", { name: "Previous Z plane" }).getAttribute("aria-keyshortcuts"),
    ).toBe("PageUp Shift+ArrowUp");
    expect(screen.getByRole("button", { name: "Next Z plane" }).getAttribute("aria-keyshortcuts")).toBe(
      "PageDown Shift+ArrowDown",
    );
    expect(screen.getByRole("button", { name: "Previous timepoint" }).getAttribute("aria-keyshortcuts")).toBe(",");
    expect(screen.getByRole("button", { name: "Next timepoint" }).getAttribute("aria-keyshortcuts")).toBe(".");
    expect(screen.getByRole("button", { name: "Play" }).getAttribute("aria-keyshortcuts")).toBe("Space");
  });

  it("moves one position per press when several land before a render", () => {
    render(<Harness dimZ={10} dimT={5} z={4} t={2} />);
    const next = screen.getByRole("button", { name: "Next Z plane" });
    act(() => {
      fireEvent.click(next);
      fireEvent.click(next);
      fireEvent.click(next);
    });
    expect(state()).toContain("z=7");

    act(() => {
      fireEvent.keyDown(document.body, { key: "," });
      fireEvent.keyDown(document.body, { key: "," });
      fireEvent.keyDown(document.body, { key: "," });
    });
    expect(state()).toContain("t=0");
  });

  it("stops at the ends of Z rather than wrapping", () => {
    render(<Harness dimZ={3} z={2} />);
    press("PageDown");
    expect(state()).toContain("z=2");
    expect(screen.getByRole("button", { name: "Next Z plane" }).hasAttribute("disabled")).toBe(true);
  });

  it("leaves the Z keys unbound in 3D and with one plane", () => {
    render(<Harness mode="3d" dimZ={10} z={4} />);
    press("PageDown");
    expect(state()).toContain("z=4");
  });

  it("plays time in a loop, and stops on a scrub or on Space", () => {
    vi.useFakeTimers();
    render(<Harness dimT={3} t={1} />);
    press(" ");
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    act(() => vi.advanceTimersByTime(PLAYBACK_INTERVAL_MS));
    expect(state()).toContain("t=2");
    act(() => vi.advanceTimersByTime(PLAYBACK_INTERVAL_MS));
    expect(state()).toContain("t=0");

    // A scrub takes over.
    press(".");
    expect(state()).toContain("t=1");
    act(() => vi.advanceTimersByTime(PLAYBACK_INTERVAL_MS * 3));
    expect(state()).toContain("t=1");
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();

    press(" ");
    act(() => vi.advanceTimersByTime(PLAYBACK_INTERVAL_MS));
    expect(state()).toContain("t=2");
    press(" ");
    act(() => vi.advanceTimersByTime(PLAYBACK_INTERVAL_MS * 3));
    expect(state()).toContain("t=2");
  });

  it("leaves Space to a focused button", () => {
    vi.useFakeTimers();
    render(
      <>
        <button type="button">elsewhere</button>
        <Harness dimT={3} />
      </>,
    );
    const elsewhere = screen.getByRole("button", { name: "elsewhere" });
    elsewhere.focus();
    act(() => {
      fireEvent.keyDown(elsewhere, { key: " " });
    });
    act(() => vi.advanceTimersByTime(PLAYBACK_INTERVAL_MS * 2));
    expect(state()).toContain("t=0");
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });

  it("cuts another plane from its toggle or Shift+M, and then scrubs the axis that plane cuts", () => {
    render(<Harness dimZ={10} dimY={40} z={4} />);
    expect(screen.getByRole("slider", { name: /Z plane/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "XZ" }));
    expect(state()).toContain("xz");
    expect(screen.queryByRole("slider", { name: /Z plane/ })).toBeNull();
    expect(screen.getByRole("slider", { name: /Y plane/ })).toBeTruthy();
    act(() => {
      fireEvent.keyDown(document.body, { key: "PageDown" });
    });
    expect(state()).toContain("y=1");
    expect(state()).toContain("z=4");
    act(() => {
      fireEvent.keyDown(document.body, { key: "M", shiftKey: true });
    });
    expect(state()).toContain("yz");
  });

  it("offers no plane to cut where the data has one Z plane, nor in 3D", () => {
    render(<Harness dimZ={1} dimY={40} />);
    expect(screen.queryByRole("radiogroup", { name: "Slice plane" })).toBeNull();
    cleanup();
    __resetShortcutsForTesting();
    render(<Harness mode="3d" dimZ={10} />);
    expect(screen.queryByRole("radiogroup", { name: "Slice plane" })).toBeNull();
  });

  it("leaves channels to the layer panel", () => {
    render(<Harness dimZ={4} />);
    expect(screen.queryByRole("slider", { name: /channel/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /channel/i })).toBeNull();
  });
});
