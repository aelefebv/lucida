import { RESTORE_AFTER_MS } from "../renderResolution.ts";

/** The volume view's render scale while a gesture moves its camera. */
export const INTERACTION_RENDER_SCALE = 0.5;
export const FULL_RENDER_SCALE = 1.0;
/** After a press ends, the gesture is over. */
export const SCALE_RESTORE_DELAY_MS = 50;
/**
 * A wheel or a touch gesture sends nothing when it ends, so its scale holds
 * until input has been quiet as long as the adaptive resolution waits before
 * it counts a gesture over. A slow wheel's notches are then one gesture, not
 * a full-resolution frame between each.
 */
export const GESTURE_RESTORE_DELAY_MS = RESTORE_AFTER_MS;
