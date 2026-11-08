// 2D slice viewer shader — GPU-side windowing of sample values

// Matches DESCRIPTOR_MAX_LEVEL_SOURCES in descriptor/layout.ts: one level pool binding per slot.
const MAX_LEVEL_SOURCES: u32 = 4u;
// The indirection sentinel, and the sample value for "nothing resident here".
const MISS: u32 = 0xFFFFFFFFu;

struct Uniforms {
  transform: mat4x4f,                  // offset 0   (64 bytes) — inverse pan/zoom (screen UV → texture UV)
  levelAtlasSlotDims: array<vec4u, 4>, // offset 64  (64 bytes) — xy=slots per axis, one per level pool binding
  coarseAtlasSlotDims: vec4u,          // offset 128 (16 bytes) — xy=slots per axis
  memberScreenSize: vec4f,             // offset 144 (16 bytes) — xy=member pixel size on screen
  borderColor: vec4f,                  // offset 160 (16 bytes) — member footprint border, premultiplied
  // total = 176 bytes
};

struct EntityRef { index: vec4u };

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
@group(0) @binding(3) var coarseTex: texture_2d<u32>;
@group(0) @binding(4) var<storage, read> coarseIndirection: array<u32>;
// One level pool per resident-level slot. A level source's `poolIndex`
// says which of these it reads; levels of one entity may live in
// different pools when their chunk shapes differ.
@group(0) @binding(5) var levelTex0: texture_2d<u32>;
@group(0) @binding(6) var levelTex1: texture_2d<u32>;
@group(0) @binding(7) var levelTex2: texture_2d<u32>;
@group(0) @binding(8) var levelTex3: texture_2d<u32>;
@group(0) @binding(9) var<storage, read> levelIndirection0: array<u32>;
@group(0) @binding(10) var<storage, read> levelIndirection1: array<u32>;
@group(0) @binding(11) var<storage, read> levelIndirection2: array<u32>;
@group(0) @binding(12) var<storage, read> levelIndirection3: array<u32>;

@group(1) @binding(0) var<storage, read> entityDescriptors: array<EntityDescriptor>;
@group(1) @binding(1) var<uniform> currentEntity: EntityRef;
// Declared label palette for categorical draws: flat [id, packedRgba]
// pairs; `currentEntity.index.y` holds the pair count (0 for intensity).
@group(1) @binding(2) var<storage, read> labelColors: array<u32>;

// One record per member of an aggregate (batched) layer. `rect` is the
// member's quad in layer UV (origin xy, size zw); `entityRef.x` is the
// member's entity descriptor index. Bound only by the aggregate
// pipeline (vsAggregate/fsAggregate); the per-member pipeline's layout
// omits it.
struct MemberQuad {
  rect: vec4f,
  entityRef: vec4u,
};
@group(1) @binding(3) var<storage, read> memberQuads: array<MemberQuad>;

// Width of the frame drawn just inside a member's footprint edge. Its color
// is the page's theme token, in the uniforms.
const MEMBER_BORDER_WIDTH_PX: f32 = 1.5;

// Minimum on-screen member size (per axis) for the footprint border to
// draw at all. Below this the frame would cover the member's ENTIRE
// footprint — every visible pixel would be the constant border color, so the
// sampled data (and any contrast/gamma/colormap edit) could never reach
// the screen. Tiny members render pure content instead: sampled value
// on hit, transparent on miss.
const MEMBER_BORDER_MIN_SCREEN_PX: f32 = 3.0;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

// Full-screen triangle (3 vertices, no vertex buffer)
@vertex
fn vs(@builtin(vertex_index) vid: u32) -> VSOut {
  var out: VSOut;
  let x = f32(i32(vid & 1u)) * 4.0 - 1.0;
  let y = f32(i32(vid >> 1u)) * 4.0 - 1.0;
  out.pos = vec4f(x, y, 0.0, 1.0);
  // Map clip [-1,1] to UV [0,1] with Y flipped (top-left origin)
  out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}



// The chunk-grid cell of one source under a member-local UV, and the
// texel inside that chunk.
struct Cell2D {
  gridIdx: u32,
  localTexel: vec2u,
  chunkDims: vec2u,
};

fn locateCell2D(source: ChunkTierSource, uv: vec2f) -> Cell2D {
  let levelDims = vec2u(source.levelDims.x, source.levelDims.y);
  let chunkDims = vec2u(source.chunkDims.x, source.chunkDims.y);
  let texCoord = vec2u(
    u32(clamp(i32(uv.x * f32(levelDims.x)), 0, i32(levelDims.x) - 1)),
    u32(clamp(i32(uv.y * f32(levelDims.y)), 0, i32(levelDims.y) - 1)),
  );
  let chunkCoord = texCoord / chunkDims;
  var cell: Cell2D;
  cell.gridIdx = source.indirectionOffset + chunkCoord.y * source.gridDims.x + chunkCoord.x;
  cell.localTexel = texCoord % chunkDims;
  cell.chunkDims = chunkDims;
  return cell;
}

