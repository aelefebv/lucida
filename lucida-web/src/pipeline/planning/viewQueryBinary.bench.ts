import { bench, describe } from "vitest";

import {
  encodeViewQueryDeltaFixture,
  encodeViewQueryFixture,
} from "../../test/viewQueryBinaryFixture.ts";
import type { ViewQueryDeltaJson, ViewQueryEntityJson } from "./snapshotDelta.ts";
import {
  decodeViewQuery,
  decodeViewQueryDelta,
  type ViewQueryBinaryResult,
} from "./viewQueryBinary.ts";

function row(index: number): ViewQueryEntityJson {
  return {
    entity_id: `entity-${index.toString().padStart(4, "0")}`,
    image_id: `image-${index.toString().padStart(4, "0")}`,
    kind: index % 3 === 0 ? "Image" : index % 3 === 1 ? "Group" : "Tile",
    visible: index % 2 === 0,
    projected_diagonal_px: 100.25 + index,
    projected_area_px2: 10_000.5 + index,
    centroid_world: [index, index + 0.5, index + 1],
    ideal_target_lod: index % 7,
    importance: 0.125 + index,
  };
}

const wide: ViewQueryBinaryResult = {
  epochs: { content: 1, layout: 2, view: 3, selection: 4, annotation: 5 },
  visible_entities: Array.from({ length: 216 }, (_, index) => row(index)),
};
const binary = encodeViewQueryFixture(wide);
const json = JSON.stringify(wide);
const deltaValue: ViewQueryDeltaJson = {
  Delta: {
    epochs: wide.epochs,
    entered: wide.visible_entities.slice(0, 4),
    left: wide.visible_entities.slice(4, 8).map((record) => record.image_id),
    changed: wide.visible_entities.slice(8, 12),
  },
};
const deltaBinary = encodeViewQueryDeltaFixture(deltaValue);
const deltaJson = JSON.stringify(deltaValue);

describe("216-record view-query JavaScript decode", () => {
  bench("versioned Uint8Array", () => {
    decodeViewQuery(binary);
  });

  bench("former JSON.parse", () => {
    JSON.parse(json);
  });
});

describe("12-record-change view-query delta JavaScript decode", () => {
  bench("versioned Uint8Array", () => {
    decodeViewQueryDelta(deltaBinary);
  });

  bench("former JSON.parse", () => {
    JSON.parse(deltaJson);
  });
});
