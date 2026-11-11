// Volume ray marching shader for OME-Zarr 3D rendering

// Matches DESCRIPTOR_MAX_LEVEL_SOURCES in descriptor/layout.ts: one level pool binding per slot.
const MAX_LEVEL_SOURCES: u32 = 4u;
// The indirection sentinel, and the sample value for "nothing resident here".
const MISS: u32 = 0xFFFFFFFFu;
// The indirection entry and sample value for a chunk the source failed for
// good (INDIRECTION_FAILED in remap.ts). A ray through one draws the hatch.
const FAILED: u32 = 0xFFFFFFFEu;

struct Uniforms {
  invViewProj: mat4x4f,                // offset 0   (64 bytes)
  cameraPos: vec4f,                    // offset 64  (16 bytes)
  // stepInfo.x=opacityScale (translucent compositing constant),
  // stepInfo.y=renderMode (0=translucent,1=MIP),
  // stepInfo.z=render pixels per CSS pixel, stepInfo.w=march step scale
  // (level steps per ray-march step; 1 except while a gesture draws).
  stepInfo: vec4f,                     // offset 80  (16 bytes)
  levelAtlasSlotDims: array<vec4u, 4>, // offset 96  (64 bytes) — xyz=slots per axis, one per level pool binding
  coarseAtlasSlotDims: vec4u,          // offset 160 (16 bytes) — xyz=slots per axis
  viewProj: mat4x4f,                   // offset 176 (64 bytes)
  camForward: vec4f,                   // offset 240 (16 bytes) — xyz=camera forward dir
  clipParams: vec4f,                   // offset 256 (16 bytes) — x=clipDist, y=clipMode (0=plane,1=sphere), zw=reserved
  // total = 272 bytes
};

struct EntityRef { index: vec4u }; // x = entity index

// Layout matches descriptor/layout.ts.
struct ChunkTierSource {
  valid: u32,
  level: u32,
  indirectionOffset: u32,
  poolIndex: u32,
  gridDims: vec3<u32>,
  _pad1: u32,
  chunkDims: vec3<u32>,
  _pad2: u32,
  levelDims: vec3<u32>,
  _pad3: u32,
};

struct EntityDescriptor {
  modelMatrix: mat4x4<f32>,
  invModelMatrix: mat4x4<f32>,
  channelMask: u32,
  sampleFormat: u32,
  contrastMin: f32,
  contrastMax: f32,
  gamma: f32,
  opacity: f32,
  colormapLutIndex: u32,
  levelSourceCount: u32,
  colormapMode: u32,
  labelOpacity: f32,
  _pad0: u32,
  _pad1: u32,
  levelSources: array<ChunkTierSource, 4>,
  coarseSource: ChunkTierSource,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var lutTex: texture_2d<f32>;
@group(0) @binding(2) var lutSampler: sampler;
@group(0) @binding(3) var coarseTex: texture_3d<u32>;
@group(0) @binding(4) var<storage, read> coarseIndirection: array<u32>;
// One level pool per resident-level slot. A level source's `poolIndex`
// says which of these it reads; levels of one entity may live in
// different pools when their chunk shapes differ.
@group(0) @binding(5) var levelTex0: texture_3d<u32>;
@group(0) @binding(6) var levelTex1: texture_3d<u32>;
@group(0) @binding(7) var levelTex2: texture_3d<u32>;
@group(0) @binding(8) var levelTex3: texture_3d<u32>;
@group(0) @binding(9) var<storage, read> levelIndirection0: array<u32>;
@group(0) @binding(10) var<storage, read> levelIndirection1: array<u32>;
@group(0) @binding(11) var<storage, read> levelIndirection2: array<u32>;
@group(0) @binding(12) var<storage, read> levelIndirection3: array<u32>;

@group(1) @binding(0) var<storage, read> entityDescriptors: array<EntityDescriptor>;
@group(1) @binding(1) var<uniform> currentEntity: EntityRef;
// Declared label palette for categorical draws: flat [id, packedRgba]
// pairs; `currentEntity.index.y` holds the pair count (0 for intensity).
@group(1) @binding(2) var<storage, read> labelColors: array<u32>;

// Active entity descriptor for the current fragment, populated once at
// the top of fs() and read by sampleWithFallback per ray sample. Reading
// from <private> (register-promoted in practice) instead of the storage
// buffer per sample recovers 3D FPS lost when descriptor data moved out
// of the per-frame uniform.
var<private> activeEntity: EntityDescriptor;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) ndc: vec2f,
};

