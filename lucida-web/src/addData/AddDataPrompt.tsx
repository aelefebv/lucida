import { PlusIcon } from "@phosphor-icons/react";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { ADD_DATA_SHORTCUT } from "./shortcut.ts";
import "./AddDataPrompt.css";

/** What an empty workspace shows over the canvas. */
export function AddDataPrompt({ onAddData }: { onAddData: () => void }) {
  return (
    <div className="lc-add-data-prompt">
      <p className="lc-add-data-prompt-title">Add data to get started</p>
      <p className="lc-add-data-prompt-hint">Open a path or URL, or browse files on the server.</p>
      <Button variant="primary" icon={PlusIcon} onPress={onAddData}>
        Add data
      </Button>
      <p className="lc-add-data-prompt-hint">
        or press <Kbd keys={ADD_DATA_SHORTCUT} />
      </p>
    </div>
  );
}
