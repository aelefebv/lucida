import { ChatCircleTextIcon, CopyIcon, MapPinIcon, TrashIcon } from "@phosphor-icons/react";
import { ContextMenu, MenuItem, MenuSeparator } from "../ui/Menu.tsx";
import { toast } from "../ui/toastQueue.ts";
import type { Annotation } from "./annotationDocument.ts";
import { annotationNoun, formatCoordinates, type AnnotationPlacement } from "./useAnnotationEditing.ts";

/** Where the canvas menu opened. */
export interface CanvasMenuRequest {
  /** Client point of the right-click or long press. */
  x: number;
  y: number;
  /** The layer under it and the point of its frame there, or null where
   * there is none (a 3D press that misses every volume). */
  target: AnnotationPlacement | null;
}

function copyCoordinates(target: AnnotationPlacement): void {
  const text = formatCoordinates(target);
  navigator.clipboard.writeText(text).then(
    () => toast({ title: "Coordinates copied", description: text, tone: "success" }),
    () => toast({ title: "Couldn't copy the coordinates", description: text, tone: "danger" }),
  );
}

/**
 * The canvas's context menu, from a right-click or a long press: comment
 * here, drop a point, copy coordinates, and delete the annotation under the
 * press when it is one's own.
 */
export function AnnotationContextMenu({
  request,
  onClose,
  annotationsVisible,
  selected,
  onComment,
  onDropPoint,
  onDelete,
}: {
  request: CanvasMenuRequest | null;
  onClose: () => void;
  /** Hidden annotations offer only the coordinates, since a new one wouldn't show. */
  annotationsVisible: boolean;
  /** One's own annotation under the press, which the menu can delete. */
  selected: Annotation | null;
  onComment: (target: AnnotationPlacement) => void;
  onDropPoint: (target: AnnotationPlacement) => void;
  /** Delete `selected`. */
  onDelete: () => void;
}) {
  const target = request?.target ?? null;
  return (
    <ContextMenu at={request && { x: request.x, y: request.y }} onClose={onClose} label="Canvas actions">
      {annotationsVisible && (
        <MenuItem icon={ChatCircleTextIcon} isDisabled={!target} onAction={() => target && onComment(target)}>
          Comment here
        </MenuItem>
      )}
      {annotationsVisible && (
        <MenuItem icon={MapPinIcon} isDisabled={!target} onAction={() => target && onDropPoint(target)}>
          Drop a point
        </MenuItem>
      )}
      <MenuItem icon={CopyIcon} isDisabled={!target} onAction={() => target && copyCoordinates(target)}>
        Copy coordinates
      </MenuItem>
      {selected && <MenuSeparator />}
      {selected && (
        <MenuItem icon={TrashIcon} variant="danger" shortcut="Delete" onAction={onDelete}>
          {`Delete ${annotationNoun(selected)}`}
        </MenuItem>
      )}
    </ContextMenu>
  );
}
