// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { workspacePreviewUrl } from "./api.ts";
import { WorkspacePreview } from "./WorkspacePreview.tsx";

afterEach(() => cleanup());

describe("WorkspacePreview", () => {
  it("keeps the placeholder when the workspace has no preview", () => {
    const { container } = render(<WorkspacePreview workspaceId="ws-1" updatedAt={null} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".lc-ws-preview-placeholder")).not.toBeNull();
  });

  it("loads the preview lazily and shows it once it has loaded", () => {
    const { container } = render(<WorkspacePreview workspaceId="ws 1" updatedAt="2026-01-02T03:04:05Z" />);
    const area = container.querySelector(".lc-ws-preview") as HTMLElement;
    const image = container.querySelector("img") as HTMLImageElement;
    expect(image.getAttribute("src")).toBe("/api/workspaces/ws%201/preview?v=2026-01-02T03%3A04%3A05Z");
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(area.dataset.shown).toBeUndefined();

    fireEvent.load(image);
    expect(area.dataset.shown).toBe("true");
  });

  it("falls back to the placeholder when the image fails", () => {
    const { container } = render(<WorkspacePreview workspaceId="ws-1" updatedAt="2026-01-02T03:04:05Z" />);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".lc-ws-preview")?.hasAttribute("data-shown")).toBe(false);
  });

  it("asks for a new image when the preview changes", () => {
    const { container, rerender } = render(<WorkspacePreview workspaceId="ws-1" updatedAt="2026-01-02T03:04:05Z" />);
    fireEvent.load(container.querySelector("img") as HTMLImageElement);
    rerender(<WorkspacePreview workspaceId="ws-1" updatedAt="2026-01-02T04:00:00Z" />);
    const area = container.querySelector(".lc-ws-preview") as HTMLElement;
    expect(container.querySelector("img")?.getAttribute("src")).toContain("04%3A00%3A00Z");
    expect(area.dataset.shown, "the placeholder holds until the new image loads").toBeUndefined();
  });
});

describe("workspacePreviewUrl", () => {
  it("adds the version only when there is one", () => {
    expect(workspacePreviewUrl("a/b")).toBe("/api/workspaces/a%2Fb/preview");
    expect(workspacePreviewUrl("a", "v1")).toBe("/api/workspaces/a/preview?v=v1");
  });
});
