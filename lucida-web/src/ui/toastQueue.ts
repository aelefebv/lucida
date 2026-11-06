import { UNSTABLE_ToastQueue as ToastQueue } from "react-aria-components";

export type ToastTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface ToastOptions {
  title: string;
  description?: string;
  /** Default `neutral`. */
  tone?: ToastTone;
  /** One button; pressing it also closes the toast. */
  action?: { label: string; onPress: () => void };
  /**
   * Milliseconds before it closes itself, at least 5000; `null` keeps it
   * until closed. Default 5000, or `null` when there is an action, so nobody
   * loses an action they had no time to reach.
   */
  timeout?: number | null;
}

export interface ToastContent {
  title: string;
  description?: string;
  tone: ToastTone;
  action?: { label: string; onPress: () => void };
}

const MIN_TIMEOUT_MS = 5000;

/** The one queue the app's single `<ToastRegion />` renders. */
export const toastQueue = new ToastQueue<ToastContent>({ maxVisibleToasts: 3 });

/**
 * Show a toast and return its id. Works anywhere, in or out of React.
 *
 *     toast("Link copied");
 *     toast({ title: "Could not save", description: message, tone: "danger" });
 */
export function toast(options: string | ToastOptions): string {
  const { title, description, tone = "neutral", action, timeout } =
    typeof options === "string" ? { title: options } : options;
  const ms = timeout === undefined ? (action ? null : MIN_TIMEOUT_MS) : timeout;
  return toastQueue.add(
    { title, description, tone, action },
    ms === null ? {} : { timeout: Math.max(MIN_TIMEOUT_MS, ms) },
  );
}

export function dismissToast(id: string): void {
  toastQueue.close(id);
}
