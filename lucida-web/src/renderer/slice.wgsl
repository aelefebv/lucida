// 2D slice viewer shader — GPU-side u16→u8 normalization

struct Uniforms {
  transform: mat4x4f,          // offset 0   (64 bytes) — inverse pan/zoom (screen UV → texture UV)
  detailAtlasSlotDims: vec4u,  // offset 64  (16 bytes) — xy=slots per axis
  coarseAtlasSlotDims: vec4u,  // offset 80  (16 bytes) — xy=slots per axis
  memberScreenSize: vec4f,     // offset 96  (16 bytes) — xy=member pixel size on screen
  lodParams: vec4u,            // offset 112 (16 bytes) — x=targetLodIdx
  // total = 128 bytes
};

struct EntityRef { index: vec4u };

// Layout matches descriptorBuffer.ts.
struct LodInfo {
  level: u32,
  indirectionOffset: u32,
  _pad0: u32,
  _pad1: u32,
  gridDims: vec3<u32>,
  _pad2: u32,
  chunkDims: vec3<u32>,
  _pad3: u32,
  levelDims: vec3<u32>,
  _pad4: u32,
};

struct ChunkTierSource {
  valid: u32,
  level: u32,
  indirectionOffset: u32,
  _pad0: u32,
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
  contrastMin: f32,
  contrastMax: f32,
  gamma: f32,
  opacity: f32,
  colormapLutIndex: u32,
  lodCount: u32,
  colormapMode: u32,
  labelOpacity: f32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  lods: array<LodInfo, 8>,
  detailSource: ChunkTierSource,
  coarseSource: ChunkTierSource,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var detailTex: texture_2d<u32>;
@group(0) @binding(2) var<storage, read> detailIndirection: array<u32>;
@group(0) @binding(3) var lutTex: texture_2d<f32>;
@group(0) @binding(4) var lutSampler: sampler;
@group(0) @binding(5) var coarseTex: texture_2d<u32>;
@group(0) @binding(6) var<storage, read> coarseIndirection: array<u32>;

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

// Width of the gray frame drawn just inside a member's footprint edge.
const MEMBER_BORDER_WIDTH_PX: f32 = 1.5;

// Minimum on-screen member size (per axis) for the footprint border to
// draw at all. Below this the frame would cover the member's ENTIRE
// footprint — every visible pixel would be constant border gray, so the
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

fn sampleDetail2D(source: ChunkTierSource, uv: vec2f) -> u32 {
  if (source.valid == 0u || u.detailAtlasSlotDims.x == 0u || u.detailAtlasSlotDims.y == 0u) {
    return 0xFFFFFFFFu;
  }
  let levelDims = vec2u(source.levelDims.x, source.levelDims.y);
  let chunkDims = vec2u(source.chunkDims.x, source.chunkDims.y);
  let gridDims = vec2u(source.gridDims.x, source.gridDims.y);

  let texCoord = vec2i(
    clamp(i32(uv.x * f32(levelDims.x)), 0, i32(levelDims.x) - 1),
    clamp(i32(uv.y * f32(levelDims.y)), 0, i32(levelDims.y) - 1),
  );
  let chunkCoord = vec2u(
    u32(texCoord.x) / chunkDims.x,
    u32(texCoord.y) / chunkDims.y,
  );
  let gridIdx = source.indirectionOffset + chunkCoord.y * gridDims.x + chunkCoord.x;
  let slot = detailIndirection[gridIdx];
  if (slot == 0xFFFFFFFFu) {
    return 0xFFFFFFFFu;
  }

  let slotCoord = vec2u(
    slot % u.detailAtlasSlotDims.x,
    slot / u.detailAtlasSlotDims.x,
  );
  let localTexel = vec2u(
    u32(texCoord.x) % chunkDims.x,
    u32(texCoord.y) % chunkDims.y,
  );
  let atlasCoord = vec2i(
    i32(slotCoord.x * chunkDims.x + localTexel.x),
    i32(slotCoord.y * chunkDims.y + localTexel.y),
  );
  return textureLoad(detailTex, atlasCoord, 0).r;
}

fn sampleCoarse2D(source: ChunkTierSource, uv: vec2f) -> u32 {
  if (source.valid == 0u || u.coarseAtlasSlotDims.x == 0u || u.coarseAtlasSlotDims.y == 0u) {
    return 0xFFFFFFFFu;
  }
  let levelDims = vec2u(source.levelDims.x, source.levelDims.y);
  let chunkDims = vec2u(source.chunkDims.x, source.chunkDims.y);
  let gridDims = vec2u(source.gridDims.x, source.gridDims.y);

  let texCoord = vec2i(
    clamp(i32(uv.x * f32(levelDims.x)), 0, i32(levelDims.x) - 1),
    clamp(i32(uv.y * f32(levelDims.y)), 0, i32(levelDims.y) - 1),
  );
  let chunkCoord = vec2u(
    u32(texCoord.x) / chunkDims.x,
    u32(texCoord.y) / chunkDims.y,
  );
  let gridIdx = source.indirectionOffset + chunkCoord.y * gridDims.x + chunkCoord.x;
  let slot = coarseIndirection[gridIdx];
  if (slot == 0xFFFFFFFFu) {
    return 0xFFFFFFFFu;
  }

  let slotCoord = vec2u(
    slot % u.coarseAtlasSlotDims.x,
    slot / u.coarseAtlasSlotDims.x,
  );
  let localTexel = vec2u(
    u32(texCoord.x) % chunkDims.x,
    u32(texCoord.y) % chunkDims.y,
  );
  let atlasCoord = vec2i(
    i32(slotCoord.x * chunkDims.x + localTexel.x),
    i32(slotCoord.y * chunkDims.y + localTexel.y),
  );
  return textureLoad(coarseTex, atlasCoord, 0).r;
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
// (`fsAggregate`): selected detail → configured coarse → empty.
fn sampleEntityValue(entityIdx: u32, texUV: vec2f) -> u32 {
  let entity = entityDescriptors[entityIdx];
  var chunkVal = sampleDetail2D(entity.detailSource, texUV);
  if (chunkVal == 0xFFFFFFFFu) {
    chunkVal = sampleCoarse2D(entity.coarseSource, texUV);
  }
  return chunkVal;
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

  // member footprint border: a gray frame just inside each member's
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
      return vec4f(0.3, 0.3, 0.3, 1.0);
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
    if (chunkVal == 0xFFFFFFFFu || chunkVal == 0u) {
      return vec4f(0.0, 0.0, 0.0, 0.0);
    }
    let labelRgba = labelColorFor(chunkVal, currentEntity.index.y);
    let labelOp = entity.labelOpacity * labelRgba.a;
    return vec4f(labelRgba.rgb * labelOp, labelOp);
  }

  if (chunkVal == 0xFFFFFFFFu) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }
  let normalized = pow(clamp((f32(chunkVal) - intensityMin) / range, 0.0, 1.0), gamma);
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
  // would read as a constant gray grid no display edit can touch.
  if (min(input.memberScreenPx.x, input.memberScreenPx.y) >= MEMBER_BORDER_MIN_SCREEN_PX) {
    let edge_x = min(input.uv.x, 1.0 - input.uv.x);
    let edge_y = min(input.uv.y, 1.0 - input.uv.y);
    let edge_min_px = min(
      edge_x * input.memberScreenPx.x,
      edge_y * input.memberScreenPx.y,
    );
    if (edge_min_px < MEMBER_BORDER_WIDTH_PX) {
      return vec4f(0.3, 0.3, 0.3, 1.0);
    }
  }

  let chunkVal = sampleEntityValue(input.entityIdx, input.uv);
  if (chunkVal == 0xFFFFFFFFu) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }
  let range = entity.contrastMax - entity.contrastMin;
  let normalized = pow(
    clamp((f32(chunkVal) - entity.contrastMin) / range, 0.0, 1.0),
    entity.gamma,
  );
  let color = textureSampleLevel(lutTex, lutSampler, vec2f(normalized, 0.5), 0.0).rgb;
  return vec4f(color * entity.opacity, entity.opacity);
}
