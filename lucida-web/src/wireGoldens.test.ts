/**
 * Golden-fixture lock tests for the JSON wire protocol (web side).
 *
 * The committed fixtures under `wire-fixtures/` at the repository root are
 * generated and byte-locked by the Rust side
 * (`lucida-server/tests/wire_goldens.rs`), which builds each payload with
 * the real serde types. This suite parses THE SAME files and drives them
 * through the web's real consumption paths:
 *
 * - server envelopes through a real `Bridge` (its `onmessage` dispatch),
 *   asserting every handler argument;
 * - client envelopes through the real `Bridge` send methods and the real
 *   `ProxiedContentSource` request senders, asserting the transmitted
 *   frames equal the fixtures;
 * - every web-live `DocumentCommand` through `Bridge.sendCommand`, with the
 *   command bodies authored here mirroring the production producers
 *   (layoutRegistry.ts, useDatasetSettings.ts, AnnotationOverlay.tsx,
 *   ThreadPopover.tsx, savedView/buildAnnotationView.ts);
 * - `DatasetOpened` payloads against the `manifestTypes` mirrors and through
 *   `extractDataType` / `mergeGeneratedAvailabilityIntoManifest`;
 * - generated-availability payloads through `GeneratedAvailabilityCatalog`;
 * - asset-catalog deltas through the `AssetCatalog` web mirror;
 * - the enum vocabulary fixture against the production TS unions and
 *   `COLORMAP_NAMES`, so a Rust variant rename/addition cannot outrun the
 *   web's string dispatch vocabulary.
 *
 * Every fixture is additionally compared `toStrictEqual` against an
 * expected value AUTHORED HERE in TypeScript (typed with the production
 * mirror interfaces where they exist). That makes the check exhaustive: a
 * Rust-side field rename, after regenerating the fixtures, changes the
 * fixture but not these literals, so this suite fails instead of the web
 * silently reading `undefined`.
 *
 * Scope note: the binary chunk/proxy frames are locked separately
 * (`pipeline/fetch/wireProtocol.test.ts`); `ChunkMessage::ChunkFetch` is
 * currently unproduced wire vocabulary (nothing sends it; the server
 * ignores it if a client does) and is excluded from the lock. A newly
 * added serde-skipped field that no fixture populates is invisible to this
 * lock — see the Rust test header for that documented limit.
 *
 * On failure, first decide which side is wrong. If the Rust wire change is
 * intentional, regenerate fixtures with
 * `REGEN_WIRE_GOLDENS=1 cargo test -p lucida-server --test wire_goldens`
 * and update the expectations (and any production mirror types) here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  Bridge,
  type BridgeHandlers,
  type BookmarkAction,
  type DatasetHealthStatus,
  type DatasetOpenProgressDiagnostic,
  type DatasetOpenStage,
  type DatasetSourceHealth,
  type PresenceState,
} from "./bridge.ts";
import {
  extractDataType,
  resolveDatasetManifest,
  resolveFetchSource,
  type DatasetManifest,
  type DatasetManifestWire,
  type Entity,
  type FetchSource,
  type FetchSourceWire,
  type LayoutSpec,
} from "./manifestTypes.ts";
import { dtypeMax } from "./types.ts";
import {
  GeneratedAvailabilityCatalog,
  mergeGeneratedAvailabilityIntoManifest,
  type GeneratedChunkStatus,
  type WireGeneratedAvailabilityDelta,
  type WireGeneratedAvailabilitySnapshot,
  type WireGeneratedLevelAvailability,
} from "./pipeline/generatedAvailability.ts";
import {
  AssetCatalog,
  type ProxyKind,
  type WireAssetCatalog,
  type WireAssetCatalogDelta,
} from "./pipeline/assetCatalog.ts";
import { ProxiedContentSource } from "./pipeline/fetch/contentSource.ts";
import { ServerRowTable, serverRowTotalUs } from "./trace/serverRowTable.ts";
import { LABEL_NONE, PHASE_UNSET } from "./trace/types.ts";
import { COLORMAP_NAMES } from "./colormaps.ts";
import {
  type ArcballCamera,
  type BlendMode,
  type DatasetDisplaySettings as WireDatasetDisplaySettings,
  type DisplayState as WireDisplayState,
  type FlyCamera,
  type RenderMode,
  type SavedView,
  type SliceCamera,
  type ViewState as WireViewState,
} from "./savedView/types.ts";
import { viewModeForCamera } from "./savedView/restoreAnnotationView.ts";
import type { Annotation } from "./components/annotationDocument.ts";

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "wire-fixtures",
);

function fixtureRaw(rel: string): string {
  return readFileSync(join(FIXTURE_ROOT, rel), "utf-8");
}

function fixture(rel: string): unknown {
  return JSON.parse(fixtureRaw(rel));
}

/** Every fixture file, so the inventory test can prove none is unasserted. */
function allFixtureFiles(): string[] {
  const out: string[] = [];
  for (const dir of readdirSync(FIXTURE_ROOT)) {
    for (const file of readdirSync(join(FIXTURE_ROOT, dir))) {
      out.push(`${dir}/${file}`);
    }
  }
  return out.sort();
}

/** Fixtures asserted somewhere in this suite; kept in sync by the inventory
 *  test so a new Rust-side fixture cannot land without web-side coverage. */
const COVERED_FIXTURES = new Set<string>();

function coveredFixture(rel: string): unknown {
  COVERED_FIXTURES.add(rel);
  return fixture(rel);
}

// ---------------------------------------------------------------------------
// Bridge harness (stand-in transport, real Bridge)
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  url: string;
  binaryType = "blob";
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

function makeHandlers(overrides: Partial<BridgeHandlers> = {}): BridgeHandlers {
  return {
    onSnapshot: vi.fn(),
    onCommand: vi.fn(),
    onAck: vi.fn(),
    ...overrides,
  };
}

function openBridge(overrides: Partial<BridgeHandlers> = {}) {
  const handlers = makeHandlers(overrides);
  const bridge = new Bridge(handlers, "ws://test/ws/workspaces/w1");
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.open();
  return { bridge, ws, handlers };
}

function deliver(ws: FakeWebSocket, raw: string): void {
  ws.onmessage?.({ data: raw });
}

function lastSent(ws: FakeWebSocket): unknown {
  expect(ws.sent.length).toBeGreaterThan(0);
  return JSON.parse(ws.sent[ws.sent.length - 1]);
}

// ---------------------------------------------------------------------------
// Expected wire values, authored in TS against the production mirror types.
// These are the web's half of the contract: they must describe the exact
// same values `lucida-server/tests/wire_goldens.rs` constructs in Rust.
// ---------------------------------------------------------------------------

const IDENTITY_TRANSLATION = (tx: number, ty: number): number[] => [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, 0, 1,
];

const expectedManifestSingle: DatasetManifest = {
  dataset_id: "wds-0f3a",
  name: "kidney-multiplex.zarr",
  kind: "Single",
  entities: [
    {
      id: "img-0",
      kind: "Image",
      parent: null,
      labels: { name: "kidney-multiplex.zarr" },
    },
  ],
  transforms: [
    {
      from: "img-0",
      to: "img-0",
      // Not a pure 2D translation (anisotropic z scale), so it stays in the
      // full-matrix wire form; pure translations arrive as
      // `translation: [tx, ty]` (locked by the collection fixture).
      transform: {
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 128, -64, 0, 1],
      },
    },
  ],
  images: [
    {
      image_id: "multiscale-0",
      owner: "img-0",
      multiscale: {
        axes: [
          { name: "t", kind: "Time" },
          { name: "c", kind: "Channel" },
          { name: "z", kind: "Space" },
          { name: "y", kind: "Space" },
          { name: "x", kind: "Space" },
        ],
        levels: [
          {
            level_index: 0,
            shape: [3, 2, 50, 4096, 4096],
            chunk_shape: [1, 1, 1, 256, 256],
            grid_shape: [3, 2, 50, 16, 16],
            scale: [1, 1, 2, 0.25, 0.25],
          },
          {
            level_index: 1,
            shape: [3, 2, 50, 2048, 2048],
            chunk_shape: [1, 1, 1, 256, 256],
            grid_shape: [3, 2, 50, 8, 8],
            scale: [1, 1, 2, 0.5, 0.5],
          },
          {
            level_index: 2,
            shape: [3, 2, 50, 512, 512],
            chunk_shape: [1, 1, 25, 512, 512],
            grid_shape: [3, 2, 2, 1, 1],
            scale: [1, 1, 2, 2, 2],
          },
        ],
        coarse_level_index: 2,
        generated_levels: [
          {
            level_index: 2,
            role: "coarse",
            provenance: {
              generator: "coarse-v1",
              config_id: "max-axis-1024",
              source_content_id: "blake3:9f2ce6",
            },
          },
        ],
        data_type: "Uint16",
        pinned_axes: [{ name: "m", size: 4, pinned_index: 0 }],
        channel_infos: [
          { label: "Channel 0", color: "0000FF" },
          { label: "Channel 1" },
        ],
      },
    },
  ],
  source_layouts: [
    {
      id: "layout-source",
      name: "Source positions",
      placements: [{ entity_id: "img-0", position: [12.5, -8] }],
    },
  ],
  default_layout_id: "layout-source",
  labels: [
    {
      name: "region-a",
      source_image_id: "multiscale-0",
      image: {
        image_id: "multiscale-0:label:region-a",
        owner: "img-0",
        multiscale: {
          axes: [
            { name: "z", kind: "Space" },
            { name: "y", kind: "Space" },
            { name: "x", kind: "Space" },
          ],
          levels: [
            {
              level_index: 0,
              shape: [1, 1, 50, 1024, 1024],
              chunk_shape: [1, 1, 1, 256, 256],
              grid_shape: [1, 1, 50, 4, 4],
              scale: [1, 1, 2, 1, 1],
            },
          ],
          data_type: "Uint32",
          pinned_axes: [],
        },
      },
      colors: [
        { value: 1, rgba: [255, 64, 0, 255] },
        { value: 92801, rgba: [0, 128, 255, 128] },
      ],
      source_declared: true,
    },
  ],
};

