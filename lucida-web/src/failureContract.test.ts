import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseFailureDescriptor,
  type FailureCategory,
  type FailureCode,
} from "./failureContract.ts";

interface FailureContractRow {
  code: FailureCode;
  category: FailureCategory;
  retryable: boolean;
  client_kind: string;
}

const rows = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../test-fixtures/failure_contract.json", import.meta.url)),
    "utf8",
  ),
) as FailureContractRow[];

describe("shared typed failure contract", () => {
  it("preserves every protocol category, code, and retry decision", () => {
    expect(rows).toHaveLength(26);
    expect(new Set(rows.map(({ code }) => code)).size).toBe(26);

    for (const row of rows) {
      expect(parseFailureDescriptor(row)).toStrictEqual({
        category: row.category,
        code: row.code,
        retryable: row.retryable,
      });
    }
  });
});
