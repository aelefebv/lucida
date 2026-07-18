import { describe, it, expect } from "vitest";
import {
  shouldAutoFitOnOpen,
  isOpenerOf,
  type AutoFitContext,
} from "./autoFit.ts";

// A context where auto-fit SHOULD fire: this client is the opener, and no
// camera-owning state (restore / follow) is active.
const FIT: AutoFitContext = {
  isOpener: true,
  restoreOwnsDatasetOpen: false,
  following: false,
};

describe("shouldAutoFitOnOpen", () => {
  it("fits a fresh open when this client is the opener and nothing owns the camera", () => {
    expect(shouldAutoFitOnOpen("dataset_opened", FIT)).toBe(true);
  });

  it("does NOT fit when this client is not the opener (a co-present peer)", () => {
    // The headline multi-user case: someone else opened the dataset, so this
    // peer's broadcast handler runs but must leave its camera alone.
    expect(
      shouldAutoFitOnOpen("dataset_opened", { ...FIT, isOpener: false }),
    ).toBe(false);
  });

  it("does NOT fit while following another peer's camera", () => {
    expect(
      shouldAutoFitOnOpen("dataset_opened", { ...FIT, following: true }),
    ).toBe(false);
  });

  it("does NOT fit while a saved/last view is restoring (#700: restore wins)", () => {
    expect(
      shouldAutoFitOnOpen("dataset_opened", { ...FIT, restoreOwnsDatasetOpen: true }),
    ).toBe(false);
  });

  it("does NOT fit while restoring and following, even for the opener", () => {
    expect(
      shouldAutoFitOnOpen("dataset_opened", {
        isOpener: true,
        restoreOwnsDatasetOpen: true,
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
      for (const isOpener of [true, false]) {
        for (const restoreOwnsDatasetOpen of [true, false]) {
          for (const following of [true, false]) {
            const expected =
              commandType === "dataset_opened" &&
              isOpener &&
              !restoreOwnsDatasetOpen &&
              !following;
            expect(
              shouldAutoFitOnOpen(commandType, {
                isOpener,
                restoreOwnsDatasetOpen,
                following,
              }),
            ).toBe(expected);
          }
        }
      }
    }
  });

  it("any single disqualifying flag suppresses the fit (independent gates)", () => {
    // Each gate alone must be sufficient to suppress, so a regression in one
    // doesn't expose the camera via the others. Starting from FIT (would fit),
    // flipping exactly one of {not opener, following, restoring} suppresses it.
    expect(shouldAutoFitOnOpen("dataset_opened", { ...FIT, isOpener: false })).toBe(false);
    expect(shouldAutoFitOnOpen("dataset_opened", { ...FIT, following: true })).toBe(false);
    expect(shouldAutoFitOnOpen("dataset_opened", { ...FIT, restoreOwnsDatasetOpen: true })).toBe(false);
  });
});

describe("isOpenerOf", () => {
  it("is true when the stamped opener equals this client's id", () => {
    expect(isOpenerOf(5, 5)).toBe(true);
  });

  it("treats id 0 as a real id, not a sentinel (first-client opener fits)", () => {
    // The server allocates client ids from 0, so the single-user / first-client
    // opener is often id 0 — it MUST match, not be excluded.
    expect(isOpenerOf(0, 0)).toBe(true);
  });

  it("is false when the opener id differs (a co-present peer)", () => {
    expect(isOpenerOf(1, 2)).toBe(false);
    expect(isOpenerOf(0, 2)).toBe(false);
    expect(isOpenerOf(2, 0)).toBe(false);
  });

  it("is false when the opener id is undefined (older server omits the field)", () => {
    expect(isOpenerOf(undefined, 0)).toBe(false);
    expect(isOpenerOf(undefined, 7)).toBe(false);
  });

  it("is false when the opener id is null (serde None → JSON null)", () => {
    expect(isOpenerOf(null, 0)).toBe(false);
    expect(isOpenerOf(null, 7)).toBe(false);
  });
});
