import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import initWasm from "lucida-core";
import { checkSource, looksLikeLocation } from "./sourceInput.ts";

beforeAll(async () => {
  const bytes = readFileSync(resolve(process.cwd(), "../lucida-core/pkg/lucida_core_bg.wasm"));
  await initWasm({ module_or_path: bytes });
});

describe("checkSource", () => {
  it("treats blank input as nothing to open", () => {
    expect(checkSource("   ")).toEqual({ kind: "empty" });
  });

  it.each([
    ["/data/sample.zarr", "/data/sample.zarr"],
    ["  /data/sample.zarr  ", "/data/sample.zarr"],
    ["C:\\data\\sample.zarr", "c:/data/sample.zarr"],
    ["file:///C:/data/sample.zarr", "c:/data/sample.zarr"],
    ["file:///data/sample.zarr", "/data/sample.zarr"],
    ["file:///data/my%20sample.zarr", "/data/my sample.zarr"],
    ["file://server/share/sample.zarr", "//server/share/sample.zarr"],
    ["\\\\server\\share\\sample.zarr", "//server/share/sample.zarr"],
    ["gs://bucket/sample.zarr", "gs://bucket/sample.zarr"],
    ["S3://bucket/Sample.zarr", "s3://bucket/Sample.zarr"],
    ["https://host/sample.zarr", "https://host/sample.zarr"],
  ])("accepts %s as %s", (raw, url) => {
    expect(checkSource(raw)).toEqual({ kind: "ok", url });
  });

  it.each(["sample.zarr", "data/sample.zarr", "./sample.zarr", "../sample.zarr", "file://sample.zarr"])(
    "asks for an absolute path instead of the relative %s",
    (raw) => {
      const check = checkSource(raw);
      expect(check.kind).toBe("rejected");
      if (check.kind === "rejected") {
        expect(check.message).toMatch(/relative/);
        expect(check.message).toMatch(/full path/);
        expect(check.message).not.toMatch(/scheme/i);
      }
    },
  );

  it("says the server doesn't expand a home-directory shortcut", () => {
    const check = checkSource("~/data/sample.zarr");
    expect(check.kind === "rejected" && check.message).toMatch(/doesn't expand ~/);
  });

  it("names a scheme it can't open and lists the ones it can", () => {
    const check = checkSource("ftp://host/sample.zarr");
    expect(check.kind === "rejected" && check.message).toMatch(/^ftp:\/\/ URLs can't be opened.*gs:\/\//);
  });

  it("asks for the bucket or host a bare scheme lacks", () => {
    const bucket = checkSource("gs://");
    expect(bucket.kind === "rejected" && bucket.message).toBe("Add a bucket name after gs://.");
    const host = checkSource("https://");
    expect(host.kind === "rejected" && host.message).toBe("Add a host name after https://.");
    const upper = checkSource("S3:///key");
    expect(upper.kind === "rejected" && upper.message).toBe("Add a bucket name after s3://.");
  });

  it("points out a URL missing the slashes after its scheme", () => {
    const check = checkSource("gs:bucket/sample.zarr");
    expect(check.kind === "rejected" && check.message).toMatch(/needs :\/\//);
  });
});

describe("looksLikeLocation", () => {
  it.each([
    "/data/sample.zarr",
    "  gs://bucket/sample.zarr",
    "gs:bucket/sample.zarr",
    "ftp://host/sample.zarr",
    "C:\\data\\sample.zarr",
    "c:/data/sample.zarr",
    "\\\\server\\share\\sample.zarr",
    "~/data/sample.zarr",
  ])("reads %s as a location", (raw) => {
    expect(looksLikeLocation(raw)).toBe(true);
  });

  it.each(["", "sample", "bright volume", "data/sample.zarr", "c:"])("reads %j as search words", (raw) => {
    expect(looksLikeLocation(raw)).toBe(false);
  });
});
