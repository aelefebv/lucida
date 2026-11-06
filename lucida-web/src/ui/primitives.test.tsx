// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GearSixIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button, IconButton } from "./Button.tsx";
import { Dialog } from "./Dialog.tsx";
import { Popover } from "./Popover.tsx";
import { __resetShortcutsForTesting, useShortcut } from "./shortcuts.ts";
import { Slider } from "./Slider.tsx";
import { ToastRegion } from "./Toast.tsx";
import { dismissToast, toast, toastQueue } from "./toastQueue.ts";

afterEach(() => {
  cleanup();
  __resetShortcutsForTesting();
  toastQueue.clear();
});

function DialogHarness({ onShortcut }: { onShortcut?: () => void }) {
  useShortcut({ id: "test.mode", keys: "M", label: "Mode", group: "View", onTrigger: () => onShortcut?.() });
  return (
    <Dialog
      title="Add data"
      trigger={<Button>Open</Button>}
      footer={(close) => (
        <Button variant="primary" onPress={close}>
          Done
        </Button>
      )}
    >
      <Button>First</Button>
    </Dialog>
  );
}

describe("Dialog", () => {
  it("closes on Escape and returns focus to its trigger", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", { name: "Add data" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open" }));
  });

  it("keeps Tab inside the dialog", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog");
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes from the close button and from a footer action", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("holds back app shortcuts while open", async () => {
    const user = userEvent.setup();
    const onShortcut = vi.fn();
    render(<DialogHarness onShortcut={onShortcut} />);
    await user.keyboard("m");
    expect(onShortcut).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("dialog");
    await user.keyboard("m");
    expect(onShortcut).toHaveBeenCalledTimes(1);
  });

  it("opens from code, without a trigger", async () => {
    function Controlled() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onPress={() => setOpen(true)}>Elsewhere</Button>
          <Dialog title="From code" isOpen={open} onOpenChange={setOpen}>
            Body
          </Dialog>
        </>
      );
    }
    const user = userEvent.setup();
    render(<Controlled />);
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(await screen.findByRole("dialog", { name: "From code" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("Popover", () => {
  it("closes on Escape and returns focus to its trigger", async () => {
    const user = userEvent.setup();
    render(
      <Popover label="Display settings" trigger={<Button>Display</Button>}>
        <Button>Inside</Button>
      </Popover>,
    );
    await user.click(screen.getByRole("button", { name: "Display" }));
    expect(await screen.findByRole("dialog", { name: "Display settings" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Display" }));
  });
});

describe("IconButton", () => {
  it("is named by its label and announces its shortcut", () => {
    render(<IconButton icon={GearSixIcon} label="Settings" shortcut="Mod+," />);
    const button = screen.getByRole("button", { name: "Settings" });
    expect(button.getAttribute("aria-keyshortcuts")).toMatch(/^(Control|Meta)\+,$/);
  });

  it("is a toggle when given isSelected", async () => {
    const user = userEvent.setup();
    const onSelectedChange = vi.fn();
    render(<IconButton icon={GearSixIcon} label="Panel" isSelected={false} onSelectedChange={onSelectedChange} />);
    const button = screen.getByRole("button", { name: "Panel" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await user.click(button);
    expect(onSelectedChange).toHaveBeenCalledWith(true);
  });
});

describe("Slider", () => {
  it("keeps a range ordered when a value is typed", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Slider label="Contrast" value={[100, 200] as const} onChange={onChange} minValue={0} maxValue={1000} valueDisplay="field" />,
    );
    const low = screen.getByRole("textbox", { name: "Contrast minimum" });
    await user.clear(low);
    await user.type(low, "500{Enter}");
    expect(onChange).toHaveBeenLastCalledWith([200, 200]);
  });
});

describe("toast", () => {
  it("shows in the region and can be dismissed", async () => {
    render(<ToastRegion />);
    let id = "";
    act(() => {
      id = toast({ title: "Link copied", description: "Anyone with access can open it.", tone: "success" });
    });
    expect(await screen.findByText("Link copied")).toBeTruthy();
    expect(screen.getByText("Anyone with access can open it.")).toBeTruthy();
    act(() => dismissToast(id));
    await waitFor(() => expect(screen.queryByText("Link copied")).toBeNull());
  });

  it("keeps a toast with an action until it is used", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(<ToastRegion />);
    act(() => {
      toast({ title: "Couldn't share", tone: "danger", action: { label: "Retry", onPress } });
    });
    expect(toastQueue.visibleToasts[0].timeout).toBeUndefined();
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(onPress).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("Couldn't share")).toBeNull());
  });
});