const expectedFetchSingle: FetchSource = {
  Proxied: {
    images: [
      { image_id: "multiscale-0", wire_format: { Zstd: { data_type: "Uint16" } } },
      {
        image_id: "multiscale-0:label:region-a",
        wire_format: { Raw: { data_type: "Uint32" } },
      },
    ],
  },
};

const expectedCatalogSingle: WireAssetCatalog = {
  entries: [
    {
      entity_id: "img-0",
      kinds: ["TileProxy3D"],
      footprints: [
        { kind: "TileProxy3D", dims: [50, 128, 128], bytes: 1638400 },
      ],
    },
  ],
};

/** Wire shape of `lucida_protocol::DatasetOpened`. */
interface WireDatasetOpened {
  manifest: DatasetManifest;
  fetch: FetchSource;
  catalog: WireAssetCatalog;
  opener_client_id: number | null;
}

const expectedDatasetOpenedSingle: WireDatasetOpened = {
  manifest: expectedManifestSingle,
  fetch: expectedFetchSingle,
  catalog: expectedCatalogSingle,
  opener_client_id: 7,
};

/** The collection's one shared multiscale, emitted ONCE in the manifest's
 *  `multiscales` table and referenced per tile via `multiscale_ref`. */
const expectedCollectionSharedMultiscale = {
  axes: [
    { name: "c", kind: "Channel" },
    { name: "z", kind: "Space" },
    { name: "y", kind: "Space" },
    { name: "x", kind: "Space" },
  ],
  levels: [
    {
      level_index: 0,
      shape: [1, 4, 12, 1024, 1024],
      chunk_shape: [1, 1, 1, 512, 512],
      grid_shape: [1, 4, 12, 2, 2],
      scale: [1, 1, 5, 0.65, 0.65],
    },
    {
      level_index: 1,
      shape: [1, 4, 12, 512, 512],
      chunk_shape: [1, 1, 1, 512, 512],
      grid_shape: [1, 4, 12, 1, 1],
      scale: [1, 1, 5, 1.3, 1.3],
    },
  ],
  data_type: "Uint8",
  pinned_axes: [],
};

/** The collection manifest as it crosses the wire: shared-once multiscale
 *  table, per-image references, and compact `translation` placement edges —
 *  announced by the leading `format_version` marker (absent on fully-inline
 *  manifests, e.g. the single fixture). `resolveDatasetManifest` expands
 *  this into the in-memory shape below. */
const expectedManifestCollection: DatasetManifestWire = {
  format_version: 2,
  dataset_id: "wds-collection-77",
  name: "screening-collection-01.zarr",
  kind: {
    Collection: {
      rows: ["A", "B"],
      columns: ["1", "2", "3"],
      positioning_mode: "Explicit",
      has_explicit_positions: true,
    },
  },
  entities: [
    {
      id: "group-A1",
      kind: "Group",
      parent: null,
      labels: {
        name: "A1",
        group_row: "A",
        group_column: "1",
        row_index: 0,
        column_index: 0,
      },
    },
    {
      id: "tile-A1-f0",
      kind: "Tile",
      parent: "group-A1",
      labels: { name: "A1/0", tile_index: 0 },
    },
    {
      id: "tile-A1-f1",
      kind: "Tile",
      parent: "group-A1",
      labels: { name: "A1/1", tile_index: 1 },
    },
  ],
  transforms: [
    { from: "tile-A1-f0", to: "group-A1", translation: [0, 0] },
    { from: "tile-A1-f1", to: "group-A1", translation: [2048, 1024] },
  ],
  multiscales: [expectedCollectionSharedMultiscale],
  images: [
    { image_id: "tile-A1-f0-image", owner: "tile-A1-f0", multiscale_ref: 0 },
    { image_id: "tile-A1-f1-image", owner: "tile-A1-f1", multiscale_ref: 0 },
  ],
  source_layouts: [
    {
      id: "layout-explicit",
      name: "Explicit positions",
      placements: [
        { entity_id: "group-A1", position: [0, 0] },
        { entity_id: "tile-A1-f0", position: [0, 0] },
        { entity_id: "tile-A1-f1", position: [2048, 1024] },
      ],
    },
  ],
  default_layout_id: "layout-explicit",
};

const expectedFetchCollection: FetchSourceWire = {
  Proxied: {
    format_version: 2,
    images: [
      { image_id: "tile-A1-f0-image", wire_format_ref: 0 },
      { image_id: "tile-A1-f1-image", wire_format_ref: 0 },
    ],
    wire_formats: [{ Lz4: { data_type: "Uint8" } }],
  },
};

/** Wire shape of `lucida_protocol::DatasetOpened` for a collection: manifest
 *  and fetch arrive in the compact form. */
interface WireDatasetOpenedCollection {
  manifest: DatasetManifestWire;
  fetch: FetchSourceWire;
  catalog: WireAssetCatalog;
  opener_client_id: number | null;
}

const expectedDatasetOpenedCollection: WireDatasetOpenedCollection = {
  manifest: expectedManifestCollection,
  fetch: expectedFetchCollection,
  catalog: { entries: [] },
  opener_client_id: null,
};

const expectedDisplaySettings: WireDatasetDisplaySettings = {
  visible: true,
  opacity: 0.8,
  contrast_min: 120,
  contrast_max: 4096,
  gamma: 0.85,
  blend_mode: "max",
  render_mode: "max_intensity",
  channel_settings: [
    {
      visible: true,
      colormap: "magenta",
      contrast_min: 100,
      contrast_max: 12000,
      gamma: 1,
      name: "Region A",
    },
    {
      visible: false,
      colormap: "green",
      contrast_min: 0,
      contrast_max: 65535,
      gamma: 1.2,
    },
  ],
  label_settings: [{ visible: true, opacity: 0.35 }],
  channel_blend_mode: "additive",
  detail_level_override: 1,
  label_names: ["region-a"],
};

const expectedSliceCamera: SliceCamera = {
  mode: "slice",
  center: [1024.5, -512.25],
  zoom: 1.5,
  viewport: [1920, 1080],
};

const expectedArcballCamera: ArcballCamera = {
  mode: "arcball",
  target: [2048, 2048, 50],
  theta: 0.7853981633974483,
  phi: 1.0471975511965979,
  distance: 6000,
  fov: 0.7853981633974483,
  viewport: [1920, 1080],
  near: 1,
  far: 50000,
  clip_distance: 120,
  clip_mode: "sphere",
};

const expectedFlyCamera: FlyCamera = {
  mode: "fly",
  position: [512, 512, -300],
  orientation: [0.1, 0.2, 0.3, 0.9273],
  fov: 1.0471975511965979,
  viewport: [1280, 720],
  near: 0.1,
  far: 10000,
  speed_multiplier: 2,
  base_speed: 340.5,
  clip_distance: 0.42,
  clip_mode: "sphere",
};

const expectedView: WireViewState = {
  z_range: { start: 10, end: 14 },
  t: 2,
  c: 1,
  multi_channel: true,
};
const expectedDisplay: WireDisplayState = {
  contrast_min: 120,
  contrast_max: 4096,
  gamma: 0.85,
};

/** The pin-embedded author view (`Annotation.view` / `AddAnnotation.view`)
 *  in workspace-dataset-id form: `datasets` empty by invariant (no source
 *  URLs on the document wire), everything else populated. This is the shape
 *  `savedView/buildAnnotationView.ts` captures and
 *  `savedView/restoreAnnotationView.ts` consumes. */
const expectedPinView: SavedView = {
  v: 1,
  datasets: [],
  active_layouts: { "wds-0f3a": "layout-grid" },
  camera: expectedArcballCamera,
  view: expectedView,
  display: expectedDisplay,
  dataset_order: ["wds-0f3a"],
  dataset_settings: { "wds-0f3a": expectedDisplaySettings },
  auto_contrast: { "wds-0f3a": false },
};

