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
  fieldProxyPoolIndex: u32,
  fieldProxySlotIndex: u32,
  wellProxyPoolIndex: u32,
  wellProxySlotIndex: u32,
  _pad_proxy0: u32,
  _pad_proxy1: u32,
  _pad_proxy2: u32,
  fieldProxyDims: vec3<u32>,
  _pad_field: u32,
  wellProxyDims: vec3<u32>,
  _pad_well: u32,
  contrastMin: f32,
  contrastMax: f32,
  gamma: f32,
  opacity: f32,
  colormapLutIndex: u32,
  lodCount: u32,
  isLabel: u32,
  labelOverlayOpacity: f32,
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
// Proxy textures are 3D (same as volume.wgsl); slice mode reads one Z
// plane within the slot region.
@group(0) @binding(7) var fieldProxyTex: texture_3d<u32>;
@group(0) @binding(8) var wellProxyTex: texture_3d<u32>;
// Label overlay path: the r32uint label atlas (exact integer ids) and the
// 256×256 rgba8unorm indexed-colour LUT baked by `WasmScene::label_lut` (the flat
// 65536-entry table laid out row-major; 65536×1 would exceed
// maxTextureDimension2D). The atlas is `textureLoad`ed for the exact id; the LUT
// is `textureLoad`ed at (idx & 255, idx >> 8) (rgba8unorm → vec4<f32>). A label
// colour is never filtered/interpolated, so no sampler is bound for either — the
// linear `lutSampler` (intensity colormap) is never applied to a label.
@group(0) @binding(9) var labelTex: texture_2d<u32>;
@group(0) @binding(10) var labelLutTex: texture_2d<f32>;

@group(1) @binding(0) var<storage, read> entityDescriptors: array<EntityDescriptor>;
@group(1) @binding(1) var<uniform> currentEntity: EntityRef;

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

