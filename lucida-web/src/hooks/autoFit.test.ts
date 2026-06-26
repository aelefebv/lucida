import { describe, it, expect } from "vitest";
import { shouldAutoFitOnOpen, type AutoFitContext } from "./autoFit.ts";

// A context where auto-fit SHOULD fire (not restoring, not following).
const FIT: AutoFitContext = {
  restoreInProgress: false,
  following: false,
};

describe("shouldAutoFitOnOpen", () => {
  it("fits a fresh open when not restoring and not following", () => {
    expect(shouldAutoFitOnOpen("dataset_opened", FIT)).toBe(true);
  });

  it("does NOT fit while following another peer's camera", () => {
    expect(
      shouldAutoFitOnOpen("dataset_opened", { ...FIT, following: true }),
    ).toBe(false);
  });

  it("does NOT fit while a saved/last view is restoring (#700: restore wins)", () => {
    expect(
      shouldAutoFitOnOpen("dataset_opened", { ...FIT, restoreInProgress: true }),
    ).toBe(false);
  });

  it("does NOT fit while both restoring and following", () => {
    expect(
      shouldAutoFitOnOpen("dataset_opened", {
        restoreInProgress: true,
        following: true,
      }),
    ).toBe(false);
  });

  it("never fits for a non-open command, even when everything else allows it", () => {
    expect(shouldAutoFitOnOpen("remove_dataset", FIT)).toBe(false);
    expect(shouldAutoFitOnOpen("add_annotation", FIT)).toBe(false);
    expect(shouldAutoFitOnOpen("register_layout", FIT)).toBe(false);
    expect(shouldAutoFitOnOpen("", FIT)).toBe(false);
  });

  it("requires the exact 'dataset_opened' command type", () => {
    expect(shouldAutoFitOnOpen("DATASET_OPENED", FIT)).toBe(false);
    expect(shouldAutoFitOnOpen("dataset_opened ", FIT)).toBe(false);
    expect(shouldAutoFitOnOpen("dataset_opened_partial", FIT)).toBe(false);
  });

  it("is the full conjunction across every flag combination", () => {
    const types = ["dataset_opened", "remove_dataset", ""];
    for (const commandType of types) {
      for (const restoreInProgress of [true, false]) {
        for (const following of [true, false]) {
          const expected =
            commandType === "dataset_opened" &&
            !restoreInProgress &&
            !following;
          expect(
            shouldAutoFitOnOpen(commandType, { restoreInProgress, following }),
          ).toBe(expected);
        }
      }
    }
  });

  it("any single disqualifying flag suppresses the fit (independent gates)", () => {
    // Each gate alone must be sufficient to suppress, so a regression in one
    // doesn't expose the camera via the other.
    expect(shouldAutoFitOnOpen("dataset_opened", { ...FIT, following: true })).toBe(false);
    expect(shouldAutoFitOnOpen("dataset_opened", { ...FIT, restoreInProgress: true })).toBe(false);
  });
});