const expectedPeerPresence = {
  client_id: 3,
  camera: expectedSliceCamera,
  view: expectedView,
  display: expectedDisplay,
  following: 9,
  cursor: [412, 233.5] as [number, number],
  dataset_order: ["wds-0f3a"],
  dataset_settings: { "wds-0f3a": expectedDisplaySettings },
  identity: {
    display_name: "Ada Lovelace",
    picture_url: "https://example.com/avatars/ada.png",
    initial: "A",
  },
};
// tsc-level lock: the exhaustive wire shape must stay assignable to the
// production mirror the bridge hands to consumers.
const presenceMirror: PresenceState = expectedPeerPresence;
void presenceMirror;

const expectedJoiningPresence = {
  client_id: 11,
  camera: expectedFlyCamera,
  view: { z_range: { start: 0, end: 50 }, t: 0, c: 0, multi_channel: false },
  display: { contrast_min: 0, contrast_max: 65535, gamma: 1 },
  following: null,
  cursor: null,
  dataset_order: [] as string[],
  dataset_settings: {},
};
const joiningMirror: PresenceState = expectedJoiningPresence;
void joiningMirror;

/** Wire shape of `lucida_core::scene::Annotation` (the snapshot pins).
 *  Exhaustive — includes `anchor`, which the web's `Annotation` mirror does
 *  not read yet. */
interface WireAnnotation {
  id: string;
  position: [number, number];
  z: number;
  t: number;
  c: number;
  author: string;
  kind: "point" | "line" | "box";
  end: [number, number] | null;
  comments: { id: string; author: string; text: string }[];
  anchor: string | null;
  view?: SavedView;
}

const expectedBoxAnnotation: WireAnnotation = {
  id: "pin-4c1d",
  position: [310, 455.5],
  z: 12.5,
  t: 2,
  c: 1,
  author: "ada@example",
  kind: "box",
  end: [420, 505.5],
  comments: [
    {
      id: "comment-91",
      author: "grace@example",
      text: "glomerulus boundary looks off here",
    },
  ],
  anchor: "img-0",
  view: expectedPinView,
};

const expectedPointAnnotation: WireAnnotation = {
  id: "pin-77b2",
  position: [1500, 900],
  z: 30,
  t: 0,
  c: 0,
  author: "grace@example",
  kind: "point",
  end: null,
  comments: [],
  anchor: null,
};

const expectedLineAnnotation: WireAnnotation = {
  id: "pin-a3e9",
  position: [200, 240],
  z: 5,
  t: 1,
  c: 0,
  author: "ada@example",
  kind: "line",
  end: [260, 300],
  comments: [],
  anchor: null,
};

// tsc-level lock against the overlay's production mirror.
const annotationMirror: Annotation = expectedBoxAnnotation;
void annotationMirror;

const expectedGridLayout: LayoutSpec = {
  id: "layout-grid",
  name: "Grid",
  placements: [{ entity_id: "img-0", position: [0, 4224] }],
};

/** Wire shape of `lucida_core::scene::DocumentState` in the snapshot. */
interface WireDocumentState {
  manifests: Record<string, DatasetManifest>;
  registered_layouts: Record<string, LayoutSpec[]>;
  active_layout_ids: Record<string, string>;
  asset_catalogs: Record<string, WireAssetCatalog>;
  annotations: Record<string, WireAnnotation[]>;
}

const expectedDocument: WireDocumentState = {
  manifests: { "wds-0f3a": expectedManifestSingle },
  registered_layouts: { "wds-0f3a": [expectedGridLayout] },
  active_layout_ids: { "wds-0f3a": "layout-grid" },
  asset_catalogs: { "wds-0f3a": expectedCatalogSingle },
  annotations: {
    "wds-0f3a": [expectedBoxAnnotation, expectedPointAnnotation, expectedLineAnnotation],
  },
};

const expectedGeneratedLevel: WireGeneratedLevelAvailability = {
  image_id: "multiscale-0",
  info: {
    level_index: 2,
    role: "coarse",
    provenance: {
      generator: "coarse-v1",
      config_id: "max-axis-1024",
      source_content_id: "blake3:9f2ce6",
    },
  },
  level: {
    level_index: 2,
    shape: [3, 2, 50, 512, 512],
    chunk_shape: [1, 1, 25, 512, 512],
    grid_shape: [3, 2, 2, 1, 1],
    scale: [1, 1, 2, 2, 2],
  },
  summary: { total_chunks: 12, ready_chunks: 7, pending_chunks: 3, failed_chunks: 2 },
};

const expectedGeneratedSnapshot: WireGeneratedAvailabilitySnapshot = {
  levels: [
    expectedGeneratedLevel,
    {
      image_id: "multiscale-0:label:region-a",
      info: {
        level_index: 1,
        role: "coarse",
        provenance: { generator: "coarse-v1", config_id: "max-axis-512" },
      },
      level: {
        level_index: 1,
        shape: [1, 1, 50, 256, 256],
        chunk_shape: [1, 1, 50, 256, 256],
        grid_shape: [1, 1, 1, 1, 1],
        scale: [1, 1, 2, 4, 4],
      },
    },
  ],
  chunks: [
    { image_id: "multiscale-0", level_index: 2, key: "2/0/0/0/0/0", status: "ready" },
    { image_id: "multiscale-0", level_index: 2, key: "2/0/0/1/0/0", status: "pending" },
    { image_id: "multiscale-0", level_index: 2, key: "2/1/0/0/0/0", status: "unavailable" },
    {
      image_id: "multiscale-0",
      level_index: 2,
      key: "2/1/0/1/0/0",
      status: "failed_transient",
      message: "source read timed out",
    },
    {
      image_id: "multiscale-0",
      level_index: 2,
      key: "2/2/0/0/0/0",
      status: "failed_permanent",
      message: "chunk exceeds generation budget",
    },
  ],
};

const expectedGeneratedDelta: WireGeneratedAvailabilityDelta = {
  levels: [expectedGeneratedLevel],
  chunks: [
    { image_id: "multiscale-0", level_index: 2, key: "2/0/0/1/0/0", status: "ready" },
  ],
};

const expectedSourceHealth: DatasetSourceHealth = {
  workspace_dataset_id: "wds-0f3a",
  name: "kidney-multiplex.zarr",
  status: "degraded",
  source_url: "gs://lucida-fixtures/kidney-multiplex.zarr",
  backend: "gcs",
  binding: { status: "healthy", message: "bound to gcs source" },
  source_cache: {
    max_bytes: 536870912,
    current_bytes: 268435456,
    used_percent: 50,
    entry_count: 1024,
    hits: 9137,
    misses: 421,
    evictions: 17,
    backend_errors: 2,
    source_reads: 430,
    source_read_millis: 51280,
  },
  generated_coarse: {
    status: "degraded",
    level_count: 1,
    ready_chunks: 40,
    pending_chunks: 3,
    failed_chunks: 2,
    unavailable_chunks: 1,
    message: "2 chunks failed in the last generation pass",
    cache: {
      storage: "disk",
      current_bytes: 73400320,
      max_bytes: 1073741824,
      used_percent: 6,
      evictions: 4,
      root: "/var/cache/lucida/generated",
    },
    recent_failures: [
      {
        image_id: "multiscale-0",
        level_index: 2,
        key: "2/1/0/1/0/0",
        status: "failed_transient",
        message: "source read timed out",
      },
    ],
  },
  messages: ["generated coarse cache is warming"],
};

const expectedProgressDiagnostic: DatasetOpenProgressDiagnostic = {
  stage: "generated_coarse_planning",
  message: "planning generated coarse levels",
  workspace_dataset_id: "wds-0f3a",
  dataset_source_id: "source-9b31",
  detail: "1 derived level over 2 source levels",
};

const expectedAssetCatalogDelta: WireAssetCatalogDelta = {
  added: [
    {
      entity_id: "img-0",
      kinds: ["GroupProxy3D", "TileProxy3D"],
      footprints: [
        { kind: "GroupProxy3D", dims: [50, 256, 256], bytes: 6553600 },
      ],
    },
  ],
};

/** The interest hint exactly as `tickCoordinator.emitViewerInterestHint`
 *  assembles it, with all three lanes represented (`visible`/`background`
 *  entries land in `desired_keys`, `predicted` in `predicted_keys`). The
 *  web never sends `client_id`; the server defaults it. */
const expectedInterestHint = {
  dataset_id: "wds-0f3a",
  generation: 9,
  t: 2,
  z: 12,
  channels: [0, 1],
  mode: "slice",
  viewport: { xy_bounds: [0, 0, 4096, 4096], z_range: [10, 14] },
  desired_keys: [
    { image_id: "multiscale-0", key: "1/2/1/12/3/4", lane: "visible" },
    { image_id: "multiscale-0", key: "0/2/1/12/3/4", lane: "background" },
  ],
  predicted_keys: [{ image_id: "multiscale-0", key: "1/2/1/13/3/4", lane: "predicted" }],
  interaction: "scrubbing",
  timestamp_ms: 1767225600123,
  ttl_ms: 2000,
};