// Full-screen triangle (3 vertices, no vertex buffer)
@vertex
fn vs(@builtin(vertex_index) vid: u32) -> VSOut {
  var out: VSOut;
  let x = f32(i32(vid & 1u)) * 4.0 - 1.0;
  let y = f32(i32(vid >> 1u)) * 4.0 - 1.0;
  out.pos = vec4f(x, y, 0.0, 1.0);
  out.ndc = vec2f(x, y);
  return out;
}

// Ray-AABB intersection (box from 0 to 1)
fn intersectAABB(ro: vec3f, rd: vec3f) -> vec2f {
  let invDir = 1.0 / rd;
  let t0 = (vec3f(0.0) - ro) * invDir;
  let t1 = (vec3f(1.0) - ro) * invDir;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  let tNear = max(max(tmin.x, tmin.y), tmin.z);
  let tFar = min(min(tmax.x, tmax.y), tmax.z);
  return vec2f(tNear, tFar);
}

// The chunk-grid cell of one source under a local [0,1]^3 position, and
// the texel inside that chunk. Y is flipped for image convention.
struct Cell3D {
  gridIdx: u32,
  localTexel: vec3u,
  chunkDims: vec3u,
};

fn locateCell3D(source: ChunkTierSource, pos: vec3f) -> Cell3D {
  let levelDims = vec3f(f32(source.levelDims.x), f32(source.levelDims.y), f32(source.levelDims.z));
  let chunkDims = source.chunkDims;
  let gridDims = source.gridDims;
  let texCoord = vec3u(
    u32(clamp(i32(pos.x * levelDims.x), 0, i32(levelDims.x) - 1)),
    u32(clamp(i32((1.0 - pos.y) * levelDims.y), 0, i32(levelDims.y) - 1)),
    u32(clamp(i32(pos.z * levelDims.z), 0, i32(levelDims.z) - 1)),
  );
  let chunkCoord = texCoord / chunkDims;
  var cell: Cell3D;
  cell.gridIdx = source.indirectionOffset
    + chunkCoord.z * gridDims.y * gridDims.x
    + chunkCoord.y * gridDims.x
    + chunkCoord.x;
  cell.localTexel = texCoord % chunkDims;
  cell.chunkDims = chunkDims;
  return cell;
}

fn atlasCoord3D(slot: u32, slotDims: vec3u, cell: Cell3D) -> vec3i {
  let slotCoord = vec3u(
    slot % slotDims.x,
    (slot / slotDims.x) % slotDims.y,
    slot / (slotDims.x * slotDims.y),
  );
  return vec3i(slotCoord * cell.chunkDims + cell.localTexel);
}

// Level pool bindings can't be indexed by a runtime value, so each
// level source's `poolIndex` selects its indirection buffer and texture
// here.
fn levelSlotAt(poolIdx: u32, gridIdx: u32) -> u32 {
  switch (poolIdx) {
    case 0u: { return levelIndirection0[gridIdx]; }
    case 1u: { return levelIndirection1[gridIdx]; }
    case 2u: { return levelIndirection2[gridIdx]; }
    default: { return levelIndirection3[gridIdx]; }
  }
}

fn levelTexelAt(poolIdx: u32, coord: vec3i) -> u32 {
  switch (poolIdx) {
    case 0u: { return textureLoad(levelTex0, coord, 0).r; }
    case 1u: { return textureLoad(levelTex1, coord, 0).r; }
    case 2u: { return textureLoad(levelTex2, coord, 0).r; }
    default: { return textureLoad(levelTex3, coord, 0).r; }
  }
}

// A source with no pool bound behind it reads as a miss everywhere.
fn sourceReadable(source: ChunkTierSource, slotDims: vec3u) -> bool {
  return source.valid != 0u && slotDims.x != 0u && slotDims.y != 0u && slotDims.z != 0u;
}

fn sampleLevelVolume(source: ChunkTierSource, pos: vec3f) -> u32 {
  let slotDims = u.levelAtlasSlotDims[source.poolIndex].xyz;
  if (!sourceReadable(source, slotDims)) {
    return MISS;
  }
  let cell = locateCell3D(source, pos);
  let slot = levelSlotAt(source.poolIndex, cell.gridIdx);
  if (slot == MISS || slot == FAILED) {
    return slot;
  }
  return levelTexelAt(source.poolIndex, atlasCoord3D(slot, slotDims, cell));
}