fn atlasCoord2D(slot: u32, slotsX: u32, cell: Cell2D) -> vec2i {
  let slotCoord = vec2u(slot % slotsX, slot / slotsX);
  return vec2i(slotCoord * cell.chunkDims + cell.localTexel);
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

fn levelTexelAt(poolIdx: u32, coord: vec2i) -> u32 {
  switch (poolIdx) {
    case 0u: { return textureLoad(levelTex0, coord, 0).r; }
    case 1u: { return textureLoad(levelTex1, coord, 0).r; }
    case 2u: { return textureLoad(levelTex2, coord, 0).r; }
    default: { return textureLoad(levelTex3, coord, 0).r; }
  }
}

fn sampleLevel2D(source: ChunkTierSource, uv: vec2f) -> u32 {
  let slotDims = u.levelAtlasSlotDims[source.poolIndex].xy;
  if (source.valid == 0u || slotDims.x == 0u || slotDims.y == 0u) {
    return MISS;
  }
  let cell = locateCell2D(source, uv);
  let slot = levelSlotAt(source.poolIndex, cell.gridIdx);
  if (slot == MISS) {
    return MISS;
  }
  return levelTexelAt(source.poolIndex, atlasCoord2D(slot, slotDims.x, cell));
}

fn sampleCoarse2D(source: ChunkTierSource, uv: vec2f) -> u32 {
  let slotDims = u.coarseAtlasSlotDims.xy;
  if (source.valid == 0u || slotDims.x == 0u || slotDims.y == 0u) {
    return MISS;
  }
  let cell = locateCell2D(source, uv);
  let slot = coarseIndirection[cell.gridIdx];
  if (slot == MISS) {
    return MISS;
  }
  return textureLoad(coarseTex, atlasCoord2D(slot, slotDims.x, cell), 0).r;
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

// Resolve the raw sample for one entity at a member-local UV. Shared by
// the per-member pass (`fs`) and the aggregate batched pass
// (`fsAggregate`). Sampling order: the level sources finest first (the
// target level, then the coarser resident levels), then the coarse
// tier, then blank. Every sample comes from exactly one level.
// Returns the sampled value or MISS when nothing is resident at this UV.
fn sampleEntityValue(entityIdx: u32, texUV: vec2f) -> u32 {
  let count = min(entityDescriptors[entityIdx].levelSourceCount, MAX_LEVEL_SOURCES);
  for (var i = 0u; i < count; i++) {
    let v = sampleLevel2D(entityDescriptors[entityIdx].levelSources[i], texUV);
    if (v != MISS) {
      return v;
    }
  }
  return sampleCoarse2D(entityDescriptors[entityIdx].coarseSource, texUV);
}

@fragment
fn fs(input: VSOut) -> @location(0) vec4f {
  // Apply inverse transform to get texture UV
  let texUV4 = u.transform * vec4f(input.uv, 0.0, 1.0);
  let texUV = texUV4.xy;

  // Bounds check — transparent for compositing
  if (texUV.x < 0.0 || texUV.x > 1.0 || texUV.y < 0.0 || texUV.y > 1.0) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }

  let entity = entityDescriptors[currentEntity.index.x];

  // member footprint border: a frame just inside each member's
  // footprint edge. Skip it for a label overlay (categorical) — an opaque
  // frame around a sub-footprint mask would sit on top of the intensity
  // image it annotates — and for members too small on screen to show
  // content next to the frame (see MEMBER_BORDER_MIN_SCREEN_PX).
  if (entity.colormapMode != 1u
      && min(u.memberScreenSize.x, u.memberScreenSize.y) >= MEMBER_BORDER_MIN_SCREEN_PX) {
    let edge_x = min(texUV.x, 1.0 - texUV.x);
    let edge_y = min(texUV.y, 1.0 - texUV.y);
    let dist_x_px = edge_x * u.memberScreenSize.x;
    let dist_y_px = edge_y * u.memberScreenSize.y;
    let edge_min_px = min(dist_x_px, dist_y_px);
    if (edge_min_px < MEMBER_BORDER_WIDTH_PX) {
      return u.borderColor;
    }
  }

  let intensityMin = entity.contrastMin;
  let intensityMax = entity.contrastMax;
  let range = intensityMax - intensityMin;
  let gamma = entity.gamma;
  let layerOpacity = entity.opacity;

  let chunkVal = sampleEntityValue(currentEntity.index.x, texUV);

  // Categorical label overlay: the sampled value is an integer id, not an
  // intensity. Nearest id -> distinct color; id 0 (background) and misses
  // are transparent so the intensity image shows through underneath.
  // Declared OME colors win; the glasbey hash covers the rest. The final
  // opacity folds in the declared alpha (hash alpha is 1).
  if (entity.colormapMode == 1u) {
    if (chunkVal == MISS || chunkVal == 0u) {
      return vec4f(0.0, 0.0, 0.0, 0.0);
    }
    let labelRgba = labelColorFor(chunkVal, currentEntity.index.y);
    let labelOp = entity.labelOpacity * labelRgba.a;
    return vec4f(labelRgba.rgb * labelOp, labelOp);
  }

  if (chunkVal == MISS || texelIsNaN(chunkVal, entity.sampleFormat)) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }
  let value = texelValue(chunkVal, entity.sampleFormat);
  let normalized = pow(clamp((value - intensityMin) / range, 0.0, 1.0), gamma);
  let color = textureSampleLevel(lutTex, lutSampler, vec2f(normalized, 0.5), 0.0).rgb;
  return vec4f(color * layerOpacity, layerOpacity);
}