// Sample one voxel from a proxy slot using 2D UV. Reads at the slot's
// Z midpoint. Slot grid layout and dim convention match `proxyAtlas.ts`
// (`slotDims: [Z, Y, X]` → `dims.x=Z, dims.y=Y, dims.z=X`).
fn sampleProxy2D(tex: texture_3d<u32>, slotIdx: u32, dims: vec3<u32>, uv: vec2f) -> u32 {
  if (slotIdx == 0xFFFFFFFFu) {
    return 0xFFFFFFFFu;
  }
  let slotZ = dims.x;
  let slotY = dims.y;
  let slotX = dims.z;
  let atlasDims = textureDimensions(tex);
  let slotsX = max(1u, atlasDims.x / slotX);
  let slotsY = max(1u, atlasDims.y / slotY);
  let tileX = slotIdx % slotsX;
  let tileY = (slotIdx / slotsX) % slotsY;
  let tileZ = slotIdx / (slotsX * slotsY);
  let origin = vec3u(tileX * slotX, tileY * slotY, tileZ * slotZ);
  let voxX = clamp(u32(uv.x * f32(slotX)), 0u, slotX - 1u);
  let voxY = clamp(u32(uv.y * f32(slotY)), 0u, slotY - 1u);
  let voxZ = slotZ / 2u;
  let coord = vec3i(
    i32(origin.x + voxX),
    i32(origin.y + voxY),
    i32(origin.z + voxZ),
  );
  return textureLoad(tex, coord, 0).r;
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

// Sample the label atlas (r32uint) via the same indirection walk as
// `sampleDetail2D`, but reading the label texture bound at binding 9. The
// label member's own indirection buffer is bound to `detailIndirection`
// (binding 2) and its slot dims to `detailAtlasSlotDims` for the draw, so the
// chunk→slot lookup is identical; only the sampled texture differs. Returns the
// exact integer id, or the sentinel when the covering chunk isn't resident.
fn sampleLabel2D(source: ChunkTierSource, uv: vec2f) -> u32 {
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
  return textureLoad(labelTex, atlasCoord, 0).r;
}

// In-shader port of core `label_lut::glasbey_rgba` (see
// `lucida-core/src/scene/label_lut.rs`) for label ids at or beyond the 65536-entry
// LUT. Core bakes the SAME deterministic "glasbey-like" colour into LUT slots
// `[0,65536)` in f64; here we reproduce its exact formula for ids `>= 65536`
// (which the LUT cannot hold) so a label's colour is continuous whether it is
// read from the LUT (`< 65536`) or computed here (`>= 65536`).
//
// The formula is a golden-ratio hue walk: `hue = frac(value * φ⁻¹ + 0.5)`, then
// HSV→RGB at fixed saturation 0.65 and a parity brightness dither (0.98 for odd
// ids, 0.88 for even). Core computes `value * φ⁻¹` in f64; WGSL has no f64, and a
// naive f32 `f32(value) * φ⁻¹` loses ALL fractional precision for large ids (the
// integer part swamps the f32 mantissa), giving the wrong hue. So we reduce
// modulo 1 in a precision-safe way: split `value` into its four bytes and weight
// each by `frac(256^k · φ⁻¹)` — pre-reduced constants below. Every partial product
// stays below 256 in magnitude, where f32 keeps ~15 fractional bits, so
// `frac(Σ bₖ·wₖ + 0.5)` matches core's f64 `frac(value·φ⁻¹ + 0.5)` to within one
// 8-bit channel unit across the entire u32 range (exact for the ids that matter).
fn glasbey_wgsl(value: u32) -> vec3<f32> {
  // wₖ = frac(256^k · φ⁻¹), φ⁻¹ = 0.6180339887498949. Full-precision decimals so
  // the literal round-trips to the exact f32 the port was validated against.
  let w0 = 0.61803400516510010; // frac(1      · φ⁻¹)
  let w1 = 0.21670112013816833; // frac(256    · φ⁻¹)
  let w2 = 0.47548672556877136; // frac(65536  · φ⁻¹)
  let w3 = 0.72459858655929565; // frac(2^24   · φ⁻¹)
  let b0 = f32(value & 0xFFu);
  let b1 = f32((value >> 8u) & 0xFFu);
  let b2 = f32((value >> 16u) & 0xFFu);
  let b3 = f32((value >> 24u) & 0xFFu);
  // The +0.5 offset matches core (keeps value 1 off pure red). fract() reduces
  // the accumulated hue into [0,1) exactly as core's `.fract()`.
  let sum = b0 * w0 + b1 * w1 + b2 * w2 + b3 * w3 + 0.5;
  let hue = fract(sum);

  // Fixed saturation; brightness dithers by id parity (matches core).
  let s = 0.65;
  let v = select(0.88, 0.98, (value & 1u) == 1u);

  // Standard six-sector HSV→RGB (core `hsv_to_rgb`).
  let h6 = fract(hue) * 6.0;
  let sector = i32(floor(h6));
  let f = h6 - floor(h6);
  let p = v * (1.0 - s);
  let q = v * (1.0 - s * f);
  let t = v * (1.0 - s * (1.0 - f));
  var rgb = vec3<f32>(v, p, q);
  switch (sector) {
    case 0: { rgb = vec3<f32>(v, t, p); }
    case 1: { rgb = vec3<f32>(q, v, p); }
    case 2: { rgb = vec3<f32>(p, v, t); }
    case 3: { rgb = vec3<f32>(p, q, v); }
    case 4: { rgb = vec3<f32>(t, p, v); }
    default: { rgb = vec3<f32>(v, p, q); }
  }
  // Core rounds each channel to u8 then the web divides by 255; matching that
  // (round, /255) keeps the shader-computed colour identical to the LUT-baked one.
  return round(rgb * 255.0) / 255.0;
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

@fragment
fn fs(input: VSOut) -> @location(0) vec4f {
  // Apply inverse transform to get texture UV
  let texUV4 = u.transform * vec4f(input.uv, 0.0, 1.0);
  let texUV = texUV4.xy;

  // Bounds check — transparent for compositing
  if (texUV.x < 0.0 || texUV.x > 1.0 || texUV.y < 0.0 || texUV.y > 1.0) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }

  // FOV member border: detect fragments within 1.5 px of the member edge
  let border_width = 1.5;
  let edge_x = min(texUV.x, 1.0 - texUV.x);
  let edge_y = min(texUV.y, 1.0 - texUV.y);
  let dist_x_px = edge_x * u.memberScreenSize.x;
  let dist_y_px = edge_y * u.memberScreenSize.y;
  let edge_min_px = min(dist_x_px, dist_y_px);
  if (edge_min_px < border_width) {
    return vec4f(0.3, 0.3, 0.3, 1.0);
  }

  let entity = entityDescriptors[currentEntity.index.x];

  // Label overlay branch: an integer-indexed mask, tinted via the label LUT and
  // composited OVER the intensity image. Skips contrast/gamma/colormap
  // entirely — a label id is a category, not a brightness. Background (id 0)
  // and not-yet-resident chunks are transparent so the intensity image (drawn
  // in an earlier pass) shows through.
  if (entity.isLabel == 1u) {
    let overlayOpacity = clamp(entity.labelOverlayOpacity, 0.0, 1.0);
    if (overlayOpacity <= 0.0) {
      return vec4f(0.0, 0.0, 0.0, 0.0);
    }
    // Labels use the detail tier only (no coarse/proxy fallback for masks).
    let labelVal = sampleLabel2D(entity.detailSource, texUV);
    if (labelVal == 0xFFFFFFFFu || labelVal == 0u) {
      return vec4f(0.0, 0.0, 0.0, 0.0);
    }
    // Full u32 id → colour, in two ranges so large ids are honoured (no
    // truncation): the 256×256 LUT holds the flat 65536-entry table row-major
    // (entry `idx` at (idx & 255, idx >> 8), no sampler/interpolation, explicit
    // `image-label.colors` over a glasbey fill) for `idx < 65536`; ids the LUT
    // cannot hold (`>= 65536`) get the SAME glasbey colour computed in-shader.
    // Previously this masked the id to its low 16 bits before the lookup,
    // collapsing e.g. 70000→4464 and any multiple of 65536→0 (transparent) —
    // the defect this fixes.
    var rgb: vec3<f32>;
    if (labelVal < 65536u) {
      rgb = textureLoad(labelLutTex, vec2i(i32(labelVal & 255u), i32(labelVal >> 8u)), 0).rgb;
    } else {
      rgb = glasbey_wgsl(labelVal);
    }
    // Premultiplied over-compositing: colour scaled by opacity, alpha =
    // opacity, so the compositor blends the tint onto the intensity image.
    return vec4f(rgb * overlayOpacity, overlayOpacity);
  }

  let intensityMin = entity.contrastMin;
  let intensityMax = entity.contrastMax;
  let range = intensityMax - intensityMin;
  let gamma = entity.gamma;
  let layerOpacity = entity.opacity;

  var chunkVal = 0xFFFFFFFFu;
  let hasTierSources = entity.detailSource.valid != 0u || entity.coarseSource.valid != 0u;

  if (hasTierSources) {
    // Source-backed path: selected detail → configured coarse → blank.
    chunkVal = sampleDetail2D(entity.detailSource, texUV);
    if (chunkVal == 0xFFFFFFFFu) {
      chunkVal = sampleCoarse2D(entity.coarseSource, texUV);
    }
  } else {
    // Legacy semantic fallback chain:
    //   target detail LOD → coarser detail LODs → field proxy → well proxy → empty
    let numLods = entity.lodCount;
    let targetIdx = u.lodParams.x;

    for (var i = targetIdx; i < numLods; i++) {
      let lod = entity.lods[i];
      let levelDims = vec2u(lod.levelDims.x, lod.levelDims.y);
      let chunkDims = vec2u(lod.chunkDims.x, lod.chunkDims.y);
      let gridDims = vec2u(lod.gridDims.x, lod.gridDims.y);
      let offset = lod.indirectionOffset;

      let texCoord = vec2i(
        clamp(i32(texUV.x * f32(levelDims.x)), 0, i32(levelDims.x) - 1),
        clamp(i32(texUV.y * f32(levelDims.y)), 0, i32(levelDims.y) - 1),
      );

      let chunkCoord = vec2u(
        u32(texCoord.x) / chunkDims.x,
        u32(texCoord.y) / chunkDims.y,
      );
      let gridIdx = offset + chunkCoord.y * gridDims.x + chunkCoord.x;
      let slot = detailIndirection[gridIdx];

      if (slot != 0xFFFFFFFFu) {
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
        chunkVal = textureLoad(detailTex, atlasCoord, 0).r;
        break;
      }
    }

    if (chunkVal == 0xFFFFFFFFu) {
      let fieldSlot = entity.fieldProxySlotIndex;
      if (fieldSlot != 0xFFFFFFFFu) {
        let v = sampleProxy2D(fieldProxyTex, fieldSlot, entity.fieldProxyDims, texUV);
        if (v != 0xFFFFFFFFu) { chunkVal = v; }
      }
    }
    if (chunkVal == 0xFFFFFFFFu) {
      let wellSlot = entity.wellProxySlotIndex;
      if (wellSlot != 0xFFFFFFFFu) {
        let v = sampleProxy2D(wellProxyTex, wellSlot, entity.wellProxyDims, texUV);
        if (v != 0xFFFFFFFFu) { chunkVal = v; }
      }
    }
  }

  if (chunkVal == 0xFFFFFFFFu) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }
  let normalized = pow(clamp((f32(chunkVal) - intensityMin) / range, 0.0, 1.0), gamma);
  let color = textureSampleLevel(lutTex, lutSampler, vec2f(normalized, 0.5), 0.0).rgb;
  return vec4f(color * layerOpacity, layerOpacity);
}
