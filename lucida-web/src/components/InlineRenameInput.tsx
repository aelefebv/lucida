import {
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
} from "react";

export interface InlineRenameInputProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "defaultValue" | "value" | "onChange" | "onBlur" | "onKeyDown"
  > {
  /** Seed value for this edit session. Remount to begin a different session. */
  initialValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

/**
 * Shared inline rename interaction: focus/select on mount, Enter or blur to
 * commit, Escape to cancel, and exactly one terminal callback per edit.
 */
export function InlineRenameInput({
  initialValue,
  onCommit,
  onCancel,
  onClick,
  ...inputProps
}: InlineRenameInputProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCommit(value);
  };

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  };

  return (
    <input
      {...inputProps}
      ref={inputRef}
      type="text"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    />
  );
}
