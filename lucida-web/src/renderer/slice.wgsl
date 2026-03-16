// 2D slice viewer shader — GPU-side u16→u8 normalization

struct Uniforms {
  transform: mat4x4f,       // offset 0   (64 bytes) — inverse pan/zoom (screen UV → texture UV)
  intensityRange: vec4f,     // offset 64  (16 bytes) — x=min, y=max, z=gamma, w=opacity
  chunkDims: vec4u,          // offset 80  (16 bytes) — xy=chunk dimensions
  gridDims: vec4u,           // offset 96  (16 bytes) — xy=grid dimensions
  atlasSlotDims: vec4u,      // offset 112 (16 bytes) — xy=slots per axis = 128 total
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var fallbackTex: texture_2d<u32>;
@group(0) @binding(2) var tileTex: texture_2d<u32>;
@group(0) @binding(3) var<storage, read> indirection: array<u32>;

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

  let intensityMin = u.intensityRange.x;
  let intensityMax = u.intensityRange.y;
  let range = intensityMax - intensityMin;
  let gamma = u.intensityRange.z;
  let layerOpacity = u.intensityRange.w;

  // Compute virtual texel coordinate from UV and tile texture dimensions
  let tileDims = vec2u(u.chunkDims.z, u.chunkDims.w); // volumeDims packed in chunkDims.zw
  let texCoord = vec2i(
    clamp(i32(texUV.x * f32(tileDims.x)), 0, i32(tileDims.x) - 1),
    clamp(i32(texUV.y * f32(tileDims.y)), 0, i32(tileDims.y) - 1),
  );

  // Atlas lookup
  let chunkCoord = vec2u(
    u32(texCoord.x) / u.chunkDims.x,
    u32(texCoord.y) / u.chunkDims.y,
  );
  let gridIdx = chunkCoord.y * u.gridDims.x + chunkCoord.x;
  let slot = indirection[gridIdx];

  if (slot != 0xFFFFFFFFu) {
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
    let tileVal = textureLoad(tileTex, atlasCoord, 0).r;
    let normalized = pow(clamp((f32(tileVal) - intensityMin) / range, 0.0, 1.0), gamma);
    return vec4f(vec3f(normalized) * layerOpacity, layerOpacity);
  }

  // Chunk not loaded — fall back to coarse texture
  let fbDims = textureDimensions(fallbackTex);
  let fbCoord = vec2i(
    clamp(i32(texUV.x * f32(fbDims.x)), 0, i32(fbDims.x) - 1),
    clamp(i32(texUV.y * f32(fbDims.y)), 0, i32(fbDims.y) - 1),
  );
  let fbVal = textureLoad(fallbackTex, fbCoord, 0).r;
  let normalized = pow(clamp((f32(fbVal) - intensityMin) / range, 0.0, 1.0), gamma);
  return vec4f(vec3f(normalized) * layerOpacity, layerOpacity);
}
