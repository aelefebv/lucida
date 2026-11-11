// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { LinkPopover } from "./LinkPopover.tsx";
import type { ViewLinks } from "../viewLinks.ts";

// The segmented control's selection indicator animates through the Web
// Animations API, which happy-dom lacks.
if (!("getAnimations" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "getAnimations", { value: () => [] });
}

afterEach(cleanup);

const links: ViewLinks = {
  basis: "voxel",
  properties: [
    { property: "pan", mode: "relative" },
    { property: "zoom", mode: "linked" },
    { property: "orientation", mode: "linked", unlinkable: "cameras" },
    { property: "z", mode: "off", unlinkable: "not_yet" },
    { property: "t", mode: "off" },
  ],
};

async function open(onChange = vi.fn(), shown: ViewLinks = links) {
  render(<LinkPopover links={shown} onChange={onChange} />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Link views" }));
  });
  return onChange;
}

const row = (property: string) => document.querySelector(`[data-link-property="${property}"]`) as HTMLElement;

describe("LinkPopover", () => {
  it("shows each property's mode and the basis the links compare in", async () => {
    await open();
    expect(screen.getByText("In voxels, since the datasets don't both declare physical units.")).toBeTruthy();
    const checked = (property: string) =>
      within(row(property)).getAllByRole("radio").find((radio) => radio.getAttribute("aria-checked") === "true")
        ?.textContent;
    expect(checked("pan")).toBe("Relative");
    expect(checked("zoom")).toBe("Linked");
    expect(checked("t")).toBe("Off");
  });

  it("sets a property's mode", async () => {
    const onChange = await open();
    await act(async () => {
      fireEvent.click(within(row("t")).getByRole("radio", { name: "Linked" }));
    });
    expect(onChange).toHaveBeenCalledWith("t", "linked");
  });

  it("says why a property waits for the cameras, and keeps it settable", async () => {
    const onChange = await open();
    expect(within(row("orientation")).getByText("Links between two 3D views.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(row("orientation")).getByRole("radio", { name: "Off" }));
    });
    expect(onChange).toHaveBeenCalledWith("orientation", "off");
  });

  it("can't set Z yet, and says when it can", async () => {
    const onChange = await open();
    expect(within(row("z")).getByText("Z links once depth is a physical place.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(row("z")).getByRole("radio", { name: "Linked" }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("leaves the basis out while a view shows nothing", async () => {
    const empty: ViewLinks = {
      basis: null,
      properties: links.properties.map(({ property }) => ({ property, mode: "off", unlinkable: "empty" })),
    };
    await open(vi.fn(), empty);
    expect(screen.queryByText(/^In (voxels|physical units)/)).toBeNull();
    expect(screen.getAllByText("Each view needs a layer to link.")).toHaveLength(5);
  });
});