// ─── Aggregate (batched member) pass ────────────────────────────────────
//
// One instanced draw renders every batched member of an aggregate layer:
// instance i covers memberQuads[i].rect within the layer's extent and
// samples that member's own descriptor entry, so pass count is bounded
// by the layer budget while the content matches the per-member passes.

struct AggregateVSOut {
  @builtin(position) pos: vec4f,
  // Member-local UV (0..1 across the member's own footprint).
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) entityIdx: u32,
  // Member's on-screen pixel size, for the footprint-border rule.
  @location(2) @interpolate(flat) memberScreenPx: vec2f,
};

@vertex
fn vsAggregate(
  @builtin(vertex_index) vid: u32,
  @builtin(instance_index) iid: u32,
) -> AggregateVSOut {
  let quad = memberQuads[iid];
  // Two-triangle quad corners in member-local UV.
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let local = corners[vid];
  let layerUV = quad.rect.xy + local * quad.rect.zw;
  // `u.transform` maps screen UV → layer UV (texUV = s·uv + t, per
  // axis); invert it to place the corner on screen.
  let sx = u.transform[0].x;
  let sy = u.transform[1].y;
  let tx = u.transform[3].x;
  let ty = u.transform[3].y;
  let screenUV = vec2f((layerUV.x - tx) / sx, (layerUV.y - ty) / sy);

  var out: AggregateVSOut;
  out.pos = vec4f(screenUV.x * 2.0 - 1.0, 1.0 - screenUV.y * 2.0, 0.0, 1.0);
  out.uv = local;
  out.entityIdx = quad.entityRef.x;
  // The uniform's memberScreenSize holds the LAYER's screen size for an
  // aggregate draw; each member covers its rect fraction of it.
  out.memberScreenPx = quad.rect.zw * u.memberScreenSize.xy;
  return out;
}

@fragment
fn fsAggregate(input: AggregateVSOut) -> @location(0) vec4f {
  let entity = entityDescriptors[input.entityIdx];

  // Same member footprint border as the per-member pass. Aggregate
  // layers are intensity-only (labels never batch), so no categorical
  // skip is needed — but the size gate matters MOST here: batched
  // members are routinely sub-pixel at overview zoom, where an ungated
  // frame would cover every member's whole footprint and the field
  // would read as a constant grid no display edit can touch.
  if (min(input.memberScreenPx.x, input.memberScreenPx.y) >= MEMBER_BORDER_MIN_SCREEN_PX) {
    let edge_x = min(input.uv.x, 1.0 - input.uv.x);
    let edge_y = min(input.uv.y, 1.0 - input.uv.y);
    let edge_min_px = min(
      edge_x * input.memberScreenPx.x,
      edge_y * input.memberScreenPx.y,
    );
    if (edge_min_px < MEMBER_BORDER_WIDTH_PX) {
      return u.borderColor;
    }
  }

  let chunkVal = sampleEntityValue(input.entityIdx, input.uv);
  if (chunkVal == MISS || texelIsNaN(chunkVal, entity.sampleFormat)) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }
  let range = entity.contrastMax - entity.contrastMin;
  let normalized = pow(
    clamp((texelValue(chunkVal, entity.sampleFormat) - entity.contrastMin) / range, 0.0, 1.0),
    entity.gamma,
  );
  let color = textureSampleLevel(lutTex, lutSampler, vec2f(normalized, 0.5), 0.0).rgb;
  return vec4f(color * entity.opacity, entity.opacity);
}