fn sampleCoarseVolume(source: ChunkTierSource, pos: vec3f) -> u32 {
  let slotDims = u.coarseAtlasSlotDims.xyz;
  if (!sourceReadable(source, slotDims)) {
    return MISS;
  }
  let cell = locateCell3D(source, pos);
  let slot = coarseIndirection[cell.gridIdx];
  if (slot == MISS || slot == FAILED) {
    return slot;
  }
  return textureLoad(coarseTex, atlasCoord3D(slot, slotDims, cell), 0).r;
}

// The failed hatch, the same pattern as slice.wgsl, anchored to the screen
// because a ray has no surface to anchor it to.
const FAILED_HATCH_PERIOD_CSS: f32 = 8.0;
const FAILED_HATCH_LINE_CSS: f32 = 1.5;
const FAILED_HATCH_RGB: vec3f = vec3f(0.6, 0.6, 0.6);
const FAILED_HATCH_LINE_ALPHA: f32 = 0.7;
const FAILED_HATCH_FILL_ALPHA: f32 = 0.12;

// Premultiplied hatch color at `px`, in render pixels.
fn failedHatch(px: vec2f, pixelRatio: f32) -> vec4f {
  let ratio = select(pixelRatio, 1.0, pixelRatio <= 0.0);
  let along = (px.x + px.y) / ratio;
  let offLine = abs(fract(along / FAILED_HATCH_PERIOD_CSS + 0.5) - 0.5) * FAILED_HATCH_PERIOD_CSS;
  // Perpendicular distance to the line, in render pixels, for a one-pixel edge.
  let dist = offLine * 0.70710678 * ratio;
  let halfWidth = 0.5 * FAILED_HATCH_LINE_CSS * ratio;
  let onLine = 1.0 - smoothstep(halfWidth - 0.5, halfWidth + 0.5, dist);
  let alpha = mix(FAILED_HATCH_FILL_ALPHA, FAILED_HATCH_LINE_ALPHA, onLine);
  return vec4f(FAILED_HATCH_RGB * alpha, alpha);
}

// How far past a cell boundary a skip lands, in local [0,1] units: well
// under one sample of any level, and far above f32 rounding at t near 1.
const CELL_EXIT_NUDGE: f32 = 1e-5;
// The exit distance of a cell nothing bounds.
const NO_CELL_EXIT: f32 = 1e30;

// The march step for a level: two thirds of one sample spacing along
// its densest axis, in local [0,1] units.
fn stepForDims(dims: vec3<u32>) -> f32 {
  let maxDim = max(max(dims.x, dims.y), dims.z);
  return 1.0 / (f32(max(maxDim, 1u)) * 1.5);
}

// How far along `rd` the ray at `pos` stays inside the chunk cell of
// `source` that `pos` falls in, the cell `locateCell3D` picks. Worked in
// the level's texel space, where the cell is an axis-aligned box.
fn cellExitDistance(source: ChunkTierSource, pos: vec3f, rd: vec3f) -> f32 {
  let levelDims = vec3f(source.levelDims);
  let chunkDims = vec3f(source.chunkDims);
  let texel = vec3f(pos.x * levelDims.x, (1.0 - pos.y) * levelDims.y, pos.z * levelDims.z);
  let dir = vec3f(rd.x * levelDims.x, -rd.y * levelDims.y, rd.z * levelDims.z);
  let lo = floor(clamp(floor(texel), vec3f(0.0), levelDims - 1.0) / chunkDims) * chunkDims;
  let bound = select(lo, lo + chunkDims, dir > vec3f(0.0));
  // An axis the ray runs parallel to never bounds the exit.
  let along = select((bound - texel) / dir, vec3f(NO_CELL_EXIT), abs(dir) < vec3f(1e-12));
  return max(min(min(along.x, along.y), along.z), 0.0);
}

// One ray sample: the value and how far the march may advance from it.
// After a hit that is the answering level's step. After a miss it is at
// least the finest bound level's step, so a resident chunk of it is never
// stepped over, and it reaches the far side of the cells every source
// missed in, since each sample before that would miss in the same cells.
// A view that is still loading is mostly misses, and stepping through
// them one sample at a time made its frames the slowest it draws.
struct VolumeSample {
  value: u32,
  step: f32,
};

