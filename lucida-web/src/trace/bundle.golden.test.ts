// @vitest-environment happy-dom
/**
 * The golden bundle the CLI reads back. This suite writes
 * `trace-fixtures/bundle-v1.json` from `bundleFixtures.ts` and the CLI's
 * tests parse and print it, so the page is the generator and the CLI is the
 * lock, the reverse of the wire goldens.
 *
 * On failure, first decide which side is wrong. If the change is intentional,
 * `REGEN_TRACE_FIXTURES=1 pnpm exec vitest run src/trace/bundle.golden.test.ts`
 * regenerates it, and `cargo test -p lucida-cli` shows what the CLI needs.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { exportBundle } from "./bundle.ts";
import { fixtureContext } from "./bundleFixtures.ts";

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "trace-fixtures");
const FIXTURE = join(FIXTURE_ROOT, "bundle-v1.json");

function regen(): boolean {
  const flag = process.env.REGEN_TRACE_FIXTURES;
  return flag !== undefined && flag !== "" && flag !== "0";
}

describe("the golden bundle", () => {
  it("matches what the page produces from the fixed inputs", async () => {
    const bundle = await exportBundle(fixtureContext());
    // Round-tripped through JSON so the comparison is against what a file holds.
    const produced = JSON.parse(JSON.stringify(bundle));

    if (regen()) {
      mkdirSync(FIXTURE_ROOT, { recursive: true });
      // One line, as a saved bundle is. The lock is semantic, and a
      // pretty-printed trace document is thousands of lines nobody reads.
      writeFileSync(FIXTURE, `${JSON.stringify(produced)}\n`);
    }

    expect(existsSync(FIXTURE), `missing ${FIXTURE}; regenerate with REGEN_TRACE_FIXTURES=1`).toBe(
      true,
    );
    const committed = JSON.parse(readFileSync(FIXTURE, "utf-8"));
    expect(produced).toStrictEqual(committed);
  });
});
