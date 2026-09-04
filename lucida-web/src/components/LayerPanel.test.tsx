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
    levelPin: null,
    levelPinOptions: [],
    targetLevel: null,
    displayedLevel: null,
    displayedCoarserThanTarget: false,
    downsamplingMethod: null,
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
    onSetLevelPin: vi.fn(),
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
          channelInfos: [{ label: "Channel 0" }, { label: "Channel 1" }],
        })}
      />,
    );
    expect(screen.getByText("Channel 0")).toBeTruthy();
    expect(screen.getByText("Channel 1")).toBeTruthy();
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
          channelInfos: [{ label: "Channel 0" }],
        })}
      />,
    );
    expect(screen.getByText("Channel 0")).toBeTruthy();
    expect(screen.getByText("Ch 1")).toBeTruthy();
    expect(screen.queryByText("Ch 0")).toBeNull();
  });

  it("falls back when a label is an empty string", () => {
    render(
      <LayerPanel
        {...multiChannelProps({
          channelInfos: [{ label: "" }, { label: "Channel 1" }],
        })}
      />,
    );
    // Empty label -> positional fallback for channel 0.
    expect(screen.getByText("Ch 0")).toBeTruthy();
    expect(screen.getByText("Channel 1")).toBeTruthy();
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
            // ch0: user override beats the omero label "Channel 0".
            { visible: true, colormap: "gray", contrast_min: 0, contrast_max: 65535, gamma: 1, name: "Region A" },
            // ch1: no override → omero label "Channel 1".
            { visible: true, colormap: "green", contrast_min: 0, contrast_max: 65535, gamma: 1 },
            // ch2: no override, no omero entry → `Ch 2`.
            { visible: true, colormap: "cyan", contrast_min: 0, contrast_max: 65535, gamma: 1 },
          ],
          channelInfos: [{ label: "Channel 0" }, { label: "Channel 1" }],
        })}
      />,
    );
    // Tier 1: override wins, the omero label is NOT shown.
    expect(screen.getByText("Region A")).toBeTruthy();
    expect(screen.queryByText("Channel 0")).toBeNull();
    // Tier 2: omero label for the un-renamed channel.
    expect(screen.getByText("Channel 1")).toBeTruthy();
    // Tier 3: positional fallback when neither override nor omero exists.
    expect(screen.getByText("Ch 2")).toBeTruthy();
  });

  it("shows a channel rename affordance for an editor, hidden for a viewer", () => {
    const named = {
      channelSettings: [
        { visible: true, colormap: "gray", contrast_min: 0, contrast_max: 65535, gamma: 1 },
      ],
      channelInfos: [{ label: "Channel 0" }],
    } satisfies Partial<LayerInfo>;

    const { rerender } = render(<LayerPanel {...multiChannelProps(named)} />);
    expect(screen.getByLabelText("Rename channel Channel 0")).toBeTruthy();

    rerender(
      <LayerPanel {...multiChannelProps(named, { canEdit: false })} />,
    );
    expect(screen.queryByLabelText("Rename channel Channel 0")).toBeNull();
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
            channelInfos: [{ label: "Channel 0" }],
          },
          { onChannelSetName },
        )}
      />,
    );

    fireEvent.click(screen.getByLabelText("Rename channel Channel 0"));
    const input = screen.getByLabelText("Channel name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Region A  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChannelSetName).toHaveBeenCalledTimes(1);
    expect(onChannelSetName).toHaveBeenCalledWith("wds-1", 0, "Region A");
    // The inline input is gone after commit.
    expect(screen.queryByLabelText("Channel name")).toBeNull();
  });

  it("clears the override (null) when committed empty, falling back to omero", () => {
    const onChannelSetName = vi.fn();
    render(
      <LayerPanel
        {...multiChannelProps(
          {
            // Currently overridden to "Region A".
            channelSettings: [
              { visible: true, colormap: "gray", contrast_min: 0, contrast_max: 65535, gamma: 1, name: "Region A" },
            ],
            channelInfos: [{ label: "Channel 0" }],
          },
          { onChannelSetName },
        )}
      />,
    );

    // Override shows first.
    expect(screen.getByText("Region A")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Rename channel Region A"));
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
            channelInfos: [{ label: "Channel 0" }],
          },
          { onChannelSetName },
        )}
      />,
    );

    fireEvent.click(screen.getByLabelText("Rename channel Channel 0"));
    const input = screen.getByLabelText("Channel name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "discard me" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onChannelSetName).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Channel name")).toBeNull();
    // The original (omero) label is shown again.
    expect(screen.getByText("Channel 0")).toBeTruthy();
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
          channelInfos: [{ label: "Channel 0" }, { label: "Channel 1" }],
          ...overrides,
        }),
      ],
      ...extra,
    };
  }

  // The colormap selector is the per-channel "detail" the toggle discloses; its
  // aria-label carries the `${layer} ${chName}` prefix.
  const ch0Colormap = "original.zarr Channel 0 colormap";
  const ch1Colormap = "original.zarr Channel 1 colormap";

  it("defaults to COLLAPSED: channels show an Expand toggle but hide their controls", () => {
    render(<LayerPanel {...collapseProps()} />);
    expect(screen.getByLabelText("Expand channel Channel 0")).toBeTruthy();
    expect(screen.getByLabelText("Expand channel Channel 1")).toBeTruthy();
    expect(screen.queryByLabelText(ch0Colormap)).toBeNull();
    expect(screen.queryByLabelText(ch1Colormap)).toBeNull();
  });

  it("the toggle is a real disclosure button, aria-expanded=false by default", () => {
    render(<LayerPanel {...collapseProps()} />);
    const t = screen.getByLabelText("Expand channel Channel 0");
    expect(t.tagName).toBe("BUTTON");
    expect(t.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(t);
    expect(screen.getByLabelText("Collapse channel Channel 0").getAttribute("aria-expanded")).toBe("true");
  });

  it("expanding a channel shows its controls; collapsing hides them again", () => {
    render(<LayerPanel {...collapseProps()} />);
    fireEvent.click(screen.getByLabelText("Expand channel Channel 0"));
    expect(screen.getByLabelText(ch0Colormap)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Collapse channel Channel 0"));
    expect(screen.queryByLabelText(ch0Colormap)).toBeNull();
  });

  it("expanding one channel leaves the others collapsed (no cross-channel bleed)", () => {
    render(<LayerPanel {...collapseProps()} />);
    fireEvent.click(screen.getByLabelText("Expand channel Channel 0"));
    expect(screen.getByLabelText(ch0Colormap)).toBeTruthy();
    expect(screen.queryByLabelText(ch1Colormap)).toBeNull();
    expect(screen.getByLabelText("Expand channel Channel 1")).toBeTruthy();
  });

  it("Expand all expands every channel; Collapse all collapses every channel", () => {
    render(<LayerPanel {...collapseProps()} />);
    fireEvent.click(screen.getByLabelText("Expand all channels of original.zarr"));
    expect(screen.getByLabelText(ch0Colormap)).toBeTruthy();
    expect(screen.getByLabelText(ch1Colormap)).toBeTruthy();
    expect(screen.getByLabelText("Collapse channel Channel 0")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Collapse all channels of original.zarr"));
    expect(screen.queryByLabelText(ch0Colormap)).toBeNull();
    expect(screen.queryByLabelText(ch1Colormap)).toBeNull();
    expect(screen.getByLabelText("Expand channel Channel 0")).toBeTruthy();
  });

  it("never calls onChannelSetVisible when toggling collapse, and the eye still works", () => {
    const onChannelSetVisible = vi.fn();
    render(<LayerPanel {...collapseProps({}, { onChannelSetVisible })} />);
    fireEvent.click(screen.getByLabelText("Expand channel Channel 0"));
    fireEvent.click(screen.getByLabelText("Collapse channel Channel 0"));
    expect(onChannelSetVisible).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Hide original.zarr Channel 0"));
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
          channelInfos: [{ label: "Channel 0" }],
        })}
      />,
    );
    fireEvent.click(screen.getByLabelText("Expand channel Channel 0"));
    expect(screen.getByLabelText(ch0Colormap)).toBeTruthy();
  });

  it("keeps the rename affordance working alongside collapse", () => {
    const onChannelSetName = vi.fn();
    render(<LayerPanel {...collapseProps({}, { onChannelSetName })} />);
    fireEvent.click(screen.getByLabelText("Rename channel Channel 0"));
    const input = screen.getByLabelText("Channel name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Region A" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChannelSetName).toHaveBeenCalledWith("wds-1", 0, "Region A");
  });

  it("collapse/expand-all and per-channel state are per-layer (no cross-layer bleed, survive switching)", () => {
    const props = {
      ...baseProps(true, vi.fn()),
      multiChannel: true,
      expandedLayerId: "wds-1" as string | null,
      layers: [
        layer({ channelSettings, channelInfos: [{ label: "Channel 0" }, { label: "Channel 1" }] }),
        layer({
          id: "wds-2",
          name: "second.zarr",
          channelSettings,
          channelInfos: [{ label: "Channel 2" }, { label: "Channel 4" }],
        }),
      ],
    };
    const { rerender } = render(<LayerPanel {...props} />);
    // Expand all in layer 1.
    fireEvent.click(screen.getByLabelText("Expand all channels of original.zarr"));
    expect(screen.getByLabelText(ch0Colormap)).toBeTruthy();

    // Switch to layer 2: its channels are still collapsed (default), unaffected.
    rerender(<LayerPanel {...{ ...props, expandedLayerId: "wds-2" }} />);
    expect(screen.getByLabelText("Expand channel Channel 2")).toBeTruthy();
    expect(screen.queryByLabelText("second.zarr Channel 2 colormap")).toBeNull();

    // Back to layer 1: still expanded (state survived the switch).
    rerender(<LayerPanel {...{ ...props, expandedLayerId: "wds-1" }} />);
    expect(screen.getByLabelText(ch0Colormap)).toBeTruthy();
  });
});

