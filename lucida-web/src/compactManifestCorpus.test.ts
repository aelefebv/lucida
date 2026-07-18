import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  resolveDatasetManifest,
  type DatasetManifestWire,
} from "./manifestTypes.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface CorpusOperation {
  op: "set" | "copy" | "remove";
  path: string;
  from?: string;
  value?: Json;
}

interface CorpusCase {
  name: string;
  accepted: boolean;
  operations: CorpusOperation[];
}

interface Corpus {
  base_fixture: string;
  target: string;
  cases: CorpusCase[];
}

function fixture(path: string): Json {
  return JSON.parse(
    readFileSync(new URL(`../../wire-fixtures/${path}`, import.meta.url), "utf8"),
  ) as Json;
}

function pointer(root: Json, path: string): Json {
  if (path === "" || path === "/") return root;
  let current = root;
  for (const encoded of path.split("/").slice(1)) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    current = Array.isArray(current)
      ? current[Number(key)]
      : (current as { [key: string]: Json })[key];
  }
  return current;
}

function applyOperation(root: Json, operation: CorpusOperation): void {
  const parts = operation.path.split("/").slice(1);
  const key = parts.pop()!.replaceAll("~1", "/").replaceAll("~0", "~");
  const parent = pointer(root, `/${parts.join("/")}`);
  const replacement = operation.op === "copy"
    ? structuredClone(pointer(root, operation.from!))
    : structuredClone(operation.value ?? null);

  if (Array.isArray(parent)) {
    const index = Number(key);
    if (operation.op === "remove") parent.splice(index, 1);
    else parent[index] = replacement;
    return;
  }
  const object = parent as { [key: string]: Json };
  if (operation.op === "remove") delete object[key];
  else object[key] = replacement;
}

const corpus = fixture("manifest/compact_multiscale_cases.json") as unknown as Corpus;
const opened = fixture(corpus.base_fixture) as { [key: string]: Json };

describe("shared compact multiscale accept/reject corpus", () => {
  for (const testCase of corpus.cases) {
    it(testCase.name, () => {
      const manifest = structuredClone(opened[corpus.target]);
      for (const operation of testCase.operations) applyOperation(manifest, operation);
      const resolve = () => resolveDatasetManifest(manifest as unknown as DatasetManifestWire);
      if (testCase.accepted) expect(resolve).not.toThrow();
      else expect(resolve).toThrow();
    });
  }
});
