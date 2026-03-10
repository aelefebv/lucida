// 2D slice viewer shader — GPU-side u16→u8 normalization

struct Uniforms {
  transform: mat4x4f,       // offset 0   (64 bytes) — inverse pan/zoom (screen UV → texture UV)
  intensityRange: vec4f,     // offset 64  (16 bytes) — x=min, y=max
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var fallbackTex: texture_2d<u32>;
@group(0) @binding(2) var tileTex: texture_2d<u32>;

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

  // Sample tile texture
  let tileDims = textureDimensions(tileTex);
  let tileCoord = vec2i(
    clamp(i32(texUV.x * f32(tileDims.x)), 0, i32(tileDims.x) - 1),
    clamp(i32(texUV.y * f32(tileDims.y)), 0, i32(tileDims.y) - 1),
  );
  let tileVal = textureLoad(tileTex, tileCoord, 0).r;

  let gamma = u.intensityRange.z;

  let layerOpacity = u.intensityRange.w;

  if (tileVal > 0u) {
    let normalized = pow(clamp((f32(tileVal) - intensityMin) / range, 0.0, 1.0), gamma);
    return vec4f(vec3f(normalized) * layerOpacity, layerOpacity);
  }

  // Fall back to coarse texture
  let fbDims = textureDimensions(fallbackTex);
  let fbCoord = vec2i(
    clamp(i32(texUV.x * f32(fbDims.x)), 0, i32(fbDims.x) - 1),
    clamp(i32(texUV.y * f32(fbDims.y)), 0, i32(fbDims.y) - 1),
  );
  let fbVal = textureLoad(fallbackTex, fbCoord, 0).r;
  let normalized = pow(clamp((f32(fbVal) - intensityMin) / range, 0.0, 1.0), gamma);
  return vec4f(vec3f(normalized) * layerOpacity, layerOpacity);
}
