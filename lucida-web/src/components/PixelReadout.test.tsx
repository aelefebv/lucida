// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { WasmScene } from "lucida-core";
import type { RenderClient } from "../renderer/renderClient.ts";
import type { ProbeSample } from "../renderer/workerProtocol.ts";
import { Hover } from "../viewer/hover.ts";
import { PixelReadout, type PixelReadoutHandle, type ReadoutLoop } from "./PixelReadout.tsx";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout"] });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const SAMPLE: ProbeSample = { datasetId: "ds", entityId: "img", channel: 0, position: [3, 4, 0], state: "value", value: 42, level: 0 };

/**
 * A readout over one view filling a 200x100 canvas, whose worker draws a
 * frame whenever `drawFrame` is called. Its viewer moves the camera under a
 * held button with the `navigate` tool, as its loop hears, and draws a mark
 * with the `annotate` tool, which leaves the camera still.
 */
function readout(tool: "navigate" | "annotate" = "navigate") {
  const eventRoot = document.createElement("div");
  const pane = document.createElement("div");
  pane.dataset.viewPane = "0";
  pane.getBoundingClientRect = () => new DOMRect(0, 0, 200, 100);
  eventRoot.append(pane);
  document.body.append(eventRoot);
  let cameraAt = -Infinity;
  pane.addEventListener("pointermove", (e) => {
    if (e.buttons !== 0 && tool === "navigate") cameraAt = performance.now();
  });
  const loop: ReadoutLoop = { markHover() {}, noteHoverDrawn() {}, cameraMovedSince: (atMs) => cameraAt >= atMs };
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 200 });
  Object.defineProperty(canvas, "clientHeight", { value: 100 });
  let frame = 0;
  const probe = vi.fn(async () => [SAMPLE]);
  const client = { probe, lastFrameSeq: () => frame } as unknown as RenderClient;
  const scene = {
    view_rect: () => [0, 0, 1, 1],
    crosshairs: () => "[]",
    view_camera_mode: () => "slice",
    slice_plane: () => "xy",
    all_dataset_settings: () => "{}",
    dataset_name: () => "ds",
  } as unknown as WasmScene;
  const handle = createRef<PixelReadoutHandle>();
  render(
    <PixelReadout
      ref={handle}
      canvas={canvas}
      eventRoot={eventRoot}
      client={client}
      scene={scene}
      datasets={new Map()}
      layers={new Map()}
      hover={new Hover()}
      loop={() => loop}
    />,
  );
  /** Move the pointer over the view with `buttons` down, then let a frame or two go by. */
  const move = async (clientX: number, buttons = 0) => {
    pane.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientX, clientY: 50, buttons }));
    await tick();
  };
  const down = async (clientX: number) => {
    pane.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", clientX, clientY: 50, buttons: 1 }));
    await tick();
  };
  const up = async (pointerType = "mouse") => {
    pane.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType, clientX: 0, clientY: 50 }));
    await tick();
  };
  /** A finger rests on the view long enough to press, then lifts. */
  const press = async (clientX: number) => {
    act(() => handle.current!.pressAt({ clientX, clientY: 50 }));
    await tick();
  };
  const touchDown = async () => {
    pane.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", clientX: 50, clientY: 50, buttons: 1 }));
    await tick();
  };
  const drawFrame = async () => {
    frame++;
    await tick();
  };
  return { probe, move, down, up, press, touchDown, drawFrame };
}

/** Two animation frames, and the reads they send settled. */
async function tick(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(40);
  });
}

describe("PixelReadout", () => {
  it("reads nothing while a drag moves the camera, and the point it ended on once it does", async () => {
    const { probe, move, down, up, drawFrame } = readout("navigate");
    await move(100);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("pixel-readout").textContent).toContain("42");

    // The button goes down and the drag moves the camera: frames are drawn, and none is read.
    await down(100);
    await move(110, 1);
    expect(screen.queryByTestId("pixel-readout")).toBeNull();
    for (let i = 0; i < 3; i++) {
      await drawFrame();
      await move(120 + i, 1);
    }
    expect(probe).toHaveBeenCalledTimes(1);

    await up();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls[1]).toEqual([122 / 200, 0.5, undefined]);
    expect(screen.getByTestId("pixel-readout")).toBeTruthy();
  });

  it("goes on reading under a drag that draws a mark, which leaves the camera still", async () => {
    const { probe, move, down, up, drawFrame } = readout("annotate");
    await move(100);
    expect(probe).toHaveBeenCalledTimes(1);

    await down(100);
    for (let i = 0; i < 3; i++) {
      await move(110 + i, 1);
      await drawFrame();
    }
    expect(probe).toHaveBeenCalledTimes(7);
    expect(probe.mock.calls[6]).toEqual([112 / 200, 0.5, undefined]);
    expect(screen.getByTestId("pixel-readout")).toBeTruthy();
    await up();
    expect(probe).toHaveBeenCalledTimes(7);
  });

  it("reads nothing while a finger moves the view after a long press", async () => {
    const { probe, press, touchDown, up, drawFrame } = readout();
    await press(100);
    expect(probe).toHaveBeenCalledTimes(1);
    await up("touch");

    // The next finger to land starts a gesture, which takes the card away.
    await touchDown();
    expect(screen.queryByTestId("pixel-readout")).toBeNull();
    for (let i = 0; i < 3; i++) await drawFrame();
    await up("touch");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("follows arriving data under a still pointer with no button down", async () => {
    const { probe, move, drawFrame } = readout();
    await move(100);
    await drawFrame();
    await drawFrame();
    expect(probe).toHaveBeenCalledTimes(3);
  });
});
