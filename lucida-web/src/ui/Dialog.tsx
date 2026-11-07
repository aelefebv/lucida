import { XIcon } from "@phosphor-icons/react";
import type { ReactElement, ReactNode } from "react";
import {
  Dialog as AriaDialog,
  DialogTrigger,
  Heading,
  Modal,
  ModalOverlay,
} from "react-aria-components";
import { IconButton } from "./Button.tsx";
import "./Dialog.css";

type Content = ReactNode | ((close: () => void) => ReactNode);

export interface DialogProps {
  title: string;
  /** Body content, or a function of `close`. */
  children: Content;
  /** Actions at the bottom right, primary last. */
  footer?: Content;
  /**
   * The Button that opens it. Omit and pass `isOpen` to open it from code,
   * e.g. from a shortcut; focus then returns to whatever had it before.
   */
  trigger?: ReactElement;
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  /** Width: 360, 480, or 640px. Default `md`. */
  size?: "sm" | "md" | "lg";
  /** Whether a click outside closes it. Default true. */
  isDismissable?: boolean;
}

function render(content: Content, close: () => void): ReactNode {
  return typeof content === "function" ? content(close) : content;
}

/**
 * A modal dialog: traps focus, closes on Escape, the close button, or (by
 * default) a click outside, and returns focus to its trigger.
 */
export function Dialog({
  title,
  children,
  footer,
  trigger,
  isOpen,
  onOpenChange,
  size = "md",
  isDismissable = true,
}: DialogProps) {
  const overlayState = trigger ? {} : { isOpen, onOpenChange };
  const modal = (
    <ModalOverlay className="lc-dialog-overlay" isDismissable={isDismissable} {...overlayState}>
      <Modal className="lc-dialog" data-size={size} data-lc-overlay="">
        <AriaDialog className="lc-dialog-inner">
          {({ close }) => (
            <>
              <header className="lc-dialog-header">
                <Heading slot="title" className="lc-dialog-title">
                  {title}
                </Heading>
                <IconButton icon={XIcon} label="Close" shortcut="Escape" size="sm" onPress={close} />
              </header>
              <div className="lc-dialog-body">{render(children, close)}</div>
              {footer !== undefined && (
                <footer className="lc-dialog-footer">{render(footer, close)}</footer>
              )}
            </>
          )}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
  if (!trigger) return modal;
  return (
    <DialogTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
      {trigger}
      {modal}
    </DialogTrigger>
  );
}