// ---------------------------------------------------------------------------
// Server → client envelopes, dispatched by the real Bridge
// ---------------------------------------------------------------------------

describe("wire goldens: server messages through Bridge dispatch", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("snapshot: document, peers, your_id, and generated availability all arrive", () => {
    const raw = fixtureRaw("session/server_snapshot.json");
    COVERED_FIXTURES.add("session/server_snapshot.json");
    expect(JSON.parse(raw)).toStrictEqual({
      type: "snapshot",
      seq: 42,
      document: expectedDocument,
      peers: [expectedPeerPresence],
      your_id: 7,
      generated_availability: { "wds-0f3a": expectedGeneratedSnapshot },
    });

    const onSnapshot = vi.fn();
    const { ws } = openBridge({ onSnapshot });
    deliver(ws, raw);

    expect(onSnapshot).toHaveBeenCalledTimes(1);
    const [seq, documentJson, peers, yourId, generatedAvailability] =
      onSnapshot.mock.calls[0];
    expect(seq).toBe(42);
    const document: WireDocumentState = JSON.parse(documentJson);
    expect(document).toStrictEqual(expectedDocument);
    expect(peers).toStrictEqual([expectedPeerPresence]);
    expect(yourId).toBe(7);
    expect(generatedAvailability).toStrictEqual({
      "wds-0f3a": expectedGeneratedSnapshot,
    });

    // The pin's embedded author view drives the restore path's mode choice
    // (savedView/restoreAnnotationView.ts): an arcball capture is a 3D view.
    const pinView = document.annotations["wds-0f3a"][0].view;
    expect(pinView).toBeDefined();
    expect(viewModeForCamera(pinView!.camera)).toBe("3d");
  });

  it("command_broadcast(dataset_opened): the manifest/fetch/catalog payload", () => {
    const raw = fixtureRaw("session/server_command_broadcast_dataset_opened.json");
    COVERED_FIXTURES.add("session/server_command_broadcast_dataset_opened.json");
    expect(JSON.parse(raw)).toStrictEqual({
      type: "command_broadcast",
      seq: 43,
      command: { type: "dataset_opened", ...expectedDatasetOpenedSingle },
    });

    const onCommand = vi.fn();
    const { ws } = openBridge({ onCommand });
    deliver(ws, raw);

    expect(onCommand).toHaveBeenCalledTimes(1);
    const [seq, commandJson] = onCommand.mock.calls[0];
    expect(seq).toBe(43);
    // The same fields sessionController's dataset_opened arm reads (typed, no `as`).
    const command: { type: string } & WireDatasetOpened = JSON.parse(commandJson);
    expect(command.type).toBe("dataset_opened");
    expect(command.manifest).toStrictEqual(expectedManifestSingle);
    expect(command.fetch).toStrictEqual(expectedFetchSingle);
    expect(command.catalog).toStrictEqual(expectedCatalogSingle);
    expect(command.opener_client_id).toBe(7);
  });

  it("ack", () => {
    const raw = fixtureRaw("session/server_ack.json");
    COVERED_FIXTURES.add("session/server_ack.json");
    expect(JSON.parse(raw)).toStrictEqual({ type: "ack", seq: 44 });

    const { ws, handlers } = openBridge();
    deliver(ws, raw);
    expect(handlers.onAck).toHaveBeenCalledWith(44);
  });

  it("peer_joined carries the full presence (fly camera, no identity)", () => {
    const raw = fixtureRaw("session/server_peer_joined.json");
    COVERED_FIXTURES.add("session/server_peer_joined.json");
    expect(JSON.parse(raw)).toStrictEqual({
      type: "peer_joined",
      client_id: 11,
      presence: expectedJoiningPresence,
    });

    const onPeerJoined = vi.fn();
    const { ws } = openBridge({ onPeerJoined });
    deliver(ws, raw);
    expect(onPeerJoined).toHaveBeenCalledWith(11, expectedJoiningPresence);
  });

  it("peer_left", () => {
    const raw = fixtureRaw("session/server_peer_left.json");
    COVERED_FIXTURES.add("session/server_peer_left.json");
    expect(JSON.parse(raw)).toStrictEqual({ type: "peer_left", client_id: 11 });

    const onPeerLeft = vi.fn();
    const { ws } = openBridge({ onPeerLeft });
    deliver(ws, raw);
    expect(onPeerLeft).toHaveBeenCalledWith(11);
  });

  it("presence_update carries camera/view/display (arcball with clipping)", () => {
    const raw = fixtureRaw("session/server_presence_update.json");
    COVERED_FIXTURES.add("session/server_presence_update.json");
    expect(JSON.parse(raw)).toStrictEqual({
      type: "presence_update",
      client_id: 3,
      camera: expectedArcballCamera,
      view: expectedView,
      display: expectedDisplay,
    });

    const onPresenceUpdate = vi.fn();
    const { ws } = openBridge({ onPresenceUpdate });
    deliver(ws, raw);
    expect(onPresenceUpdate).toHaveBeenCalledWith(
      3,
      expectedArcballCamera,
      expectedView,
      expectedDisplay,
    );
  });

  it("cursor_update", () => {
    const raw = fixtureRaw("session/server_cursor_update.json");
    COVERED_FIXTURES.add("session/server_cursor_update.json");
    expect(JSON.parse(raw)).toStrictEqual({
      type: "cursor_update",
      client_id: 3,
      position: [412, 233.5],
    });

    const onCursorUpdate = vi.fn();
    const { ws } = openBridge({ onCursorUpdate });
    deliver(ws, raw);
    expect(onCursorUpdate).toHaveBeenCalledWith(3, [412, 233.5]);
  });

  it("follow_changed", () => {
    const raw = fixtureRaw("session/server_follow_changed.json");
    COVERED_FIXTURES.add("session/server_follow_changed.json");
    expect(JSON.parse(raw)).toStrictEqual({
      type: "follow_changed",
      client_id: 3,
      target: 9,
    });

    const onFollowChanged = vi.fn();
    const { ws } = openBridge({ onFollowChanged });
    deliver(ws, raw);
    expect(onFollowChanged).toHaveBeenCalledWith(3, 9);
  });

  it("dataset_presence_update carries order + full per-dataset settings", () => {
    const raw = fixtureRaw("session/server_dataset_presence_update.json");
    COVERED_FIXTURES.add("session/server_dataset_presence_update.json");
    expect(JSON.parse(raw)).toStrictEqual({
      type: "dataset_presence_update",
      client_id: 3,
      dataset_order: ["wds-0f3a"],
      dataset_settings: { "wds-0f3a": expectedDisplaySettings },
    });

    const onDatasetPresenceUpdate = vi.fn();
    const { ws } = openBridge({ onDatasetPresenceUpdate });
    deliver(ws, raw);
    expect(onDatasetPresenceUpdate).toHaveBeenCalledWith(3, ["wds-0f3a"], {
      "wds-0f3a": expectedDisplaySettings,
    });
  });

  it("dataset_open_progress carries the staged diagnostic", () => {
    const raw = fixtureRaw("session/server_dataset_open_progress.json");
    COVERED_FIXTURES.add("session/server_dataset_open_progress.json");
    expect(JSON.parse(raw)).toStrictEqual({
      type: "dataset_open_progress",
      request_id: "web-7d2f45aa",
      url: "gs://lucida-fixtures/kidney-multiplex.zarr",
      diagnostic: expectedProgressDiagnostic,
    });

    const onDatasetOpenProgress = vi.fn();
    const { ws } = openBridge({ onDatasetOpenProgress });
    deliver(ws, raw);
    // The wire omits `warning` when false; the bridge coerces it to a clean
    // boolean before delivery, so the handler sees `warning: false`.
    expect(onDatasetOpenProgress).toHaveBeenCalledWith(
      "web-7d2f45aa",
      "gs://lucida-fixtures/kidney-multiplex.zarr",
      { ...expectedProgressDiagnostic, warning: false },
    );
  });

  it("dataset_open_progress carries a durable import-warning flag", () => {
    const raw = fixtureRaw("session/server_dataset_open_progress_warning.json");
    COVERED_FIXTURES.add("session/server_dataset_open_progress_warning.json");
    const expectedWarningDiagnostic: DatasetOpenProgressDiagnostic = {
      stage: "metadata_import",
      message:
        "labels were sampled during import; some tiles were not inspected and may carry additional labels",
      workspace_dataset_id: "wds-collection-77",
      warning: true,
    };
    expect(JSON.parse(raw)).toStrictEqual({
      type: "dataset_open_progress",
      request_id: "web-7d2f45aa",
      url: "gs://lucida-fixtures/sampled-collection-01.zarr",
      diagnostic: expectedWarningDiagnostic,
    });

    const onDatasetOpenProgress = vi.fn();
    const { ws } = openBridge({ onDatasetOpenProgress });
    deliver(ws, raw);
    expect(onDatasetOpenProgress).toHaveBeenCalledTimes(1);
    const [requestId, url, diagnostic] = onDatasetOpenProgress.mock.calls[0] as [
      string,
      string,
      DatasetOpenProgressDiagnostic,
    ];
    expect(requestId).toBe("web-7d2f45aa");
    expect(url).toBe("gs://lucida-fixtures/sampled-collection-01.zarr");
    expect(diagnostic.warning).toBe(true);
    expect(diagnostic).toStrictEqual(expectedWarningDiagnostic);
  });

  it("open_dataset_succeeded: requester-only success envelope", () => {
    // The web treats the broadcast `command_broadcast(dataset_opened)` as
    // authoritative and has no dispatch arm for this envelope, but it still
    // crosses the socket to the web session — lock its shape.
    const raw = fixtureRaw("session/server_open_dataset_succeeded.json");
    COVERED_FIXTURES.add("session/server_open_dataset_succeeded.json");
    expect(JSON.parse(raw)).toStrictEqual({
      type: "open_dataset_succeeded",
      request_id: "web-7d2f45aa",
      url: "gs://lucida-fixtures/kidney-multiplex.zarr",
      seq: 43,
      opened: expectedDatasetOpenedSingle,
      diagnostic: {
        stage: "complete",
        source_url: "gs://lucida-fixtures/kidney-multiplex.zarr",
        workspace_dataset_id: "wds-0f3a",
        dataset_source_id: "source-9b31",
        message: "dataset opened",
      },
    });
  });

  it("open_dataset_failed carries error + failure diagnostic", () => {
    const raw = fixtureRaw("session/server_open_dataset_failed.json");
    COVERED_FIXTURES.add("session/server_open_dataset_failed.json");
    expect(JSON.parse(raw)).toStrictEqual({
      type: "open_dataset_failed",
      request_id: "web-81c09b",
      url: "gs://lucida-fixtures/missing.zarr",
      error: "object not found",
      diagnostic: {
        stage: "backend_open",
        kind: "missing_object",
        retryable: true,
        message: "object not found",
        detail: "gs://lucida-fixtures/missing.zarr/.zattrs returned 404",
      },
    });

    const onOpenDatasetFailed = vi.fn();
    const { ws } = openBridge({ onOpenDatasetFailed });
    deliver(ws, raw);
    expect(onOpenDatasetFailed).toHaveBeenCalledWith(
      // The open's own id comes back with the failure: the trace closes a
      // failed open's bracket exactly as it closes a successful one's.
      "web-81c09b",
      "gs://lucida-fixtures/missing.zarr",
      "object not found",
    );
  });

  it("dataset_health resolves a pending requestDatasetHealth with full stats", async () => {
    const raw = fixtureRaw("session/server_dataset_health.json");
    COVERED_FIXTURES.add("session/server_dataset_health.json");
    const envelope = JSON.parse(raw) as {
      type: string;
      request_id: string;
      datasets: DatasetSourceHealth[];
    };
    expect(envelope).toStrictEqual({
      type: "dataset_health",
      request_id: "web-health-55e0",
      datasets: [expectedSourceHealth],
    });

    const { bridge, ws } = openBridge();
    const pending = bridge.requestDatasetHealth("wds-0f3a");
    const sent = lastSent(ws) as { request_id: string };
    // Answer the live request with the fixture payload (ids must match for
    // the bridge to resolve the right pending promise).
    deliver(ws, JSON.stringify({ ...envelope, request_id: sent.request_id }));
    await expect(pending).resolves.toStrictEqual([expectedSourceHealth]);
  });

  it("asset_catalog_update: delta reaches the handler and the web AssetCatalog mirror", () => {
    const raw = fixtureRaw("session/server_asset_catalog_update.json");
    COVERED_FIXTURES.add("session/server_asset_catalog_update.json");
    expect(JSON.parse(raw)).toStrictEqual({
      type: "asset_catalog_update",
      dataset_id: "wds-0f3a",
      delta: expectedAssetCatalogDelta,
    });

    const onAssetCatalogUpdate = vi.fn();
    const { ws } = openBridge({ onAssetCatalogUpdate });
    deliver(ws, raw);
    expect(onAssetCatalogUpdate).toHaveBeenCalledTimes(1);
    const [datasetId, deltaJson] = onAssetCatalogUpdate.mock.calls[0];
    expect(datasetId).toBe("wds-0f3a");
    const delta: WireAssetCatalogDelta = JSON.parse(deltaJson);
    expect(delta).toStrictEqual(expectedAssetCatalogDelta);

    // Feed the delta through the real web mirror, as renderLoop does.
    const wasm = { apply_asset_catalog_delta: vi.fn() };
    const catalog = new AssetCatalog(wasm);
    catalog.applyDelta(datasetId, delta);
    expect(
      JSON.parse(wasm.apply_asset_catalog_delta.mock.calls[0][0]),
    ).toStrictEqual({ dataset_id: "wds-0f3a", delta: expectedAssetCatalogDelta });
    const entity = catalog.snapshot().byEntity.get("img-0");
    expect(entity).toBeDefined();
    expect([...entity!.kinds].sort()).toStrictEqual(["GroupProxy3D", "TileProxy3D"]);
    expect(entity!.footprints.get("GroupProxy3D")).toStrictEqual({
      kind: "GroupProxy3D",
      dims: [50, 256, 256],
      bytes: 6553600,
    });
  });

  it("generated_availability_update: delta reaches the handler intact", () => {
    const raw = fixtureRaw("session/server_generated_availability_update.json");
    COVERED_FIXTURES.add("session/server_generated_availability_update.json");
    expect(JSON.parse(raw)).toStrictEqual({
      type: "generated_availability_update",
      dataset_id: "wds-0f3a",
      delta: expectedGeneratedDelta,
    });

    const onGeneratedAvailabilityUpdate = vi.fn();
    const { ws } = openBridge({ onGeneratedAvailabilityUpdate });
    deliver(ws, raw);
    expect(onGeneratedAvailabilityUpdate).toHaveBeenCalledTimes(1);
    const [datasetId, deltaJson] = onGeneratedAvailabilityUpdate.mock.calls[0];
    expect(datasetId).toBe("wds-0f3a");
    expect(JSON.parse(deltaJson)).toStrictEqual(expectedGeneratedDelta);
  });

  it("generated_chunk_status", () => {
    const raw = fixtureRaw("session/server_generated_chunk_status.json");
    COVERED_FIXTURES.add("session/server_generated_chunk_status.json");
    expect(JSON.parse(raw)).toStrictEqual({
      type: "generated_chunk_status",
      dataset_id: "wds-0f3a",
      image_id: "multiscale-0",
      key: "2/1/0/1/0/0",
      status: "failed_transient",
      message: "source read timed out",
    });

    const onGeneratedChunkStatus = vi.fn();
    const { ws } = openBridge({ onGeneratedChunkStatus });
    deliver(ws, raw);
    expect(onGeneratedChunkStatus).toHaveBeenCalledWith(
      "wds-0f3a",
      "multiscale-0",
      "2/1/0/1/0/0",
      "failed_transient",
      "source read timed out",
    );
  });

  it("source_chunk_status reaches the handler and rejects a pending fetch as permanent", async () => {
    const raw = fixtureRaw("session/server_source_chunk_status.json");
    COVERED_FIXTURES.add("session/server_source_chunk_status.json");
    expect(JSON.parse(raw)).toStrictEqual({
      type: "source_chunk_status",
      dataset_id: "wds-0f3a",
      image_id: "multiscale-0",
      key: "0/1/0/1/0/0",
      status: "failed_permanent",
      message: "access to the dataset store was denied",
    });

    const onSourceChunkStatus = vi.fn();
    const { ws } = openBridge({ onSourceChunkStatus });
    deliver(ws, raw);
    expect(onSourceChunkStatus).toHaveBeenCalledWith(
      "wds-0f3a",
      "multiscale-0",
      "0/1/0/1/0/0",
      "failed_permanent",
      "access to the dataset store was denied",
    );

    // Consumption path: the same frame's fields drive the content source,
    // which must fail the pending fetch permanently (never a transient
    // timeout) so the delivery-failure streak can count a dead source.
    const source = new ProxiedContentSource(() => {});
    source.registerImage("multiscale-0", { Raw: { data_type: "Uint16" } });
    const pending = source.fetch(
      { datasetId: "wds-0f3a", imageId: "multiscale-0", chunkKey: "0/1/0/1/0/0" },
      new AbortController().signal,
    );
    const [datasetId, imageId, key, status, message] = onSourceChunkStatus.mock.calls[0];
    source.handleSourceChunkStatus(datasetId, imageId, key, status, message);
    await expect(pending).rejects.toMatchObject({
      name: "FetchError",
      kind: "permanent",
      message: expect.stringContaining("access to the dataset store was denied"),
    });
  });

  it("timing_batch reaches the recorder's table as columns", () => {
    const raw = fixtureRaw("session/server_timing_batch.json");
    COVERED_FIXTURES.add("session/server_timing_batch.json");
    expect(JSON.parse(raw)).toStrictEqual({
      type: "timing_batch",
      batch: {
        dropped: 3,
        rid: [2558, 2559, 0],
        request_id: [null, null, "web-open-4c1a"],
        family: ["chunk", "asset", "metadata_read"],
        metadata_phase: [null, null, "backend_read"],
        // A metadata read has no slot in the phase enum, so it states its
        // span here and leaves every phase column unset.
        dispatch_offset_us: [0, 0, 1204],
        duration_us: [0, 0, 63441],
        outcome: ["delivered", "not_ready", "delivered"],
        arrival_us: [142, 96, PHASE_UNSET],
        binding_lookup_us: [37, 41, PHASE_UNSET],
        dispatch_us: [88, 74, PHASE_UNSET],
        cache_lookup_us: [2, 3, PHASE_UNSET],
        // The second row never touched the source store, so its store
        // phases are unset rather than zero.
        permit_wait_us: [3100000, PHASE_UNSET, PHASE_UNSET],
        backend_read_us: [211400, PHASE_UNSET, PHASE_UNSET],
        coalesced_wait_us: [PHASE_UNSET, PHASE_UNSET, PHASE_UNSET],
        decompress_us: [4512, PHASE_UNSET, PHASE_UNSET],
        slice_encode_us: [903, PHASE_UNSET, PHASE_UNSET],
        handoff_us: [61, 55, PHASE_UNSET],
        coalesced_onto: [LABEL_NONE, LABEL_NONE, LABEL_NONE],
      },
    });

    const onTimingBatch = vi.fn();
    const { ws } = openBridge({ onTimingBatch });
    deliver(ws, raw);

    expect(onTimingBatch).toHaveBeenCalledTimes(1);
    const [batch, generation] = onTimingBatch.mock.calls[0];
    // The generation is the browser's, stamped on arrival: the server has no
    // idea connections are numbered.
    expect(generation).toBe(1);

    // Consumption path: the columns copy straight into the table.
    const table = new ServerRowTable();
    table.ingest(batch, generation, () => true);
    expect(table.droppedCount).toBe(3);
    expect(
      table
        .serialise()
        .map(row => [
          row.rid,
          row.family,
          serverRowTotalUs(row.phases),
          row.durationUs,
          row.requestId,
          row.metadataPhase,
        ]),
    ).toEqual([
      [2558, "chunk", 142 + 37 + 88 + 2 + 3100000 + 211400 + 4512 + 903 + 61, 0, null, null],
      [2559, "asset", 96 + 41 + 74 + 3 + 55, 0, null, null],
      // The metadata read keys on the open, not on a correlation label, and
      // its span is in its own column rather than in any phase.
      [0, "metadata-read", 0, 63441, "web-open-4c1a", "backend-read"],
    ]);
  });

  it("bookmark_changed fans out to handler and subscribers", () => {
    const raw = fixtureRaw("session/server_bookmark_changed.json");
    COVERED_FIXTURES.add("session/server_bookmark_changed.json");
    expect(JSON.parse(raw)).toStrictEqual({
      type: "bookmark_changed",
      id: "bookmark-31f7",
      action: "updated",
      dataset_urls: [
        "gs://lucida-fixtures/kidney-multiplex.zarr",
        "gs://lucida-fixtures/screening-collection-01.zarr",
      ],
    });

    const onBookmarkChanged = vi.fn();
    const listener = vi.fn();
    const { bridge, ws } = openBridge({ onBookmarkChanged });
    bridge.subscribeBookmarkChanged(listener);
    deliver(ws, raw);
    const expectedArgs = [
      "bookmark-31f7",
      "updated",
      [
        "gs://lucida-fixtures/kidney-multiplex.zarr",
        "gs://lucida-fixtures/screening-collection-01.zarr",
      ],
    ];
    expect(onBookmarkChanged).toHaveBeenCalledWith(...expectedArgs);
    expect(listener).toHaveBeenCalledWith(...expectedArgs);
  });

  it("workspace_archived reaches the handler (and tears the bridge down)", () => {
    const raw = fixtureRaw("session/server_workspace_archived.json");
    COVERED_FIXTURES.add("session/server_workspace_archived.json");
    expect(JSON.parse(raw)).toStrictEqual({
      type: "workspace_archived",
      workspace_id: "workspace-2ac8",
    });

    const onWorkspaceArchived = vi.fn();
    const { ws } = openBridge({ onWorkspaceArchived });
    deliver(ws, raw);
    expect(onWorkspaceArchived).toHaveBeenCalledWith("workspace-2ac8");
  });
});