// Sampling order: the level sources finest first (the target level,
// then the coarser resident levels), then the coarse tier, then empty.
// Every sample comes from exactly one level; there is no blending. A
// failed chunk answers like a resident one, with FAILED as its value.
//
// An entity that binds no tier at all has no level dims to step by, so it
// misses at the unit step.
fn sampleWithFallback(pos: vec3f, rd: vec3f) -> VolumeSample {
  var out: VolumeSample;
  out.value = MISS;
  out.step = 1.0;

  let count = min(activeEntity.levelSourceCount, MAX_LEVEL_SOURCES);
  if (count == 0u && activeEntity.coarseSource.valid == 0u) {
    return out;
  }
  for (var i = 0u; i < count; i++) {
    let v = sampleLevelVolume(activeEntity.levelSources[i], pos);
    if (v != MISS) {
      out.value = v;
      out.step = stepForDims(activeEntity.levelSources[i].levelDims);
      return out;
    }
  }
  let c = sampleCoarseVolume(activeEntity.coarseSource, pos);
  if (c != MISS) {
    out.value = c;
    out.step = stepForDims(activeEntity.coarseSource.levelDims);
    return out;
  }
  // A source that reads nothing misses everywhere, so it bounds nothing.
  var skip = NO_CELL_EXIT;
  for (var i = 0u; i < count; i++) {
    let source = activeEntity.levelSources[i];
    if (sourceReadable(source, u.levelAtlasSlotDims[source.poolIndex].xyz)) {
      skip = min(skip, cellExitDistance(source, pos, rd));
    }
  }
  if (sourceReadable(activeEntity.coarseSource, u.coarseAtlasSlotDims.xyz)) {
    skip = min(skip, cellExitDistance(activeEntity.coarseSource, pos, rd));
  }
  if (count != 0u) {
    out.step = stepForDims(activeEntity.levelSources[0].levelDims);
  } else {
    out.step = stepForDims(activeEntity.coarseSource.levelDims);
  }
  // Past the boundary, so the next sample lands in the next cell.
  out.step = max(out.step, skip + CELL_EXIT_NUDGE);
  return out;
}

// `EntityDescriptor.sampleFormat`: the texel is the sample's float32 bits,
// not the integer itself. Matches `sampleFormatCode` in dataTypeUtil.ts.
const SAMPLE_F32: u32 = 1u;

// A float texel holding NaN: no value, so it draws nothing. Decoding rewrites
// every NaN to one pattern, so none is the MISS sentinel.
fn texelIsNaN(texel: u32, format: u32) -> bool {
  return format == SAMPLE_F32 && (texel & 0x7FFFFFFFu) > 0x7F800000u;
}

// The value a resident texel holds, in the data's own units, which is what
// the contrast window is in.
fn texelValue(texel: u32, format: u32) -> f32 {
  if (format == SAMPLE_F32) {
    return bitcast<f32>(texel);
  }
  return f32(texel);
}

// Integer avalanche (MurmurHash3 finalizer). Native u32 wrap matches the
// `Math.imul`/`>>> 0` port in labelColors.ts.
fn labelFmix32(value: u32) -> u32 {
  var h = value;
  h = h ^ (h >> 16u);
  h = h * 0x85ebca6bu;
  h = h ^ (h >> 13u);
  h = h * 0xc2b2ae35u;
  h = h ^ (h >> 16u);
  return h;
}

// Categorical color for an integer label id. Fixed-point integer HSV so
// the on-screen color matches labelColors.ts `glasbeyRgb` bit-for-bit
// (locked by labelColorParity.test.ts). Hashes the FULL id — never masked
// to 16 bits — so ids above 65535 stay distinct. Returns rgb in 0..1.
fn labelGlasbey(id: u32) -> vec3f {
  let a = labelFmix32(id);
  let b = labelFmix32(a);

  let hue = a % 1530u;              // six 255-wide sextants
  let sat = 200u + (b % 56u);      // 200..255
  let val = 205u + ((b / 256u) % 51u); // 205..255

  let seg = hue / 255u;
  let off = hue % 255u;

  let p = val * (255u - sat) / 255u;
  let q = val * (255u - (sat * off) / 255u) / 255u;
  let t = val * (255u - (sat * (255u - off)) / 255u) / 255u;

  var rgb = vec3<u32>(val, p, q);
  if (seg == 0u) { rgb = vec3<u32>(val, t, p); }
  else if (seg == 1u) { rgb = vec3<u32>(q, val, p); }
  else if (seg == 2u) { rgb = vec3<u32>(p, val, t); }
  else if (seg == 3u) { rgb = vec3<u32>(p, q, val); }
  else if (seg == 4u) { rgb = vec3<u32>(t, p, val); }
  return vec3f(f32(rgb.x), f32(rgb.y), f32(rgb.z)) / 255.0;
}

