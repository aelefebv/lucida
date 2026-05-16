// 2D slice viewer shader — GPU-side u16→u8 normalization

struct Uniforms {
  transform: mat4x4f,       // offset 0   (64 bytes) — inverse pan/zoom (screen UV → texture UV)
  atlasSlotDims: vec4u,      // offset 64  (16 bytes) — xy=slots per axis = 128 total
  memberScreenSize: vec4f,   // offset 80  (16 bytes) — xy=member pixel size on screen
  lodParams: vec4u,          // offset 96  (16 bytes) — x=targetLodIdx
  // total = 112 bytes
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
  _pad_tail0: u32,
  _pad_tail1: u32,
  lods: array<LodInfo, 8>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var chunkTex: texture_2d<u32>;
@group(0) @binding(2) var<storage, read> indirection: array<u32>;
@group(0) @binding(3) var lutTex: texture_2d<f32>;
@group(0) @binding(4) var lutSampler: sampler;
// Proxy textures are 3D (same as volume.wgsl); slice mode reads one Z
// plane within the slot region.
@group(0) @binding(5) var fieldProxyTex: texture_3d<u32>;
@group(0) @binding(6) var wellProxyTex: texture_3d<u32>;

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
// Z midpoint. Slot layout (1-D-along-X) and dim convention match
// `proxyAtlas.ts` (`slotDims: [Z, Y, X]` → `dims.x=Z, dims.y=Y, dims.z=X`).
fn sampleProxy2D(tex: texture_3d<u32>, slotIdx: u32, dims: vec3<u32>, uv: vec2f) -> u32 {
  if (slotIdx == 0xFFFFFFFFu) {
    return 0xFFFFFFFFu;
  }
  let slotZ = dims.x;
  let slotY = dims.y;
  let slotX = dims.z;
  let originX = slotIdx * slotX;
  let voxX = clamp(u32(uv.x * f32(slotX)), 0u, slotX - 1u);
  let voxY = clamp(u32(uv.y * f32(slotY)), 0u, slotY - 1u);
  let voxZ = slotZ / 2u;
  let coord = vec3i(
    i32(originX + voxX),
    i32(voxY),
    i32(voxZ),
  );
  return textureLoad(tex, coord, 0).r;
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

  let intensityMin = entity.contrastMin;
  let intensityMax = entity.contrastMax;
  let range = intensityMax - intensityMin;
  let gamma = entity.gamma;
  let layerOpacity = entity.opacity;

  // Unified semantic fallback chain (DOMAINS §6.5):
  //   target detail LOD → coarser detail LODs → field proxy → well proxy → empty
  // Sentinels make unavailable steps no-ops: when `lodCount == 0` the
  // detail loop is a no-op; when a proxy slot is `0xFFFFFFFFu` the proxy
  // step is a no-op. Same field-to-well caveat as volume.wgsl: the
  // well-proxy sample uses field-local UV, which is spatially incorrect
  // for field entries but visually non-blank.
  var chunkVal = 0xFFFFFFFFu;
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
    let slot = indirection[gridIdx];

    if (slot != 0xFFFFFFFFu) {
      let slotCoord = vec2u(
        slot % u.atlasSlotDims.x,
        slot / u.atlasSlotDims.x,
      );
      let localTexel = vec2u(
        u32(texCoord.x) % chunkDims.x,
        u32(texCoord.y) % chunkDims.y,
      );
      let atlasCoord = vec2i(
        i32(slotCoord.x * chunkDims.x + localTexel.x),
        i32(slotCoord.y * chunkDims.y + localTexel.y),
      );
      chunkVal = textureLoad(chunkTex, atlasCoord, 0).r;
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

  if (chunkVal == 0xFFFFFFFFu) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }
  let normalized = pow(clamp((f32(chunkVal) - intensityMin) / range, 0.0, 1.0), gamma);
  let color = textureSampleLevel(lutTex, lutSampler, vec2f(normalized, 0.5), 0.0).rgb;
  return vec4f(color * layerOpacity, layerOpacity);
}