// ---------------------------------------------------------------------------
// Client → server envelopes, produced by the real Bridge senders
// ---------------------------------------------------------------------------

/** Every web-live document command, authored as its production producer
 *  builds it (file references per entry), paired with its envelope fixture.
 *  `Bridge.sendCommand` wraps each in `{ type: "command", command }`. */
const commandCases: [string, string, Record<string, unknown>][] = [
  [
    "add_annotation",
    "session/client_command_add_annotation.json",
    // SliceViewer.tsx / VolumeViewer.tsx draw path, with the captured view
    // from savedView/buildAnnotationView.ts.
    {
      type: "add_annotation",
      dataset_id: "wds-0f3a",
      id: "pin-4c1d",
      position: [310, 455.5],
      end: [420, 505.5],
      z: 12.5,
      t: 2,
      c: 1,
      author: "ada@example",
      kind: "box",
      view: expectedPinView,
    },
  ],
  [
    "move_annotation (reshape)",
    "session/client_command_move_annotation.json",
    // annotationInteraction.ts emitMoveAnnotation — the one construction site
    // for every overlay move/reshape; a reshape carries both vertices.
    {
      type: "move_annotation",
      dataset_id: "wds-0f3a",
      id: "pin-4c1d",
      position: [355, 470.5],
      end: [465, 520.5],
      z: 12.5,
    },
  ],
  [
    "remove_annotation",
    "session/client_command_remove_annotation.json",
    // ThreadPopover.tsx confirmDeletePin.
    { type: "remove_annotation", dataset_id: "wds-0f3a", id: "pin-4c1d" },
  ],
  [
    "add_comment",
    "session/client_command_add_comment.json",
    // ThreadPopover.tsx addComment (author is String(myId)).
    {
      type: "add_comment",
      dataset_id: "wds-0f3a",
      annotation_id: "pin-4c1d",
      id: "comment-92",
      author: "7",
      text: "agreed — recheck at t=3",
    },
  ],
  [
    "remove_comment",
    "session/client_command_remove_comment.json",
    // ThreadPopover.tsx remove-own-comment.
    {
      type: "remove_comment",
      dataset_id: "wds-0f3a",
      annotation_id: "pin-4c1d",
      id: "comment-92",
    },
  ],
  [
    "edit_comment",
    "session/client_command_edit_comment.json",
    // ThreadPopover.tsx saveEdit.
    {
      type: "edit_comment",
      dataset_id: "wds-0f3a",
      annotation_id: "pin-4c1d",
      id: "comment-91",
      text: "glomerulus boundary confirmed",
    },
  ],
  [
    "register_layout",
    "session/client_command_register_layout.json",
    // pipeline/layoutRegistry.ts register().
    {
      type: "register_layout",
      dataset_id: "wds-0f3a",
      layout: expectedGridLayout,
    },
  ],
  [
    "set_active_layout",
    "session/client_command_set_active_layout.json",
    // pipeline/layoutRegistry.ts setActive() / savedView/applier.ts.
    {
      type: "set_active_layout",
      dataset_id: "wds-0f3a",
      layout_id: "layout-grid",
    },
  ],
  [
    "remove_dataset",
    "session/client_command_remove_dataset.json",
    // hooks/useDatasetSettings.ts handleRemoveLayer.
    { type: "remove_dataset", id: "wds-0f3a" },
  ],
  [
    "rename_dataset",
    "session/client_command_rename_dataset.json",
    // hooks/useDatasetSettings.ts handleLayerRename.
    { type: "rename_dataset", id: "wds-0f3a", name: "kidney multiplex (deconvolved)" },
  ],
  [
    "apply_asset_catalog_delta",
    "session/client_command_apply_asset_catalog_delta.json",
    {
      type: "apply_asset_catalog_delta",
      dataset_id: "wds-0f3a",
      delta: expectedAssetCatalogDelta,
    },
  ],
];