// Resolve a label id to rgba (0..1), honoring the declared OME palette:
// a linear scan of `count` [id, packedRgba] pairs (declared colors are
// few), falling back to the glasbey hash (alpha 1) for undeclared ids.
// Mirrors labelColors.ts `labelColor`. Packed rgba = r | g<<8 | b<<16 | a<<24.
fn labelColorFor(id: u32, count: u32) -> vec4f {
  for (var i = 0u; i < count; i = i + 1u) {
    if (labelColors[2u * i] == id) {
      let packed = labelColors[2u * i + 1u];
      return vec4f(
        f32(packed & 0xFFu) / 255.0,
        f32((packed >> 8u) & 0xFFu) / 255.0,
        f32((packed >> 16u) & 0xFFu) / 255.0,
        f32((packed >> 24u) & 0xFFu) / 255.0,
      );
    }
  }
  return vec4f(labelGlasbey(id), 1.0);
}

struct FsOut {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
};

// A slice view's cut of a member its placement tilts off the cut: the one
// sample under each pixel. For a cut draw `u.invViewProj` maps the target's
// NDC to the world point of the cut there. The color is a slice layer's:
// the windowed value through the colormap, premultiplied by the opacity, so
// it composites with the view's other layers.
@fragment
fn fsCut(input: VSOut) -> @location(0) vec4f {
  activeEntity = entityDescriptors[currentEntity.index.x];
  let entity = activeEntity;
  let world = u.invViewProj * vec4f(input.ndc, 0.0, 1.0);
  let local = (entity.invModelMatrix * vec4f(world.xyz / world.w, 1.0)).xyz;
  if (any(local < vec3f(0.0)) || any(local > vec3f(1.0))) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }
  // The direction only bounds a ray's skip past empty cells, which one
  // sample never takes.
  let s = sampleWithFallback(local, vec3f(0.0, 0.0, 1.0));
  if (s.value == FAILED) {
    return failedHatch(input.pos.xy, u.stepInfo.z) * entity.opacity;
  }
  if (s.value == MISS || texelIsNaN(s.value, entity.sampleFormat)) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }
  let range = entity.contrastMax - entity.contrastMin;
  let normalized = pow(clamp((texelValue(s.value, entity.sampleFormat) - entity.contrastMin) / range, 0.0, 1.0), entity.gamma);
  let color = textureSampleLevel(lutTex, lutSampler, vec2f(normalized, 0.5), 0.0).rgb;
  return vec4f(color * entity.opacity, entity.opacity);
}

