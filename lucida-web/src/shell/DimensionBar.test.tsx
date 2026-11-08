// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { __resetKeyboardSeenForTesting } from "../input/fineInput.ts";
import { __resetShortcutsForTesting } from "../ui/shortcuts.ts";
import { DimensionBar, PLAYBACK_INTERVAL_MS } from "./DimensionBar.tsx";

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
  z?: number;
  t?: number;
}

/** The bar wired to its own state, the way App wires it to `useDimensions`. */
function Harness({ mode = "2d", dimZ = 1, dimT = 1, z: z0 = 0, t: t0 = 0 }: Shape) {
  const [viewMode, setViewMode] = useState(mode);
  const [z, setZ] = useState(z0);
  const [t, setT] = useState(t0);
  const [cameraMode, setCameraMode] = useState<"arcball" | "fly">("arcball");
  return (
    <>
      <output data-testid="state">{`${viewMode} z=${z} t=${t} ${cameraMode}`}</output>
      <DimensionBar
        viewMode={viewMode}
        onViewModeToggle={() => setViewMode((m) => (m === "2d" ? "3d" : "2d"))}
        z={z}
        dimZ={dimZ}
        onZChange={setZ}
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

  it("offers the clip plane in the camera popover when there is a volume to clip", async () => {
    const depth = { read: () => 0, write: vi.fn() };
    render(
      <DimensionBar
        viewMode="3d"
        onViewModeToggle={() => {}}
        z={0}
        dimZ={8}
        onZChange={() => {}}
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

  it("leaves channels to the layer panel", () => {
    render(<Harness dimZ={4} />);
    expect(screen.queryByRole("slider", { name: /channel/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /channel/i })).toBeNull();
  });
});