describe("wire goldens: client messages through Bridge senders", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(commandCases)(
    "sendCommand wraps %s in the command envelope",
    (_name, rel, command) => {
      const { bridge, ws } = openBridge();
      bridge.sendCommand(JSON.stringify(command));
      expect(lastSent(ws)).toStrictEqual(coveredFixture(rel));
    },
  );

  it("sendPresence merges the type tag into the presence body", () => {
    const { bridge, ws } = openBridge();
    bridge.sendPresence(
      JSON.stringify({
        camera: expectedSliceCamera,
        view: expectedView,
        display: expectedDisplay,
      }),
    );
    expect(lastSent(ws)).toStrictEqual(coveredFixture("session/client_presence.json"));
  });

  it("sendCursor emits the cursor envelope", () => {
    const { bridge, ws } = openBridge();
    bridge.sendCursor([412, 233.5]);
    vi.advanceTimersByTime(60); // trailing-edge throttle
    expect(lastSent(ws)).toStrictEqual(coveredFixture("session/client_cursor.json"));
  });

  it("sendFollow emits the follow envelope", () => {
    const { bridge, ws } = openBridge();
    bridge.sendFollow(9);
    expect(lastSent(ws)).toStrictEqual(coveredFixture("session/client_follow.json"));
  });

  it("sendDatasetPresence merges the type tag into the layer-presence body", () => {
    const { bridge, ws } = openBridge();
    bridge.sendDatasetPresence(
      JSON.stringify({
        dataset_order: ["wds-0f3a"],
        dataset_settings: { "wds-0f3a": expectedDisplaySettings },
      }),
    );
    vi.advanceTimersByTime(250); // trailing-edge throttle
    expect(lastSent(ws)).toStrictEqual(
      coveredFixture("session/client_dataset_presence.json"),
    );
  });

  it("steer: envelope shape (no web sender today — other clients steer)", () => {
    expect(coveredFixture("session/client_steer.json")).toStrictEqual({
      type: "steer",
      client: 3,
    });
  });

  it("sendOpenRemoteDataset emits the open envelope with a fresh request id", () => {
    const { bridge, ws } = openBridge();
    bridge.sendOpenRemoteDataset("gs://lucida-fixtures/kidney-multiplex.zarr");
    const sent = lastSent(ws) as { request_id: string };
    expect(sent.request_id).toMatch(/^web-/);
    const golden = coveredFixture("session/client_open_remote_dataset.json") as {
      request_id: string;
    };
    expect(sent).toStrictEqual({ ...golden, request_id: sent.request_id });
  });

  it("requestDatasetHealth emits the health request envelope", () => {
    const { bridge, ws } = openBridge();
    void bridge.requestDatasetHealth("wds-0f3a").catch(() => {});
    const sent = lastSent(ws) as { request_id: string };
    expect(sent.request_id).toMatch(/^web-health-/);
    const golden = coveredFixture("session/client_dataset_health.json") as {
      request_id: string;
    };
    expect(sent).toStrictEqual({ ...golden, request_id: sent.request_id });
  });

  it("sendDatasetRetry emits the retry envelope", () => {
    const { bridge, ws } = openBridge();
    bridge.sendDatasetRetry("wds-0f3a");
    const sent = lastSent(ws) as { request_id: string };
    expect(sent.request_id).toMatch(/^web-retry-/);
    const golden = coveredFixture("session/client_dataset_retry.json") as {
      request_id: string;
    };
    expect(sent).toStrictEqual({ ...golden, request_id: sent.request_id });
  });

  it("a persistent seq gap in the broadcast stream emits the request_snapshot envelope", () => {
    // Producer-level lock through the real production trigger: the Bridge
    // itself sends `request_snapshot` when a `command_broadcast` arrives
    // with a seq past the last applied one and the hole outlives the
    // reorder-grace window (i.e. real server-side broadcast loss, not
    // benign out-of-order delivery).
    const { ws } = openBridge();
    deliver(
      ws,
      JSON.stringify({ type: "snapshot", seq: 42, document: {}, peers: [], your_id: 7 }),
    );
    deliver(
      ws,
      JSON.stringify({
        type: "command_broadcast",
        seq: 45,
        command: { type: "remove_dataset", id: "wds-0f3a" },
      }),
    );
    vi.advanceTimersByTime(250); // past the reorder-grace window
    expect(lastSent(ws)).toStrictEqual(
      coveredFixture("session/client_request_snapshot.json"),
    );
  });

  it("sendViewerInterest wraps the tick coordinator's hint verbatim", () => {
    const { bridge, ws } = openBridge();
    bridge.sendViewerInterest(expectedInterestHint);
    expect(lastSent(ws)).toStrictEqual({
      type: "viewer_interest",
      interest: expectedInterestHint,
    });
    // The Rust hint additionally carries an optional `client_id` (server
    // tolerates its absence via a serde default; the web never sends it).
    expect(coveredFixture("session/client_viewer_interest.json")).toStrictEqual({
      type: "viewer_interest",
      interest: { client_id: null, ...expectedInterestHint },
    });
  });
});