@fragment
fn fs(input: VSOut) -> FsOut {
  activeEntity = entityDescriptors[currentEntity.index.x];
  let entity = activeEntity;

  // Reconstruct ray in world space from NDC
  let clipNear = vec4f(input.ndc, -1.0, 1.0);
  let clipFar = vec4f(input.ndc, 1.0, 1.0);
  var worldNear = u.invViewProj * clipNear;
  var worldFar = u.invViewProj * clipFar;
  worldNear /= worldNear.w;
  worldFar /= worldFar.w;

  let worldRo = worldNear.xyz;
  let worldRd = normalize(worldFar.xyz - worldNear.xyz);

  // Transform ray into local [0,1]^3 space via invModelMatrix
  let localRo4 = entity.invModelMatrix * vec4f(worldRo, 1.0);
  let localRd4 = entity.invModelMatrix * vec4f(worldRd, 0.0);
  let ro = localRo4.xyz;
  let rd = normalize(localRd4.xyz);

  // Intersect unit cube [0,1]^3 representing the volume in local space
  let tt = intersectAABB(ro, rd);
  if (tt.x >= tt.y || tt.y < 0.0) {
    var miss: FsOut;
    miss.color = vec4f(0.0, 0.0, 0.0, 0.0);
    miss.depth = 1.0;
    return miss;
  }

  var tStart = max(tt.x, 0.0);
  let tEnd = tt.y;

  // Apply clip distance — skip samples closer than clipDist to the camera
  let clipDist = u.clipParams.x;
  if (clipDist > 0.0) {
    let camWorld = u.cameraPos.xyz;
    if (u.clipParams.y < 0.5) {
      // Plane mode: clip plane perpendicular to camera forward at clipDist
      let planeNormal = u.camForward.xyz;
      let planePoint = camWorld + planeNormal * clipDist;
      // Intersect world-space ray with the clip plane
      let denom = dot(worldRd, planeNormal);
      if (abs(denom) > 1e-6) {
        let t_world = dot(planePoint - worldRo, planeNormal) / denom;
        if (t_world > 0.0) {
          // Convert world-space hit point to local-space t parameter
          let worldHitPt = worldRo + worldRd * t_world;
          let localHitPt = (entity.invModelMatrix * vec4f(worldHitPt, 1.0)).xyz;
          let localT = dot(localHitPt - ro, rd) / dot(rd, rd);
          tStart = max(tStart, localT);
        }
      }
    } else {
      // Sphere mode: clip sphere of radius clipDist centered at camera
      let oc = worldRo - camWorld;
      let a_coeff = dot(worldRd, worldRd);
      let b_coeff = 2.0 * dot(oc, worldRd);
      let c_coeff = dot(oc, oc) - clipDist * clipDist;
      let disc = b_coeff * b_coeff - 4.0 * a_coeff * c_coeff;
      if (disc >= 0.0) {
        // Take the far intersection (exit point of the sphere)
        let t_world = (-b_coeff + sqrt(disc)) / (2.0 * a_coeff);
        if (t_world > 0.0) {
          let worldHitPt = worldRo + worldRd * t_world;
          let localHitPt = (entity.invModelMatrix * vec4f(worldHitPt, 1.0)).xyz;
          let localT = dot(localHitPt - ro, rd) / dot(rd, rd);
          tStart = max(tStart, localT);
        }
      }
    }
  }

  // Bail if clipping pushed tStart past tEnd
  if (tStart >= tEnd) {
    var clipMiss: FsOut;
    clipMiss.color = vec4f(0.0, 0.0, 0.0, 0.0);
    clipMiss.depth = 1.0;
    return clipMiss;
  }

  let intensityMin = entity.contrastMin;
  let intensityMax = entity.contrastMax;
  let opacityScale = u.stepInfo.x;
  let renderMode = i32(u.stepInfo.y);

  let range = intensityMax - intensityMin;

  let rayLen = tEnd - tStart;
  // The march advances by the sampled level's own spacing, `stepScale` of
  // them at a time, floored so the ray always reaches tEnd within the step
  // budget, which a coarser march shrinks to match.
  let stepScale = max(u.stepInfo.w, 1.0);
  let maxSteps = i32(f32(select(512, 256, renderMode == 1)) / stepScale);
  let minStep = rayLen / f32(maxSteps);

  // Categorical label overlay: a first-hit colored surface, NOT translucent
  // accumulation (which yields noisy haze). March until the first non-zero
  // label voxel, paint its categorical color opaque at the per-label opacity,
  // record frag depth, and stop. MISS (not resident) and `0u` (background)
  // are transparent so the intensity volume shows through. Declared OME
  // colors win; the glasbey hash covers the rest. Nearest sampling (integer
  // ids never interpolate).
  if (entity.colormapMode == 1u) {
    let labelMinStep = rayLen / 512.0;
    var lt = tStart;
    for (var i = 0; i < 512; i++) {
      if (lt >= tEnd) { break; }
      let pos = ro + rd * lt;
      let s = sampleWithFallback(pos, rd);
      // FAILED is no label id: the ray stops at the failed cell and draws the
      // hatch there, so missing labels never read as background.
      if (s.value == FAILED) {
        let worldHit = entity.modelMatrix * vec4f(pos, 1.0);
        let clipHit = u.viewProj * worldHit;
        var failedHit: FsOut;
        failedHit.depth = clipHit.z / clipHit.w * 0.5 + 0.5;
        failedHit.color = failedHatch(input.pos.xy, u.stepInfo.z) * entity.labelOpacity;
        return failedHit;
      }
      if (s.value != MISS && s.value != 0u) {
        let labelRgba = labelColorFor(s.value, currentEntity.index.y);
        let labelOp = entity.labelOpacity * labelRgba.a;
        // Record frag depth at the surface so the cursor occludes correctly.
        let worldHit = entity.modelMatrix * vec4f(pos, 1.0);
        let clipHit = u.viewProj * worldHit;
        var hit: FsOut;
        hit.depth = clipHit.z / clipHit.w * 0.5 + 0.5;
        // Opaque paint at the per-label opacity (folds in the declared
        // alpha); premultiplied for the alpha-blend composite. Non-accumulated.
        hit.color = vec4f(labelRgba.rgb * labelOp, labelOp);
        return hit;
      }
      lt += max(s.step, labelMinStep);
    }
    // No label voxel along this ray: contribute nothing AND leave the
    // intensity volume's depth intact. `discard` skips both the color and
    // the frag_depth write — returning a far depth here would clobber the
    // intensity depth and break cursor occlusion behind the overlay.
    var labelMiss: FsOut;
    labelMiss.color = vec4f(0.0, 0.0, 0.0, 0.0);
    labelMiss.depth = 1.0;
    discard;
    return labelMiss;
  }

  // Front-to-back compositing
  var color = vec3f(0.0);
  var alpha = 0.0;
  var maxVal = 0.0;
  var t = tStart;
  var hitDepth = 1.0;
  var depthRecorded = false;
  // The ray crossed a failed chunk, so what it accumulated is missing a part.
  var crossedFailed = false;

  for (var i = 0; i < maxSteps; i++) {
    if (t >= tEnd) { break; }
    if (renderMode == 0 && alpha >= 0.98) { break; } // early termination (translucent)
    if (renderMode == 1 && maxVal >= 0.98) { break; } // early termination (MIP)

    let pos = ro + rd * t;

    let s = sampleWithFallback(pos, rd);
    let advance = max(s.step, minStep);
    if (s.value == FAILED) {
      crossedFailed = true;
      t += advance;
      continue;
    }
    // A u16 zero sits at or below any window over unsigned data, so it adds
    // nothing; a float zero can sit inside a window that reaches below it.
    if (s.value == MISS
        || (entity.sampleFormat != SAMPLE_F32 && s.value == 0u)
        || texelIsNaN(s.value, entity.sampleFormat)) {
      t += advance;
      continue;
    }
    let rawVal = texelValue(s.value, entity.sampleFormat);
    let normalized = pow(clamp((rawVal - intensityMin) / range, 0.0, 1.0), entity.gamma);

    // Record depth at first significant sample
    if (!depthRecorded && normalized > 0.01) {
      let worldHit = entity.modelMatrix * vec4f(pos, 1.0);
      let clipHit = u.viewProj * worldHit;
      // Remap from clip [-1,1] to viewport [0,1] to match rasterizer depth
      hitDepth = clipHit.z / clipHit.w * 0.5 + 0.5;
      depthRecorded = true;
    }

    if (renderMode == 1) {
      // MIP: track maximum intensity
      maxVal = max(maxVal, normalized);
    } else {
      // Translucent: front-to-back blending. A sample of a coarser march
      // stands for `stepScale` steps, so it is as opaque as they are together.
      let stepAlpha = normalized * opacityScale;
      let sampleAlpha = select(1.0 - pow(1.0 - stepAlpha, stepScale), stepAlpha, stepScale == 1.0);
      let sampleColor = textureSampleLevel(lutTex, lutSampler, vec2f(normalized, 0.5), 0.0).rgb;
      color += (1.0 - alpha) * sampleAlpha * sampleColor;
      alpha += (1.0 - alpha) * sampleAlpha;
    }

    t += max(s.step * stepScale, minStep);
  }

  let layerOpacity = entity.opacity;
  var out: FsOut;
  out.depth = hitDepth;
  if (renderMode == 1) {
    let mipColor = textureSampleLevel(lutTex, lutSampler, vec2f(maxVal, 0.5), 0.0).rgb;
    out.color = vec4f(mipColor, 1.0) * layerOpacity;
  } else {
    out.color = vec4f(color * layerOpacity, alpha * layerOpacity);
  }
  if (crossedFailed) {
    let hatch = failedHatch(input.pos.xy, u.stepInfo.z) * layerOpacity;
    out.color = hatch + out.color * (1.0 - hatch.a);
  }
  return out;
}
