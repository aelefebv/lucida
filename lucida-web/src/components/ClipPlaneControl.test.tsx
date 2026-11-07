// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClipPlaneControl } from "./ClipPlaneControl.tsx";
import type { ClipDepth } from "./clipDepth.ts";

afterEach(() => cleanup());

function fakeDepth(initial = 0): ClipDepth & { value: () => number } {
  let v = initial;
  return { read: () => v, write: (f) => (v = f), value: () => v };
}

const slider = () => screen.getByRole("slider", { name: "Clip plane" }) as HTMLInputElement;
const clear = () => screen.getByRole("button", { name: "Clear the clip plane" });

describe("ClipPlaneControl", () => {
  it("starts off, with nothing to clear", () => {
    render(<ClipPlaneControl depth={fakeDepth()} />);
    expect(Number(slider().value)).toBe(0);
    expect(clear().hasAttribute("disabled")).toBe(true);
  });

  it("moves the plane from the slider and clears it from the button", async () => {
    const depth = fakeDepth();
    render(<ClipPlaneControl depth={depth} />);
    fireEvent.change(slider(), { target: { value: "0.4" } });
    expect(depth.value()).toBe(0.4);
    await userEvent.click(clear());
    expect(depth.value()).toBe(0);
  });

  it("shows where the keys left it", () => {
    render(<ClipPlaneControl depth={fakeDepth(0.7)} />);
    expect(Number(slider().value)).toBe(0.7);
  });
});
