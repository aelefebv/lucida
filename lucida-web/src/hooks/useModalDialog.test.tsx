// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useModalDialog } from "./useModalDialog.ts";

afterEach(() => cleanup());

function Harness() {
  const [open, setOpen] = useState(false);
  const { dialogRef, onKeyDown } = useModalDialog({ open, onClose: () => setOpen(false) });
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
      {open && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Test dialog"
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          <button type="button">First</button>
          <button type="button" style={{ display: "none" }}>CSS hidden</button>
          <span style={{ display: "none" }}>
            <button type="button">Hidden by ancestor</button>
          </span>
          <button type="button">Last</button>
        </div>
      )}
      <button type="button">Outside target</button>
    </>
  );
}

function PreferredHarness({
  preferred,
  focusRootOnMount = false,
  revealPreferredAfterFrame = false,
  hideFallbackUntilFrame = false,
  revealPreferredAfterDelayMs = null,
  disableFallbackFocus = false,
  redirectFallbackFocus = false,
  autoFocusPreferred = false,
  explicitReturnTarget = false,
}: {
  preferred: "visible" | "hidden" | "disabled" | "missing";
  focusRootOnMount?: boolean;
  revealPreferredAfterFrame?: boolean;
  hideFallbackUntilFrame?: boolean;
  revealPreferredAfterDelayMs?: number | null;
  disableFallbackFocus?: boolean;
  redirectFallbackFocus?: boolean;
  autoFocusPreferred?: boolean;
  explicitReturnTarget?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const invokerRef = useRef<HTMLButtonElement>(null);
  const fallbackRef = useRef<HTMLButtonElement>(null);
  const redirectTargetRef = useRef<HTMLButtonElement>(null);
  const preferredRef = useRef<HTMLButtonElement>(null);
  const { dialogRef, onKeyDown } = useModalDialog({
    open,
    onClose: () => setOpen(false),
    initialFocusRef: preferredRef,
    returnFocusRef: explicitReturnTarget ? invokerRef : undefined,
  });
  useEffect(() => {
    if (!open || revealPreferredAfterDelayMs === null) return;
    const timeout = window.setTimeout(() => {
      preferredRef.current?.style.removeProperty("display");
    }, revealPreferredAfterDelayMs);
    return () => window.clearTimeout(timeout);
  }, [open, revealPreferredAfterDelayMs]);
  useEffect(() => {
    if (!open || (!revealPreferredAfterFrame && !hideFallbackUntilFrame)) return;
    const frame = requestAnimationFrame(() => {
      if (revealPreferredAfterFrame) preferredRef.current?.style.removeProperty("display");
      if (hideFallbackUntilFrame) fallbackRef.current?.style.removeProperty("display");
    });
    return () => cancelAnimationFrame(frame);
  }, [hideFallbackUntilFrame, open, revealPreferredAfterFrame]);
  return (
    <>
      <button ref={invokerRef} type="button" onClick={() => setOpen(true)}>Open preferred dialog</button>
      {open && (
        <div
          ref={(element) => {
            dialogRef.current = element;
            if (element && focusRootOnMount) element.focus();
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Preferred dialog"
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          <button
            ref={(element) => {
              fallbackRef.current = element;
              if (element && disableFallbackFocus) element.focus = () => undefined;
              if (element && redirectFallbackFocus) {
                element.focus = () => redirectTargetRef.current?.focus();
              }
            }}
            type="button"
            style={hideFallbackUntilFrame ? { display: "none" } : undefined}
          >
            Fallback
          </button>
          {redirectFallbackFocus && (
            <button ref={redirectTargetRef} type="button">Redirect target</button>
          )}
          {preferred !== "missing" && (
            <button
              ref={preferredRef}
              // Deliberately exercises the browser commit ordering that the
              // hook must tolerate; production use is limited to true modals.
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus={autoFocusPreferred}
              type="button"
              disabled={preferred === "disabled"}
              style={preferred === "hidden" || revealPreferredAfterFrame
                || revealPreferredAfterDelayMs !== null
                ? { display: "none" }
                : undefined}
            >
              Preferred
            </button>
          )}
        </div>
      )}
    </>
  );
}

describe("useModalDialog", () => {
  it("moves focus into the dialog and restores the invoker on Escape", async () => {
    render(<Harness />);
    const invoker = screen.getByRole("button", { name: "Open dialog" });
    invoker.focus();
    fireEvent.click(invoker);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => Promise.resolve());
    expect(document.activeElement).toBe(invoker);
  });

  it("keeps valid in-dialog focus and recaptures focus stolen outside", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });

    last.focus();
    await act(async () => Promise.resolve());
    expect(document.activeElement).toBe(last);

    screen.getByRole("button", { name: "Outside target" }).focus();
    expect(document.activeElement).toBe(first);
  });

  it("uses a visible preferred target", () => {
    render(<PreferredHarness preferred="visible" />);
    fireEvent.click(screen.getByRole("button", { name: "Open preferred dialog" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Preferred" }));
  });

  it("moves from a transiently-focused dialog root to the preferred target", () => {
    render(<PreferredHarness preferred="visible" focusRootOnMount />);
    fireEvent.click(screen.getByRole("button", { name: "Open preferred dialog" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Preferred" }));
  });

  it("moves from provisional root focus to a fallback when the preference cannot focus", () => {
    render(<PreferredHarness preferred="disabled" focusRootOnMount />);
    fireEvent.click(screen.getByRole("button", { name: "Open preferred dialog" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Fallback" }));
  });

  it("preserves meaningful focus redirected by a fallback focus handler", () => {
    render(
      <PreferredHarness
        preferred="missing"
        focusRootOnMount
        redirectFallbackFocus
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open preferred dialog" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Redirect target" }));
  });

  it("restores an explicit invoker when autoFocus runs before the opening effect", () => {
    render(
      <PreferredHarness
        preferred="visible"
        autoFocusPreferred
        explicitReturnTarget
      />,
    );
    const invoker = screen.getByRole("button", { name: "Open preferred dialog" });
    fireEvent.click(invoker);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Preferred" }));

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(document.activeElement).toBe(invoker);
  });

  it("does not steal meaningful descendant focus when responsive CSS reveals a preference", async () => {
    render(<PreferredHarness preferred="visible" revealPreferredAfterFrame />);
    fireEvent.click(screen.getByRole("button", { name: "Open preferred dialog" }));
    const fallback = screen.getByRole("button", { name: "Fallback" });
    expect(document.activeElement).toBe(fallback);

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    expect(document.activeElement).toBe(fallback);
  });

  it("promotes provisional root focus after responsive CSS reveals the preferred control", async () => {
    render(
      <PreferredHarness
        preferred="visible"
        focusRootOnMount
        revealPreferredAfterFrame
        hideFallbackUntilFrame
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open preferred dialog" }));
    expect(document.activeElement).toBe(screen.getByRole("dialog"));

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Preferred" }));
  });

  it("keeps acquiring focus after early preferred and fallback attempts fail", async () => {
    render(
      <PreferredHarness
        preferred="visible"
        focusRootOnMount
        revealPreferredAfterDelayMs={300}
        disableFallbackFocus
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open preferred dialog" }));
    expect(document.activeElement).toBe(screen.getByRole("dialog"));

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 400));
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Preferred" }));
  });

  it("falls back when the preferred target is hidden, disabled, or absent", () => {
    render(<PreferredHarness preferred="hidden" />);
    fireEvent.click(screen.getByRole("button", { name: "Open preferred dialog" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Fallback" }));

    cleanup();
    render(<PreferredHarness preferred="disabled" />);
    fireEvent.click(screen.getByRole("button", { name: "Open preferred dialog" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Fallback" }));

    cleanup();
    render(<PreferredHarness preferred="missing" />);
    fireEvent.click(screen.getByRole("button", { name: "Open preferred dialog" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Fallback" }));
  });

  it("wraps Tab navigation at both ends", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("ignores CSS-hidden descendants when choosing the trap boundaries", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });
});
