import { useCallback, useLayoutEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface ModalDialogOptions {
  open: boolean;
  onClose: () => void;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

function isCssVisible(element: HTMLElement): boolean {
  if (element.closest("[hidden], [aria-hidden='true'], [inert]")) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (current === document.body) break;
  }
  return true;
}

function isActuallyVisible(element: HTMLElement): boolean {
  if (!isCssVisible(element)) return false;
  // Real browsers expose layout boxes; happy-dom does not, so only use this
  // stronger test when the document itself has a layout engine.
  if (document.documentElement.getClientRects().length > 0
      && element.getClientRects().length === 0) return false;
  return true;
}

function focusableElements(dialog: HTMLElement, requireLayout = true): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(requireLayout ? isActuallyVisible : isCssVisible);
}

function focusInsideDialog(
  dialog: HTMLElement,
  preferred: HTMLElement | null | undefined,
): void {
  const active = document.activeElement;
  // A real control inside the dialog is meaningful focus and may already
  // reflect user intent. The dialog root, however, is only a temporary safety
  // target used while responsive CSS has not exposed any controls yet; later
  // opening retries must be allowed to promote it to the requested control.
  if (active && active !== dialog && dialog.contains(active)) return;
  const preferredInside = preferred
    && dialog.contains(preferred)
    && isCssVisible(preferred)
    ? preferred
    : null;
  // Honor an explicit initial target even if the browser temporarily focused
  // the newly focusable dialog root during the opening commit. A generic
  // "already inside" return before this branch strands focus on that root and
  // skips the intended first action (the mobile Layers Close button).
  if (preferredInside && active !== preferredInside) {
    preferredInside.focus({ preventScroll: true });
    const focused = document.activeElement;
    if (focused && focused !== dialog && dialog.contains(focused)) return;
  }

  const first = focusableElements(dialog, false)[0];
  if (first) {
    first.focus({ preventScroll: true });
    const focused = document.activeElement;
    if (focused && focused !== dialog && dialog.contains(focused)) return;
  }
  dialog.focus({ preventScroll: true });
}

/**
 * Shared keyboard/focus contract for every modal surface.
 *
 * The hook deliberately owns only modal behavior, not presentation: focus enters
 * the dialog when it opens, Tab cannot escape, Escape closes it, and focus is
 * restored to the invoking control. Keeping this in one place prevents each
 * feature dialog from growing a subtly different accessibility implementation.
 */
export function useModalDialog({
  open,
  onClose,
  initialFocusRef,
  returnFocusRef,
}: ModalDialogOptions) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    // React's `autoFocus` runs during the same opening commit, before layout
    // effects. When a dialog needs that browser-native assist (for example a
    // responsive drawer whose close control is revealed by CSS), the active
    // element may already be inside the dialog by the time this effect runs.
    // An explicit invoker is therefore authoritative when one is available;
    // ordinary dialogs continue to restore the element that was active before
    // opening.
    previousFocusRef.current = returnFocusRef?.current
      ?? (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);

    let disposed = false;
    const claimFocus = () => {
      if (disposed) return;
      const dialog = dialogRef.current;
      if (dialog) focusInsideDialog(dialog, initialFocusRef?.current);
    };
    const containFocus = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      // A meaningful descendant may reflect user intent and must retain focus.
      // The dialog root is only a provisional fallback, however, so a late
      // browser focus transfer back to the root must re-run initial placement.
      // Keeping this rule aligned with focusInsideDialog prevents responsive
      // drawers from becoming stranded on a non-interactive container after
      // their opening retry has already observed the preferred control.
      if (event.target instanceof Node && dialog.contains(event.target)) {
        if (event.target === dialog) {
          // Chrome can complete the original root focus operation after a
          // synchronous nested focus() call, overwriting that nested result.
          // Retry after the focus event has unwound so the preferred control
          // becomes the final active element.
          queueMicrotask(claimFocus);
        }
        return;
      }
      claimFocus();
    };

    // Claim focus during the opening commit, then keep verifying the outcome
    // while responsive CSS, inert removal, and child refs settle. Linux Chrome
    // can reject every early focus attempt or transiently accept one before a
    // pending root-focus operation wins. The bounded loop is opening-only;
    // focusInsideDialog preserves any meaningful descendant, so verification
    // never steals from a user who already advanced within the dialog.
    document.addEventListener("focusin", containFocus, true);
    claimFocus();
    queueMicrotask(claimFocus);
    const focusDeadline = performance.now() + 1_500;
    let focusFrame: number | null = null;
    const verifyOpeningFocus = () => {
      claimFocus();
      if (performance.now() < focusDeadline) {
        focusFrame = requestAnimationFrame(verifyOpeningFocus);
      }
    };
    focusFrame = requestAnimationFrame(verifyOpeningFocus);

    return () => {
      // Stop containment before restoring the invoker, otherwise the focusin
      // generated by restoration would be pulled back into the closing dialog.
      disposed = true;
      if (focusFrame !== null) cancelAnimationFrame(focusFrame);
      document.removeEventListener("focusin", containFocus, true);
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [initialFocusRef, open, returnFocusRef]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }, [onClose]);

  return { dialogRef, onKeyDown };
}
