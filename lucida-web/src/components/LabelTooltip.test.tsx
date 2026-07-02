// @vitest-environment happy-dom

/**
 * Render tests for the `<LabelTooltip>` DOM overlay: it shows
 * `"<name> #<id>"` plus one row per property, and degrades to just the title
 * when there are no rows / no name.
 */

import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LabelTooltip } from "./LabelTooltip.tsx";

afterEach(cleanup);

describe("LabelTooltip", () => {
  it("shows the label name, id, and property rows", () => {
    render(
      <LabelTooltip
        x={10}
        y={20}
        name="nuclei"
        value={42}
        rows={[
          { key: "area", value: "128" },
          { key: "name", value: "cell-a" },
        ]}
      />,
    );
    expect(screen.getByTestId("label-tooltip")).toBeTruthy();
    expect(screen.getByTestId("label-tooltip-title").textContent).toBe("nuclei #42");
    // Both property keys and values are present.
    expect(screen.getByText("area")).toBeTruthy();
    expect(screen.getByText("128")).toBeTruthy();
    expect(screen.getByText("name")).toBeTruthy();
    expect(screen.getByText("cell-a")).toBeTruthy();
  });

  it("shows just the id when there are no property rows", () => {
    render(<LabelTooltip x={0} y={0} name="membrane" value={7} rows={[]} />);
    expect(screen.getByTestId("label-tooltip-title").textContent).toBe("membrane #7");
  });

  it("falls back to a positional title when the name is empty", () => {
    render(<LabelTooltip x={0} y={0} name="" value={3} rows={[]} />);
    expect(screen.getByTestId("label-tooltip-title").textContent).toBe("label #3");
  });

  it("keeps a large uint32 id intact in the title", () => {
    render(<LabelTooltip x={0} y={0} name="seg" value={4_000_000_003} rows={[]} />);
    expect(screen.getByTestId("label-tooltip-title").textContent).toBe("seg #4000000003");
  });
});
