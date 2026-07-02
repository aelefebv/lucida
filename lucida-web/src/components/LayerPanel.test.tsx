// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LayerPanel, type LayerInfo } from "./LayerPanel.tsx";

function layer(overrides: Partial<LayerInfo> = {}): LayerInfo {
  return {
    id: "wds-1",
    name: "original.zarr",
    visible: true,
    opacity: 1,
    contrastMin: 0,
    contrastMax: 65535,
    gamma: 1,
    colormap: "gray",
    blendMode: "alpha",
    renderMode: "translucent",
    autoContrast: true,
    fullRange: false,
    dataRange: null,
    fullRangeMax: 65535,
    channelBlendMode: "additive",
    detailLevelOverride: null,
    detailLevelOptions: [],
    ...overrides,
  };
}

function baseProps(
  canEdit: boolean,
  onRenameLayer: (id: string, name: string) => void,
) {
  return {
    layers: [layer()],
    selectedLayerId: null,
    expandedLayerId: null,
    multiChannel: false,
    onSelectLayer: vi.fn(),
    onToggleExpand: vi.fn(),
    onSetVisible: vi.fn(),
    onSetOpacity: vi.fn(),
    onSetContrast: vi.fn(),
    onSetGamma: vi.fn(),
    onSetColormap: vi.fn(),
    onSetBlendMode: vi.fn(),
    onSetRenderMode: vi.fn(),
    onSetDetailLevelOverride: vi.fn(),
    onAutoContrast: vi.fn(),
    onAutoContrastToggle: vi.fn(),
    onFullRangeToggle: vi.fn(),
    onMoveLayer: vi.fn(),
    onRemoveLayer: vi.fn(),
    onRenameLayer,
    onAddLayer: vi.fn(),
    canEdit,
    viewModeToggle: null,
    cameraModeToggle: null,
    layoutRegistry: null,
    sendCommand: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
});

