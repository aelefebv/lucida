import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;

function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionSources(path);
    if (!/\.(?:ts|tsx)$/.test(entry.name) || /\.test\.(?:ts|tsx)$/.test(entry.name)) return [];
    return [path];
  });
}

describe("WebGPU allocation boundary", () => {
  it("allows direct buffer/texture creation only inside GpuResourceBudget", () => {
    const offenders: string[] = [];
    const approvedOwners = new Set([
      "resources",
      "this.resources",
      "ctx.gpuResources",
    ]);
    for (const path of productionSources(ROOT)) {
      if (path.endsWith("/renderer/gpuResourceBudget.ts")) continue;
      const source = readFileSync(path, "utf8");
      const calls = source.matchAll(
        /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.create(?:Buffer|Texture)\s*\(/g,
      );
      for (const call of calls) {
        const receiver = call[1];
        if (approvedOwners.has(receiver)) continue;
        const line = source.slice(0, call.index).split("\n").length;
        offenders.push(`${relative(ROOT, path)}:${line} (${receiver})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