describe("LayerPanel labels", () => {
  const labelRows = [
    { index: 0, name: "region-b", visible: true, opacity: 0.5 },
    { index: 1, name: "region-c", visible: false, opacity: 0.25 },
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
    expect(screen.getByText("region-b")).toBeTruthy();
    expect(screen.getByText("region-c")).toBeTruthy();
    // Row 0 is visible → its eye offers "Hide"; row 1 is hidden → "Show".
    expect(screen.getByLabelText("Hide original.zarr region-b")).toBeTruthy();
    expect(screen.getByLabelText("Show original.zarr region-c")).toBeTruthy();
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
            { index: 0, name: "region-b", visible: true, opacity: 0.5 },
            { index: 1, name: "", visible: false, opacity: 0.5 },
          ],
        })}
      />,
    );
    expect(screen.getByText("region-b")).toBeTruthy();
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

  it("disables the controls and shows the reason for a row with disabledReason", () => {
    const onLabelSetVisible = vi.fn();
    render(
      <LayerPanel
        {...labelProps(
          {
            labelRows: [
              { index: 0, name: "deep", visible: true, opacity: 0.5, disabledReason: "too large to render in 3D" },
            ],
          },
          { onLabelSetVisible },
        )}
      />,
    );
    const eye = screen.getByTestId("label-eye-wds-1-0") as HTMLButtonElement;
    const slider = screen.getByTestId("label-opacity-wds-1-0") as HTMLInputElement;
    // Both controls carry the disabled attribute (the browser-enforced gate).
    expect(eye.disabled).toBe(true);
    expect(slider.disabled).toBe(true);
    // Nothing is drawn in this mode, so the toggle reports not-pressed even
    // though the label's persisted visible flag is true.
    expect(eye.getAttribute("aria-pressed")).toBe("false");
    // The reason is visible text in the row.
    expect(screen.getByText("too large to render in 3D")).toBeTruthy();
    // A disabled button does not fire its click handler.
    fireEvent.click(eye);
    expect(onLabelSetVisible).not.toHaveBeenCalled();
  });

  it("leaves a row WITHOUT disabledReason fully interactive", () => {
    const onLabelSetVisible = vi.fn();
    render(
      <LayerPanel
        {...labelProps(
          { labelRows: [{ index: 0, name: "flat", visible: true, opacity: 0.5 }] },
          { onLabelSetVisible },
        )}
      />,
    );
    const eye = screen.getByTestId("label-eye-wds-1-0") as HTMLButtonElement;
    expect(eye.disabled).toBe(false);
    // Drawable and visible → the toggle reports pressed.
    expect(eye.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(eye);
    expect(onLabelSetVisible).toHaveBeenCalledWith("wds-1", 0, false);
  });
});