describe("LayerPanel rename affordance", () => {
  it("shows the layer name and, for an editor, a rename affordance", () => {
    const onRenameLayer = vi.fn();
    render(<LayerPanel {...baseProps(true, onRenameLayer)} />);
    expect(screen.getByText("original.zarr")).toBeTruthy();
    expect(screen.getByLabelText("Rename layer original.zarr")).toBeTruthy();
  });

  it("does NOT show the rename affordance for a viewer", () => {
    const onRenameLayer = vi.fn();
    render(<LayerPanel {...baseProps(false, onRenameLayer)} />);
    expect(screen.getByText("original.zarr")).toBeTruthy();
    expect(screen.queryByLabelText("Rename layer original.zarr")).toBeNull();
  });

  it("commits a new name on Enter and calls onRenameLayer with the trimmed value", () => {
    const onRenameLayer = vi.fn();
    render(<LayerPanel {...baseProps(true, onRenameLayer)} />);

    fireEvent.click(screen.getByLabelText("Rename layer original.zarr"));
    const input = screen.getByLabelText("Layer name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Renamed Layer  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRenameLayer).toHaveBeenCalledTimes(1);
    expect(onRenameLayer).toHaveBeenCalledWith("wds-1", "  Renamed Layer  ");
    // After commit, the inline input is gone (back to the display span).
    expect(screen.queryByLabelText("Layer name")).toBeNull();
  });

  it("cancels on Escape without calling onRenameLayer", () => {
    const onRenameLayer = vi.fn();
    render(<LayerPanel {...baseProps(true, onRenameLayer)} />);

    fireEvent.click(screen.getByLabelText("Rename layer original.zarr"));
    const input = screen.getByLabelText("Layer name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "discard me" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onRenameLayer).not.toHaveBeenCalled();
    // The input is gone and the original name is shown again.
    expect(screen.queryByLabelText("Layer name")).toBeNull();
    expect(screen.getByText("original.zarr")).toBeTruthy();
  });

  it("reflects an updated layer name from props", () => {
    const onRenameLayer = vi.fn();
    const { rerender } = render(<LayerPanel {...baseProps(true, onRenameLayer)} />);
    expect(screen.getByText("original.zarr")).toBeTruthy();

    const props = baseProps(true, onRenameLayer);
    props.layers = [layer({ name: "Renamed Layer" })];
    rerender(<LayerPanel {...props} />);
    expect(screen.getByText("Renamed Layer")).toBeTruthy();
    expect(screen.queryByText("original.zarr")).toBeNull();
  });
});

describe("LayerPanel channel labels", () => {
  const channelSettings = [
    { visible: true, colormap: "gray", contrast_min: 0, contrast_max: 65535, gamma: 1 },
    { visible: true, colormap: "green", contrast_min: 0, contrast_max: 65535, gamma: 1 },
  ];

  function multiChannelProps(overrides: Partial<LayerInfo> = {}) {
    return {
      ...baseProps(true, vi.fn()),
      multiChannel: true,
      // Expanded so the per-channel sublayer rows render.
      expandedLayerId: "wds-1" as string | null,
      layers: [layer({ channelSettings, ...overrides })],
    };
  }

  it("shows omero labels when present", () => {
    render(
      <LayerPanel
        {...multiChannelProps({
          channelInfos: [{ label: "DAPI" }, { label: "GFP" }],
        })}
      />,
    );
    expect(screen.getByText("DAPI")).toBeTruthy();
    expect(screen.getByText("GFP")).toBeTruthy();
    // No fallback labels should appear when both channels are named.
    expect(screen.queryByText("Ch 0")).toBeNull();
    expect(screen.queryByText("Ch 1")).toBeNull();
  });

  it("falls back to `Ch N` when channelInfos is absent", () => {
    render(<LayerPanel {...multiChannelProps({ channelInfos: undefined })} />);
    expect(screen.getByText("Ch 0")).toBeTruthy();
    expect(screen.getByText("Ch 1")).toBeTruthy();
  });

  it("falls back per-index for missing/blank entries (positional)", () => {
    render(
      <LayerPanel
        {...multiChannelProps({
          // Only channel 0 has a usable label; channel 1 falls back.
          channelInfos: [{ label: "DAPI" }],
        })}
      />,
    );
    expect(screen.getByText("DAPI")).toBeTruthy();
    expect(screen.getByText("Ch 1")).toBeTruthy();
    expect(screen.queryByText("Ch 0")).toBeNull();
  });

  it("falls back when a label is an empty string", () => {
    render(
      <LayerPanel
        {...multiChannelProps({
          channelInfos: [{ label: "" }, { label: "GFP" }],
        })}
      />,
    );
    // Empty label -> positional fallback for channel 0.
    expect(screen.getByText("Ch 0")).toBeTruthy();
    expect(screen.getByText("GFP")).toBeTruthy();
  });
});

describe("LayerPanel channel rename", () => {
  function multiChannelProps(
    overrides: Partial<LayerInfo>,
    extra: Record<string, unknown> = {},
  ) {
    return {
      ...baseProps(true, vi.fn()),
      multiChannel: true,
      expandedLayerId: "wds-1" as string | null,
      layers: [layer(overrides)],
      ...extra,
    };
  }

  // The 3-tier precedence: user override > omero label > `Ch N`.
  it("prefers the user override over the omero label and `Ch N`", () => {
    render(
      <LayerPanel
        {...multiChannelProps({
          channelSettings: [
            // ch0: user override beats the omero label "DAPI".
            { visible: true, colormap: "gray", contrast_min: 0, contrast_max: 65535, gamma: 1, name: "Nucleus" },
            // ch1: no override → omero label "GFP".
            { visible: true, colormap: "green", contrast_min: 0, contrast_max: 65535, gamma: 1 },
            // ch2: no override, no omero entry → `Ch 2`.
            { visible: true, colormap: "cyan", contrast_min: 0, contrast_max: 65535, gamma: 1 },
          ],
          channelInfos: [{ label: "DAPI" }, { label: "GFP" }],
        })}
      />,
    );
    // Tier 1: override wins, the omero label is NOT shown.
    expect(screen.getByText("Nucleus")).toBeTruthy();
    expect(screen.queryByText("DAPI")).toBeNull();
    // Tier 2: omero label for the un-renamed channel.
    expect(screen.getByText("GFP")).toBeTruthy();
    // Tier 3: positional fallback when neither override nor omero exists.
    expect(screen.getByText("Ch 2")).toBeTruthy();
  });

  it("shows a channel rename affordance for an editor, hidden for a viewer", () => {
    const named = {
      channelSettings: [
        { visible: true, colormap: "gray", contrast_min: 0, contrast_max: 65535, gamma: 1 },
      ],
      channelInfos: [{ label: "DAPI" }],
    } satisfies Partial<LayerInfo>;

    const { rerender } = render(<LayerPanel {...multiChannelProps(named)} />);
    expect(screen.getByLabelText("Rename channel DAPI")).toBeTruthy();

    rerender(
      <LayerPanel {...multiChannelProps(named, { canEdit: false })} />,
    );
    expect(screen.queryByLabelText("Rename channel DAPI")).toBeNull();
  });

  it("commits a trimmed name on Enter via onChannelSetName", () => {
    const onChannelSetName = vi.fn();
    render(
      <LayerPanel
        {...multiChannelProps(
          {
            channelSettings: [
              { visible: true, colormap: "gray", contrast_min: 0, contrast_max: 65535, gamma: 1 },
            ],
            channelInfos: [{ label: "DAPI" }],
          },
          { onChannelSetName },
        )}
      />,
    );

    fireEvent.click(screen.getByLabelText("Rename channel DAPI"));
    const input = screen.getByLabelText("Channel name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Nucleus  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChannelSetName).toHaveBeenCalledTimes(1);
    expect(onChannelSetName).toHaveBeenCalledWith("wds-1", 0, "Nucleus");
    // The inline input is gone after commit.
    expect(screen.queryByLabelText("Channel name")).toBeNull();
  });

  it("clears the override (null) when committed empty, falling back to omero", () => {
    const onChannelSetName = vi.fn();
    render(
      <LayerPanel
        {...multiChannelProps(
          {
            // Currently overridden to "Nucleus".
            channelSettings: [
              { visible: true, colormap: "gray", contrast_min: 0, contrast_max: 65535, gamma: 1, name: "Nucleus" },
            ],
            channelInfos: [{ label: "DAPI" }],
          },
          { onChannelSetName },
        )}
      />,
    );

    // Override shows first.
    expect(screen.getByText("Nucleus")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Rename channel Nucleus"));
    const input = screen.getByLabelText("Channel name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Blank commit clears the override.
    expect(onChannelSetName).toHaveBeenCalledTimes(1);
    expect(onChannelSetName).toHaveBeenCalledWith("wds-1", 0, null);
  });

  it("cancels on Escape without calling onChannelSetName", () => {
    const onChannelSetName = vi.fn();
    render(
      <LayerPanel
        {...multiChannelProps(
          {
            channelSettings: [
              { visible: true, colormap: "gray", contrast_min: 0, contrast_max: 65535, gamma: 1 },
            ],
            channelInfos: [{ label: "DAPI" }],
          },
          { onChannelSetName },
        )}
      />,
    );

    fireEvent.click(screen.getByLabelText("Rename channel DAPI"));
    const input = screen.getByLabelText("Channel name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "discard me" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onChannelSetName).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Channel name")).toBeNull();
    // The original (omero) label is shown again.
    expect(screen.getByText("DAPI")).toBeTruthy();
  });
});

describe("LayerPanel per-channel collapse", () => {
  const channelSettings = [
    { visible: true, colormap: "gray", contrast_min: 0, contrast_max: 65535, gamma: 1 },
    { visible: true, colormap: "green", contrast_min: 0, contrast_max: 65535, gamma: 1 },
  ];

  function collapseProps(
    overrides: Partial<LayerInfo> = {},
    extra: Record<string, unknown> = {},
  ) {
    return {
      ...baseProps(true, vi.fn()),
      multiChannel: true,
      expandedLayerId: "wds-1" as string | null,
      layers: [
        layer({
          channelSettings,
          channelInfos: [{ label: "DAPI" }, { label: "GFP" }],
          ...overrides,
        }),
      ],
      ...extra,
    };
  }

  // The colormap selector is the per-channel "detail" the toggle discloses; its
  // aria-label carries the `${layer} ${chName}` prefix.
  const dapiColormap = "original.zarr DAPI colormap";
  const gfpColormap = "original.zarr GFP colormap";

  it("defaults to COLLAPSED: channels show an Expand toggle but hide their controls", () => {
    render(<LayerPanel {...collapseProps()} />);
    expect(screen.getByLabelText("Expand channel DAPI")).toBeTruthy();
    expect(screen.getByLabelText("Expand channel GFP")).toBeTruthy();
    expect(screen.queryByLabelText(dapiColormap)).toBeNull();
    expect(screen.queryByLabelText(gfpColormap)).toBeNull();
  });

  it("the toggle is a real disclosure button, aria-expanded=false by default", () => {
    render(<LayerPanel {...collapseProps()} />);
    const t = screen.getByLabelText("Expand channel DAPI");
    expect(t.tagName).toBe("BUTTON");
    expect(t.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(t);
    expect(screen.getByLabelText("Collapse channel DAPI").getAttribute("aria-expanded")).toBe("true");
  });

  it("expanding a channel shows its controls; collapsing hides them again", () => {
    render(<LayerPanel {...collapseProps()} />);
    fireEvent.click(screen.getByLabelText("Expand channel DAPI"));
    expect(screen.getByLabelText(dapiColormap)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Collapse channel DAPI"));
    expect(screen.queryByLabelText(dapiColormap)).toBeNull();
  });

  it("expanding one channel leaves the others collapsed (no cross-channel bleed)", () => {
    render(<LayerPanel {...collapseProps()} />);
    fireEvent.click(screen.getByLabelText("Expand channel DAPI"));
    expect(screen.getByLabelText(dapiColormap)).toBeTruthy();
    expect(screen.queryByLabelText(gfpColormap)).toBeNull();
    expect(screen.getByLabelText("Expand channel GFP")).toBeTruthy();
  });

  it("Expand all expands every channel; Collapse all collapses every channel", () => {
    render(<LayerPanel {...collapseProps()} />);
    fireEvent.click(screen.getByLabelText("Expand all channels of original.zarr"));
    expect(screen.getByLabelText(dapiColormap)).toBeTruthy();
    expect(screen.getByLabelText(gfpColormap)).toBeTruthy();
    expect(screen.getByLabelText("Collapse channel DAPI")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Collapse all channels of original.zarr"));
    expect(screen.queryByLabelText(dapiColormap)).toBeNull();
    expect(screen.queryByLabelText(gfpColormap)).toBeNull();
    expect(screen.getByLabelText("Expand channel DAPI")).toBeTruthy();
  });

  it("never calls onChannelSetVisible when toggling collapse, and the eye still works", () => {
    const onChannelSetVisible = vi.fn();
    render(<LayerPanel {...collapseProps({}, { onChannelSetVisible })} />);
    fireEvent.click(screen.getByLabelText("Expand channel DAPI"));
    fireEvent.click(screen.getByLabelText("Collapse channel DAPI"));
    expect(onChannelSetVisible).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Hide original.zarr DAPI"));
    expect(onChannelSetVisible).toHaveBeenCalledWith("wds-1", 0, false);
  });

  it("uses the display-name precedence (override > omero > Ch N) for the toggle name", () => {
    render(<LayerPanel {...collapseProps({ channelInfos: undefined })} />);
    expect(screen.getByLabelText("Expand channel Ch 0")).toBeTruthy();
  });

  it("shows controls for an expanded channel even when it is hidden (gate is expanded, not visible)", () => {
    render(
      <LayerPanel
        {...collapseProps({
          channelSettings: [
            { visible: false, colormap: "gray", contrast_min: 0, contrast_max: 65535, gamma: 1 },
          ],
          channelInfos: [{ label: "DAPI" }],
        })}
      />,
    );
    fireEvent.click(screen.getByLabelText("Expand channel DAPI"));
    expect(screen.getByLabelText(dapiColormap)).toBeTruthy();
  });

  it("keeps the rename affordance working alongside collapse", () => {
    const onChannelSetName = vi.fn();
    render(<LayerPanel {...collapseProps({}, { onChannelSetName })} />);
    fireEvent.click(screen.getByLabelText("Rename channel DAPI"));
    const input = screen.getByLabelText("Channel name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Nucleus" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChannelSetName).toHaveBeenCalledWith("wds-1", 0, "Nucleus");
  });

  it("collapse/expand-all and per-channel state are per-layer (no cross-layer bleed, survive switching)", () => {
    const props = {
      ...baseProps(true, vi.fn()),
      multiChannel: true,
      expandedLayerId: "wds-1" as string | null,
      layers: [
        layer({ channelSettings, channelInfos: [{ label: "DAPI" }, { label: "GFP" }] }),
        layer({
          id: "wds-2",
          name: "second.zarr",
          channelSettings,
          channelInfos: [{ label: "RFP" }, { label: "Cy5" }],
        }),
      ],
    };
    const { rerender } = render(<LayerPanel {...props} />);
    // Expand all in layer 1.
    fireEvent.click(screen.getByLabelText("Expand all channels of original.zarr"));
    expect(screen.getByLabelText(dapiColormap)).toBeTruthy();

    // Switch to layer 2: its channels are still collapsed (default), unaffected.
    rerender(<LayerPanel {...{ ...props, expandedLayerId: "wds-2" }} />);
    expect(screen.getByLabelText("Expand channel RFP")).toBeTruthy();
    expect(screen.queryByLabelText("second.zarr RFP colormap")).toBeNull();

    // Back to layer 1: still expanded (state survived the switch).
    rerender(<LayerPanel {...{ ...props, expandedLayerId: "wds-1" }} />);
    expect(screen.getByLabelText(dapiColormap)).toBeTruthy();
  });
});

describe("LayerPanel labels", () => {
  const labelRows = [
    { index: 0, name: "mitochondria", visible: true, opacity: 0.5 },
    { index: 1, name: "cells", visible: false, opacity: 0.25 },
  ];

  function labelProps(
    overrides: Partial<LayerInfo> = {},
    extra: Record<string, unknown> = {},
  ) {
    return {
      ...baseProps(true, vi.fn()),
      // Expanded so the Labels subsection (inside the layer detail) renders.
      expandedLayerId: "wds-1" as string | null,
      layers: [
        layer({
          labelRows,
          ...overrides,
        }),
      ],
      ...extra,
    };
  }

  it("renders a Labels section with per-label eye + opacity controls", () => {
    render(<LayerPanel {...labelProps()} />);
    expect(screen.getByTestId("labels-section-wds-1")).toBeTruthy();
    expect(screen.getByText("mitochondria")).toBeTruthy();
    expect(screen.getByText("cells")).toBeTruthy();
    // Row 0 is visible → its eye offers "Hide"; row 1 is hidden → "Show".
    expect(screen.getByLabelText("Hide original.zarr mitochondria")).toBeTruthy();
    expect(screen.getByLabelText("Show original.zarr cells")).toBeTruthy();
    // Each row exposes an opacity slider (keyed by manifest index).
    expect(screen.getByTestId("label-opacity-wds-1-0")).toBeTruthy();
    expect(screen.getByTestId("label-opacity-wds-1-1")).toBeTruthy();
  });

  it("toggling a label eye fires onLabelSetVisible(id, index, !visible)", () => {
    const onLabelSetVisible = vi.fn();
    render(<LayerPanel {...labelProps({}, { onLabelSetVisible })} />);
    // Visible label → toggles OFF.
    fireEvent.click(screen.getByTestId("label-eye-wds-1-0"));
    expect(onLabelSetVisible).toHaveBeenCalledWith("wds-1", 0, false);
    // Hidden label → toggles ON.
    fireEvent.click(screen.getByTestId("label-eye-wds-1-1"));
    expect(onLabelSetVisible).toHaveBeenCalledWith("wds-1", 1, true);
  });

  it("uses the row's MANIFEST index (not row position) for the handler", () => {
    // Only label index 2 is drawable (0/1 were ineligible and omitted upstream).
    // The single rendered row must still target index 2.
    const onLabelSetVisible = vi.fn();
    const onLabelSetOpacity = vi.fn();
    render(
      <LayerPanel
        {...labelProps(
          { labelRows: [{ index: 2, name: "seg", visible: true, opacity: 0.5 }] },
          { onLabelSetVisible, onLabelSetOpacity },
        )}
      />,
    );
    fireEvent.click(screen.getByTestId("label-eye-wds-1-2"));
    expect(onLabelSetVisible).toHaveBeenCalledWith("wds-1", 2, false);
    fireEvent.change(screen.getByTestId("label-opacity-wds-1-2"), { target: { value: "10" } });
    expect(onLabelSetOpacity).toHaveBeenCalledWith("wds-1", 2, 0.1);
  });

  it("dragging a label opacity slider fires onLabelSetOpacity(id, index, value)", () => {
    const onLabelSetOpacity = vi.fn();
    render(<LayerPanel {...labelProps({}, { onLabelSetOpacity })} />);
    const slider = screen.getByTestId("label-opacity-wds-1-0") as HTMLInputElement;
    // Slider is 0..100; the handler receives the 0..1 fraction.
    fireEvent.change(slider, { target: { value: "20" } });
    expect(onLabelSetOpacity).toHaveBeenCalledWith("wds-1", 0, 0.2);
  });

  it("reflects the current per-label opacity on the slider", () => {
    render(<LayerPanel {...labelProps()} />);
    // opacity 0.5 → 50, opacity 0.25 → 25.
    expect((screen.getByTestId("label-opacity-wds-1-0") as HTMLInputElement).value).toBe("50");
    expect((screen.getByTestId("label-opacity-wds-1-1") as HTMLInputElement).value).toBe("25");
  });

  it("falls back to `Label N` when a label name is blank", () => {
    render(
      <LayerPanel
        {...labelProps({
          labelRows: [
            { index: 0, name: "mito", visible: true, opacity: 0.5 },
            { index: 1, name: "", visible: false, opacity: 0.5 },
          ],
        })}
      />,
    );
    expect(screen.getByText("mito")).toBeTruthy();
    expect(screen.getByText("Label 1")).toBeTruthy();
  });

  it("shows a discoverability count badge counting the drawable labels", () => {
    render(<LayerPanel {...labelProps()} />);
    const badge = screen.getByTestId("layer-label-count-wds-1");
    expect(badge.textContent).toContain("2");
    expect(badge.getAttribute("aria-label")).toBe("2 labels");
  });

  it("renders NO Labels section or badge when the dataset has no drawable labels", () => {
    render(<LayerPanel {...{ ...labelProps(), layers: [layer()] }} />);
    expect(screen.queryByTestId("labels-section-wds-1")).toBeNull();
    expect(screen.queryByTestId("layer-label-count-wds-1")).toBeNull();
  });
});