// ---------------------------------------------------------------------------
// Request envelopes produced by the real ProxiedContentSource
// ---------------------------------------------------------------------------

describe("wire goldens: content-source request envelopes", () => {
  /**
   * Both envelopes come off ONE source, in order, because the goldens carry
   * consecutive correlation labels from one shared counter. Two sources
   * would each mint `rid: 0` and the shared-counter half of the contract
   * would go untested.
   */
  it("fetch() then fetchProxy() send the labelled request envelopes", async () => {
    const sent: string[] = [];
    const source = new ProxiedContentSource((json) => sent.push(json));
    source.registerImage("multiscale-0", { Zstd: { data_type: "Uint16" } });

    const chunkController = new AbortController();
    const pendingChunk = source.fetch(
      { datasetId: "wds-0f3a", imageId: "multiscale-0", chunkKey: "1/2/1/12/3/4" },
      chunkController.signal,
    );

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toStrictEqual(
      coveredFixture("session/chunk_request.json"),
    );

    const assetController = new AbortController();
    const pendingAsset = source.fetchProxy(
      {
        datasetId: "wds-collection-77",
        entityId: "tile-A1-f0",
        kind: "TileProxy3D",
        t: 0,
        c: 2,
      },
      assetController.signal,
    );

    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1])).toStrictEqual(
      coveredFixture("session/asset_request.json"),
    );

    chunkController.abort();
    assetController.abort();
    await expect(pendingChunk).rejects.toThrow(/aborted/i);
    await expect(pendingAsset).rejects.toThrow(/aborted/i);
  });
});

// ---------------------------------------------------------------------------
// Dataset-open payloads through the manifest mirrors
// ---------------------------------------------------------------------------

describe("wire goldens: dataset-open payloads", () => {
  it("single-image DatasetOpened matches the manifestTypes mirror", () => {
    const opened = coveredFixture(
      "dataset-open/dataset_opened_single.json",
    ) as WireDatasetOpened;
    expect(opened).toStrictEqual(expectedDatasetOpenedSingle);

    // The decode path the content source uses for every chunk response.
    const proxied = "Proxied" in opened.fetch ? opened.fetch.Proxied : null;
    expect(proxied).not.toBeNull();
    expect(extractDataType(proxied!.images[0].wire_format)).toBe("Uint16");
    expect(dtypeMax(extractDataType(proxied!.images[0].wire_format))).toBe(65535);
    expect(extractDataType(proxied!.images[1].wire_format)).toBe("Uint32");
  });

  it("collection DatasetOpened matches the manifestTypes mirror", () => {
    const opened = coveredFixture(
      "dataset-open/dataset_opened_collection.json",
    ) as WireDatasetOpenedCollection;
    expect(opened).toStrictEqual(expectedDatasetOpenedCollection);

    // Resolution as sessionController performs it on every ingest: the
    // shared multiscale table, wire-format table, and compact translation
    // edges expand into effective per-image/per-edge values.
    const manifest = resolveDatasetManifest(opened.manifest);
    // The format_version marker is a wire-level detail; resolution drops it.
    expect("format_version" in manifest).toBe(false);
    expect(manifest.images).toHaveLength(2);
    for (const image of manifest.images) {
      expect(image.multiscale).toStrictEqual(expectedCollectionSharedMultiscale);
    }
    // Table-resolved images share ONE multiscale object (copy-on-write
    // downstream), so a 20k-tile manifest does not fan out 20k copies.
    expect(manifest.images[0].multiscale).toBe(manifest.images[1].multiscale);
    expect(manifest.transforms).toStrictEqual([
      { from: "tile-A1-f0", to: "group-A1", transform: { matrix: IDENTITY_TRANSLATION(0, 0) } },
      {
        from: "tile-A1-f1",
        to: "group-A1",
        transform: { matrix: IDENTITY_TRANSLATION(2048, 1024) },
      },
    ]);

    // Collection-kind discrimination as the web performs it.
    expect(typeof manifest.kind).not.toBe("string");
    if (typeof manifest.kind !== "string") {
      expect(manifest.kind.Collection.rows).toStrictEqual(["A", "B"]);
      expect(manifest.kind.Collection.columns).toStrictEqual(["1", "2", "3"]);
      expect(manifest.kind.Collection.positioning_mode).toBe("Explicit");
      expect(manifest.kind.Collection.has_explicit_positions).toBe(true);
    }

    const fetch = resolveFetchSource(opened.fetch);
    const proxied = "Proxied" in fetch ? fetch.Proxied : null;
    expect(proxied!.images).toHaveLength(2);
    expect(proxied!.images[0].image_id).toBe("tile-A1-f0-image");
    expect(extractDataType(proxied!.images[0].wire_format)).toBe("Uint8");
    expect(extractDataType(proxied!.images[1].wire_format)).toBe("Uint8");
  });

  it("inline (single / historical) payloads resolve as a pass-through", () => {
    // Persisted documents and single-image manifests carry inline metadata;
    // the resolvers must hand them through unchanged.
    const opened = fixture(
      "dataset-open/dataset_opened_single.json",
    ) as WireDatasetOpened;
    expect(resolveDatasetManifest(opened.manifest)).toStrictEqual(expectedManifestSingle);
    expect(resolveFetchSource(opened.fetch)).toStrictEqual(expectedFetchSingle);
  });

  it("FetchSource variants match the externally tagged mirror", () => {
    expect(coveredFixture("dataset-open/fetch_source_proxied.json")).toStrictEqual(
      expectedFetchSingle,
    );

    const direct = coveredFixture("dataset-open/fetch_source_direct.json") as FetchSource;
    expect(direct).toStrictEqual({
      Direct: {
        images: [
          {
            image_id: "multiscale-0",
            wire_format: { Zstd: { data_type: "Uint16" } },
            levels: [
              { level_index: 0, path: "kidney-multiplex.zarr/0" },
              { level_index: 1, path: "kidney-multiplex.zarr/1" },
            ],
            store_prefix: "gs://lucida-fixtures",
          },
        ],
      },
    });

    const local = coveredFixture("dataset-open/fetch_source_local.json") as FetchSource;
    expect(local).toStrictEqual({
      Local: {
        images: [
          {
            image_id: "multiscale-0",
            wire_format: { Raw: { data_type: "Float32" } },
            levels: [{ level_index: 0, path: "/data/kidney-multiplex.zarr/0" }],
            store_prefix: null,
          },
        ],
      },
    });
    if ("Local" in local) {
      expect(extractDataType(local.Local.images[0].wire_format)).toBe("Float32");
    }
  });
});

