// 2D slice viewer shader — GPU-side u16→u8 normalization

struct Uniforms {
  transform: mat4x4f,       // offset 0   (64 bytes) — inverse pan/zoom (screen UV → texture UV)
  intensityRange: vec4f,     // offset 64  (16 bytes) — x=min, y=max, z=gamma, w=opacity
  chunkDims: vec4u,          // offset 80  (16 bytes) — xy=chunk dimensions
  gridDims: vec4u,           // offset 96  (16 bytes) — xy=grid dimensions
  atlasSlotDims: vec4u,      // offset 112 (16 bytes) — xy=slots per axis = 128 total
  memberScreenSize: vec4f,   // offset 128 (16 bytes) — xy=member pixel size on screen
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var chunkTex: texture_2d<u32>;
@group(0) @binding(2) var<storage, read> indirection: array<u32>;
@group(0) @binding(3) var lutTex: texture_2d<f32>;
@group(0) @binding(4) var lutSampler: sampler;

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

  let intensityMin = u.intensityRange.x;
  let intensityMax = u.intensityRange.y;
  let range = intensityMax - intensityMin;
  let gamma = u.intensityRange.z;
  let layerOpacity = u.intensityRange.w;

  // Compute virtual texel coordinate from UV and level texture dimensions
  let levelDims = vec2u(u.chunkDims.z, u.chunkDims.w); // levelDims packed in chunkDims.zw
  let texCoord = vec2i(
    clamp(i32(texUV.x * f32(levelDims.x)), 0, i32(levelDims.x) - 1),
    clamp(i32(texUV.y * f32(levelDims.y)), 0, i32(levelDims.y) - 1),
  );

  // Atlas lookup
  let chunkCoord = vec2u(
    u32(texCoord.x) / u.chunkDims.x,
    u32(texCoord.y) / u.chunkDims.y,
  );
  let gridIdx = chunkCoord.y * u.gridDims.x + chunkCoord.x;
  let slot = indirection[gridIdx];

  if (slot == 0xFFFFFFFFu) {
    // Chunk not loaded — show as empty
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }

  // Decode slot to atlas position
  let slotCoord = vec2u(
    slot % u.atlasSlotDims.x,
    slot / u.atlasSlotDims.x,
  );
  let localTexel = vec2u(
    u32(texCoord.x) % u.chunkDims.x,
    u32(texCoord.y) % u.chunkDims.y,
  );
  let atlasCoord = vec2i(
    i32(slotCoord.x * u.chunkDims.x + localTexel.x),
    i32(slotCoord.y * u.chunkDims.y + localTexel.y),
  );
  let chunkVal = textureLoad(chunkTex, atlasCoord, 0).r;
  let normalized = pow(clamp((f32(chunkVal) - intensityMin) / range, 0.0, 1.0), gamma);
  let color = textureSampleLevel(lutTex, lutSampler, vec2f(normalized, 0.5), 0.0).rgb;
  return vec4f(color * layerOpacity, layerOpacity);
}
