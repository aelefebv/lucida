// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { Tool } from "../components/annotationTool.ts";
import { pressAnnotationKind } from "../components/annotationTool.ts";
import { __resetCommandsForTesting, listCommands } from "../ui/commands.ts";
import { __resetEscapeLayersForTesting, pushEscapeLayer } from "../ui/escape.ts";
import { __resetShortcutsForTesting } from "../ui/shortcuts.ts";
import { ToolPalette } from "./ToolPalette.tsx";

afterEach(() => {
  cleanup();
  __resetCommandsForTesting();
  __resetShortcutsForTesting();
  __resetEscapeLayersForTesting();
});

function Harness({ canMove = false }: { canMove?: boolean }) {
  const [tool, setTool] = useState<Tool>("pan");
  const [visible, setVisible] = useState(true);
  return (
    <>
      <ToolPalette
        tool={tool}
        onToolChange={setTool}
        annotationsVisible={visible}
        onAnnotationsVisibleChange={setVisible}
        canMove={canMove}
      />
      <output data-testid="state">{`${tool} ${visible ? "shown" : "hidden"}`}</output>
    </>
  );
}

const state = () => screen.getByTestId("state").textContent;

async function press(init: KeyboardEventInit) {
  await act(async () => {
    fireEvent.keyDown(window, init);
  });
}

describe("ToolPalette", () => {
  it("picks a tool with the mouse alone", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Pan tool" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Box tool" }));
    expect(state()).toBe("box shown");
    expect(screen.getByRole("button", { name: "Box tool" }).getAttribute("aria-pressed")).toBe("true");
    // Clicking the current tool keeps it.
    fireEvent.click(screen.getByRole("button", { name: "Box tool" }));
    expect(state()).toBe("box shown");
  });

  it("picks tools and hides annotations from the keyboard", async () => {
    render(<Harness />);
    await press({ key: "p", code: "KeyP" });
    expect(state()).toBe("point shown");
    await press({ key: "l", code: "KeyL" });
    expect(state()).toBe("line shown");
    await press({ key: "A", code: "KeyA", shiftKey: true });
    expect(state()).toBe("line hidden");
    expect(screen.getByRole("button", { name: "Hide annotations" }).getAttribute("aria-pressed")).toBe("true");
    await press({ key: "v", code: "KeyV" });
    expect(state()).toBe("pan hidden");
  });

  it("offers its tools and the visibility toggle in the palette", () => {
    render(<Harness />);
    expect(listCommands().map((c) => c.label)).toEqual([
      "Pan tool",
      "Point tool",
      "Line tool",
      "Box tool",
      "Hide annotations",
    ]);
  });

  it("offers the move tool only to a member who may place layers", async () => {
    render(<Harness />);
    expect(screen.queryByRole("button", { name: "Move, scale and rotate tool" })).toBeNull();
    await press({ key: "t", code: "KeyT" });
    expect(state()).toBe("pan shown");
    cleanup();
    __resetCommandsForTesting();
    __resetShortcutsForTesting();

    render(<Harness canMove />);
    await press({ key: "t", code: "KeyT" });
    expect(state()).toBe("move shown");
    expect(screen.getByRole("button", { name: "Move, scale and rotate tool" }).getAttribute("aria-pressed")).toBe("true");
    await press({ key: "Escape", code: "Escape" });
    expect(state()).toBe("pan shown");
  });

  it("cancels what Escape should first, then returns to the pan tool", async () => {
    render(<Harness />);
    await press({ key: "b", code: "KeyB" });
    let cancelled = 0;
    pushEscapeLayer(() => cancelled++);

    await press({ key: "Escape", code: "Escape" });
    expect(cancelled).toBe(1);
    expect(state()).toBe("box shown");

    await press({ key: "Escape", code: "Escape" });
    expect(state()).toBe("pan shown");
  });

  it("leaves Escape alone when there is nothing to undo", async () => {
    render(<Harness />);
    const event = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("pressAnnotationKind", () => {
  it("draws with an annotation tool, and drops a point on shift from the pan tool", () => {
    expect(pressAnnotationKind("pan", false)).toBeNull();
    expect(pressAnnotationKind("pan", true)).toBe("point");
    expect(pressAnnotationKind("line", false)).toBe("line");
    expect(pressAnnotationKind("box", true)).toBe("box");
    // The move tool's outline takes its presses; anywhere else navigates.
    expect(pressAnnotationKind("move", false)).toBeNull();
    expect(pressAnnotationKind("move", true)).toBeNull();
  });
});