// ---------------------------------------------------------------------------
// Generated-availability payloads through the real catalog
// ---------------------------------------------------------------------------

describe("wire goldens: generated availability", () => {
  it("snapshot fixture drives the catalog's counters and per-chunk lookups", () => {
    const snapshot = coveredFixture(
      "generated/availability_snapshot.json",
    ) as WireGeneratedAvailabilitySnapshot;
    expect(snapshot).toStrictEqual(expectedGeneratedSnapshot);

    const catalog = new GeneratedAvailabilityCatalog();
    catalog.applySnapshot("wds-0f3a", snapshot);

    // One counter bucket per status variant — locks the status vocabulary.
    expect(catalog.statusCounts("wds-0f3a")).toStrictEqual({
      levels: 2,
      totalChunks: 5,
      ready: 1,
      pending: 1,
      unavailable: 1,
      failed: 2,
      failedTransient: 1,
      failedPermanent: 1,
    });
    expect(catalog.statusFor("wds-0f3a", "multiscale-0", 2, "2/1/0/1/0/0")).toStrictEqual({
      image_id: "multiscale-0",
      level_index: 2,
      key: "2/1/0/1/0/0",
      status: "failed_transient",
      message: "source read timed out",
    });
  });

  it("delta fixture upserts through the catalog", () => {
    const delta = coveredFixture(
      "generated/availability_delta.json",
    ) as WireGeneratedAvailabilityDelta;
    expect(delta).toStrictEqual(expectedGeneratedDelta);

    const catalog = new GeneratedAvailabilityCatalog();
    catalog.applySnapshot(
      "wds-0f3a",
      fixture("generated/availability_snapshot.json") as WireGeneratedAvailabilitySnapshot,
    );
    catalog.applyDelta("wds-0f3a", delta);
    expect(catalog.statusFor("wds-0f3a", "multiscale-0", 2, "2/0/0/1/0/0")).toStrictEqual({
      image_id: "multiscale-0",
      level_index: 2,
      key: "2/0/0/1/0/0",
      status: "ready",
      message: null,
    });
  });

  it("levels merge into a manifest via the real normalization path", () => {
    const snapshot = fixture(
      "generated/availability_snapshot.json",
    ) as WireGeneratedAvailabilitySnapshot;

    // A manifest as it looks before generation finishes: no generated level.
    const base = structuredClone(expectedManifestSingle);
    const multiscale = base.images[0].multiscale;
    multiscale.levels = multiscale.levels.filter((level) => level.level_index !== 2);
    multiscale.generated_levels = [];
    multiscale.coarse_level_index = null;

    const merged = mergeGeneratedAvailabilityIntoManifest(base, snapshot);
    const mergedMultiscale = merged.images[0].multiscale;
    expect(mergedMultiscale.levels).toHaveLength(3);
    expect(mergedMultiscale.levels[2]).toStrictEqual(
      expectedManifestSingle.images[0].multiscale.levels[2],
    );
    expect(mergedMultiscale.coarse_level_index).toBe(2);
    expect(mergedMultiscale.generated_levels).toStrictEqual(
      expectedManifestSingle.images[0].multiscale.generated_levels,
    );
    // The label-image level targets an image absent from `images` and must
    // not invent one.
    expect(merged.images).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Enum vocabulary against the production TS unions
// ---------------------------------------------------------------------------

describe("wire goldens: enum vocabulary", () => {
  it("every wire enum's variants match the web's string vocabulary", () => {
    // Where a production TS union or const exists, the expected list is
    // typed with it, so widening/renaming a variant requires touching the
    // production vocabulary too, not just this test.
    const clipModes: NonNullable<ArcballCamera["clip_mode"]>[] = ["plane", "sphere"];
    const blendModes: BlendMode[] = ["alpha", "additive", "max"];
    const renderModes: RenderMode[] = ["translucent", "max_intensity"];
    const entityKinds: Entity["kind"][] = ["Image", "Group", "Tile"];
    const proxyKinds: ProxyKind[] = ["GroupProxy3D", "TileProxy3D"];
    const openStages: DatasetOpenStage[] = [
      "request_received",
      "authorization",
      "source_lookup",
      "backend_open",
      "metadata_import",
      "binding_build",
      "generated_coarse_planning",
      "workspace_persist",
      "broadcast",
      "complete",
    ];
    const healthStatuses: DatasetHealthStatus[] = ["healthy", "degraded", "unavailable"];
    const chunkStatuses: GeneratedChunkStatus[] = [
      "pending",
      "unavailable",
      "failed_transient",
      "failed_permanent",
      "ready",
    ];
    const bookmarkActions: BookmarkAction[] = ["created", "updated", "deleted"];
    const annotationKinds: WireAnnotation["kind"][] = ["point", "line", "box"];

    expect(coveredFixture("vocab/enum_vocabulary.json")).toStrictEqual({
      colormaps: [...COLORMAP_NAMES],
      blend_modes: blendModes,
      render_modes: renderModes,
      clip_modes: clipModes,
      annotation_kinds: annotationKinds,
      axis_kinds: ["Time", "Channel", "Space"],
      entity_kinds: entityKinds,
      data_types: ["Uint8", "Uint16", "Uint32", "Float32", "Float64"],
      positioning_modes: ["Explicit", "Derived"],
      proxy_kinds: proxyKinds,
      dataset_open_stages: openStages,
      // No TS union today: the DebugPanel renders the kind string verbatim.
      dataset_open_failure_kinds: [
        "authorization",
        "session_closed",
        "workspace_lookup",
        "unsupported_scheme",
        "local_path",
        "missing_object",
        "permission",
        "cloud_configuration",
        "http",
        "storage_backend",
        "unsupported_codec",
        "unsupported_layout",
        "malformed_metadata",
        "missing_metadata",
        "import",
        "persistence",
        "internal",
      ],
      dataset_health_statuses: healthStatuses,
      generated_chunk_statuses: chunkStatuses,
      generated_level_roles: ["coarse"],
      bookmark_actions: bookmarkActions,
      // Strings the tick coordinator emits (pipeline/tickCoordinator.ts).
      viewer_interest_modes: ["slice", "volume"],
      viewer_interaction_modes: ["idle", "panning", "zooming", "scrubbing"],
      viewer_interest_lanes: ["visible", "predicted", "background"],
    });
  });
});

// ---------------------------------------------------------------------------
// Inventory: every committed fixture is asserted above
// ---------------------------------------------------------------------------

describe("wire goldens: fixture inventory", () => {
  it("every fixture file has web-side coverage", () => {
    // Runs last (vitest executes tests sequentially within a file):
    // a fixture added on the Rust side without an assertion here fails.
    expect([...COVERED_FIXTURES].sort()).toStrictEqual(allFixtureFiles());
  });
});
