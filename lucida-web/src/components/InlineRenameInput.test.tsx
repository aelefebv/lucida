// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InlineRenameInput } from "./InlineRenameInput.tsx";

afterEach(cleanup);

function renderInput(overrides: Partial<React.ComponentProps<typeof InlineRenameInput>> = {}) {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  render(
    <InlineRenameInput
      initialValue="Original"
      aria-label="Rename item"
      onCommit={onCommit}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return {
    input: screen.getByRole("textbox", { name: "Rename item" }) as HTMLInputElement,
    onCommit,
    onCancel,
  };
}

describe("InlineRenameInput", () => {
  it("focuses and selects the full seed value on mount", () => {
    const { input } = renderInput();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Original".length);
  });

  it("commits the edited value on Enter exactly once even if blur follows", () => {
    const { input, onCommit, onCancel } = renderInput();
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Renamed");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("commits on blur", () => {
    const { input, onCommit } = renderInput();
    fireEvent.change(input, { target: { value: "Blurred" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("Blurred");
  });

  it("cancels on Escape without committing during the resulting blur", () => {
    const { input, onCommit, onCancel } = renderInput();
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("keeps row click handlers from firing while the field is edited", () => {
    const onRowClick = vi.fn();
    const onInputClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <InlineRenameInput
          initialValue="Original"
          aria-label="Rename item"
          className="rename-field"
          placeholder="Inherited name"
          onClick={onInputClick}
          onCommit={vi.fn()}
          onCancel={vi.fn()}
        />
      </div>,
    );
    const input = screen.getByRole("textbox", { name: "Rename item" });
    fireEvent.click(input);

    expect(onInputClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
    expect(input.classList.contains("rename-field")).toBe(true);
    expect(input.getAttribute("placeholder")).toBe("Inherited name");
  });
});