describe("LayerPanel level readout", () => {
  function levelProps(overrides: Partial<LayerInfo>) {
    return {
      ...baseProps(true, vi.fn()),
      // Expanded so the detail rows render.
      expandedLayerId: "wds-1" as string | null,
      layers: [layer(overrides)],
    };
  }

  it("shows the target level, and no notice, once the target is what is displayed", () => {
    render(<LayerPanel {...levelProps({
      targetLevel: { min: 2, max: 2 },
      displayedLevel: { min: 2, max: 2 },
    })} />);
    expect(screen.getByLabelText("original.zarr target level").textContent).toBe("2");
    expect(screen.queryByLabelText("original.zarr displayed level")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows both levels, and a notice naming them, while a coarser level is displayed", () => {
    render(<LayerPanel {...levelProps({
      targetLevel: { min: 1, max: 1 },
      displayedLevel: { min: 3, max: 3 },
      displayedCoarserThanTarget: true,
    })} />);
    expect(screen.getByLabelText("original.zarr target level").textContent).toBe("1");
    expect(screen.getByLabelText("original.zarr displayed level").textContent).toBe("displaying 3");
    expect(screen.getByRole("status").textContent).toBe(
      "Displaying level 3 where level 1 is the target.",
    );
  });

  it("shows ranges for a collection whose tiles differ", () => {
    render(<LayerPanel {...levelProps({
      targetLevel: { min: 1, max: 3 },
      displayedLevel: { min: 1, max: 4 },
      displayedCoarserThanTarget: true,
    })} />);
    expect(screen.getByLabelText("original.zarr target level").textContent).toBe("1-3");
    expect(screen.getByRole("status").textContent).toBe(
      "Displaying levels 1-4 where levels 1-3 are the target.",
    );
  });

  it("shows no level row before the worker has reported one", () => {
    render(<LayerPanel {...levelProps({})} />);
    expect(screen.queryByLabelText("original.zarr target level")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the downsampling method only when the metadata declares one", () => {
    const { unmount } = render(<LayerPanel {...levelProps({ downsamplingMethod: "gaussian" })} />);
    expect(screen.getByLabelText("original.zarr downsampling method").textContent).toBe("gaussian");
    unmount();

    render(<LayerPanel {...levelProps({ downsamplingMethod: null })} />);
    expect(screen.queryByLabelText("original.zarr downsampling method")).toBeNull();
  });
});

describe("LayerPanel level pin", () => {
  const levelPinOptions = [
    { level: 0, label: "Level 0 (4096 x 4096)" },
    { level: 1, label: "Level 1 (2048 x 2048)" },
    { level: 2, label: "Level 2 (1024 x 1024)" },
  ];

  function pinProps(levelPin: number | null, onSetLevelPin = vi.fn()) {
    return {
      ...baseProps(true, vi.fn()),
      expandedLayerId: "wds-1",
      layers: [layer({ levelPin, levelPinOptions })],
      onSetLevelPin,
    };
  }

  function pinSelect(): HTMLSelectElement {
    return screen.getByLabelText("original.zarr level pin") as HTMLSelectElement;
  }

  it("offers follow-the-screen first, then every pinnable level, level 0 included", () => {
    render(<LayerPanel {...pinProps(null)} />);
    const options = [...pinSelect().options].map((o) => [o.value, o.textContent]);
    expect(options).toEqual([
      ["", "Follow the screen"],
      ["0", "Level 0 (4096 x 4096)"],
      ["1", "Level 1 (2048 x 2048)"],
      ["2", "Level 2 (1024 x 1024)"],
    ]);
    expect(pinSelect().value).toBe("");
  });

  it("shows the current pin, level 0 included", () => {
    render(<LayerPanel {...pinProps(0)} />);
    expect(pinSelect().value).toBe("0");
  });

  it("pins to level 0 as the number 0, and clears the pin as null", () => {
    const onSetLevelPin = vi.fn();
    render(<LayerPanel {...pinProps(2, onSetLevelPin)} />);

    fireEvent.change(pinSelect(), { target: { value: "0" } });
    expect(onSetLevelPin).toHaveBeenLastCalledWith("wds-1", 0);

    fireEvent.change(pinSelect(), { target: { value: "" } });
    expect(onSetLevelPin).toHaveBeenLastCalledWith("wds-1", null);
  });

  it("hides the control when the dataset reports no pinnable level", () => {
    const props = { ...pinProps(null), layers: [layer({ levelPinOptions: [] })] };
    render(<LayerPanel {...props} />);
    expect(screen.queryByLabelText("original.zarr level pin")).toBeNull();
  });
});
