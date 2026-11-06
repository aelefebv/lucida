import {
  CheckCircleIcon,
  InfoIcon,
  WarningCircleIcon,
  WarningIcon,
  XIcon,
  type Icon,
} from "@phosphor-icons/react";
import {
  Button as AriaButton,
  Text,
  UNSTABLE_Toast as AriaToast,
  UNSTABLE_ToastContent as AriaToastContent,
  UNSTABLE_ToastRegion as AriaToastRegion,
} from "react-aria-components";
import { Button } from "./Button.tsx";
import { toastQueue, type ToastTone } from "./toastQueue.ts";
import "./Toast.css";

const TONE_ICONS: Readonly<Record<ToastTone, Icon | null>> = {
  neutral: null,
  success: CheckCircleIcon,
  warning: WarningIcon,
  danger: WarningCircleIcon,
  info: InfoIcon,
};

/**
 * Where `toast()` draws. Mounted once, at the app root; F6 moves focus into
 * it from anywhere.
 */
export function ToastRegion() {
  return (
    <AriaToastRegion queue={toastQueue} className="lc-toast-region" data-lc-overlay="">
      {({ toast }) => {
        const { title, description, tone, action } = toast.content;
        const ToneIcon = TONE_ICONS[tone];
        return (
          <AriaToast toast={toast} className="lc-toast" data-tone={tone}>
            {ToneIcon && <ToneIcon className="lc-toast-icon" size={18} weight="fill" aria-hidden />}
            <AriaToastContent className="lc-toast-content">
              <Text slot="title" className="lc-toast-title">
                {title}
              </Text>
              {description && (
                <Text slot="description" className="lc-toast-description">
                  {description}
                </Text>
              )}
            </AriaToastContent>
            {action && (
              <Button
                size="sm"
                onPress={() => {
                  action.onPress();
                  toastQueue.close(toast.key);
                }}
              >
                {action.label}
              </Button>
            )}
            <AriaButton
              slot="close"
              className="lc-button lc-icon-button"
              data-variant="ghost"
              data-size="sm"
              aria-label="Dismiss"
            >
              <XIcon size={14} aria-hidden />
            </AriaButton>
          </AriaToast>
        );
      }}
    </AriaToastRegion>
  );
}
