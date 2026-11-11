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
    { property: "z", mode: "linked", unlinkable: "cameras" },
    { property: "t", mode: "off" },
  ],
  notices: [],
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
    expect(screen.getByText("In samples, since the datasets don't both declare physical units.")).toBeTruthy();
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

  it("says Z links between two 2D views of one plane", async () => {
    await open();
    expect(within(row("z")).getByText("Links between two 2D views of one plane.")).toBeTruthy();
  });

  it("says why a pair without units links in samples", async () => {
    await open(vi.fn(), { ...links, alike: "same_dataset" });
    expect(screen.getByText("In samples; both views show the same dataset.")).toBeTruthy();
    cleanup();
    await open(vi.fn(), { ...links, alike: "same_placement" });
    expect(screen.getByText("In samples; both datasets have the same shape and placement.")).toBeTruthy();
  });

  it("offers a colormap linked or off, and lists the channels the channel links pair", async () => {
    const shown: ViewLinks = {
      ...links,
      properties: [...links.properties, { property: "contrast", mode: "off" }, { property: "colormap", mode: "off" }],
      channels: [
        { first: 0, second: 1, first_name: "DAPI", second_name: "DAPI", by: "name" },
        { first: 2, second: 2, first_name: "RFP", second_name: "Cy5", by: "index" },
      ],
    };
    await open(vi.fn(), shown);
    const options = within(row("colormap")).getAllByRole("radio").map((radio) => radio.textContent);
    expect(options).toEqual(["Linked", "Off"]);
    expect(within(row("contrast")).getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByText("DAPI ↔ DAPI")).toBeTruthy();
    expect(screen.getByText("RFP ↔ Cy5 (by place)")).toBeTruthy();
  });

  it("can't link the channels of one dataset shown in both views, and says why", async () => {
    const onChange = vi.fn();
    const shown: ViewLinks = {
      ...links,
      properties: [{ property: "contrast", mode: "off", unlinkable: "shared" }],
    };
    await open(onChange, shown);
    expect(within(row("contrast")).getByText("Both views show one dataset, so its channels share one setting.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(row("contrast")).getByRole("radio", { name: "Linked" }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("leaves the basis out while a view shows nothing", async () => {
    const empty: ViewLinks = {
      basis: null,
      properties: links.properties.map(({ property }) => ({ property, mode: "off", unlinkable: "empty" })),
      notices: [],
    };
    await open(vi.fn(), empty);
    expect(screen.queryByText(/^In (samples|physical units)/)).toBeNull();
    expect(screen.getAllByText("Each view needs a layer to link.")).toHaveLength(5);
  });
});
