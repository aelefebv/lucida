import { describe, expect, it } from "vitest";
import { isRemoteDatasetUrl, shortDatasetLocations } from "./datasetLocation.ts";

describe("shortDatasetLocations", () => {
  it("shows a dataset's folder and name", () => {
    expect(
      shortDatasetLocations([
        "/data/runs/sample.zarr",
        "gs://bucket/scans/volume.ome.zarr",
        "c:/data/sample.zarr",
      ]),
    ).toEqual(["…/runs/sample.zarr", "…/scans/volume.ome.zarr", "…/data/sample.zarr"]);
  });

  it("shows the whole URL when it is that short, without the query", () => {
    expect(
      shortDatasetLocations(["/sample.zarr", "gs://bucket/sample.zarr", "https://host/a.zarr/?sig=1#x"]),
    ).toEqual(["/sample.zarr", "gs://bucket/sample.zarr", "https://host/a.zarr"]);
  });

  it("reaches further up only where two would read the same", () => {
    expect(
      shortDatasetLocations([
        "/mnt/one/run/sample.zarr",
        "/mnt/two/run/sample.zarr",
        "/mnt/two/run/other.zarr",
      ]),
    ).toEqual(["…/one/run/sample.zarr", "…/two/run/sample.zarr", "…/run/other.zarr"]);
  });

  it("tells apart a shorter path whose tail another one shares", () => {
    expect(shortDatasetLocations(["/run/sample.zarr", "/mnt/a/run/sample.zarr"])).toEqual([
      "/run/sample.zarr",
      "…/a/run/sample.zarr",
    ]);
  });

  it("leaves the same URL twice at its short form", () => {
    expect(shortDatasetLocations(["/mnt/run/sample.zarr", "/mnt/run/sample.zarr/"])).toEqual([
      "…/run/sample.zarr",
      "…/run/sample.zarr",
    ]);
  });
});

describe("isRemoteDatasetUrl", () => {
  it("tells remote storage from a server path", () => {
    expect(isRemoteDatasetUrl("s3://bucket/a.zarr")).toBe(true);
    expect(isRemoteDatasetUrl("https://host/a.zarr")).toBe(true);
    expect(isRemoteDatasetUrl("/data/a.zarr")).toBe(false);
    expect(isRemoteDatasetUrl("c:/data/a.zarr")).toBe(false);
    expect(isRemoteDatasetUrl("//server/share/a.zarr")).toBe(false);
  });
});
