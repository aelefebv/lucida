// Volume ray marching shader for OME-Zarr 3D rendering

struct Uniforms {
  invViewProj: mat4x4f,      // offset 0   (64 bytes)
  modelMatrix: mat4x4f,      // offset 64  (64 bytes)
  invModelMatrix: mat4x4f,   // offset 128 (64 bytes)
  cameraPos: vec4f,           // offset 192 (16 bytes)
  volumeDims: vec4f,          // offset 208 (16 bytes)
  intensityRange: vec4f,      // offset 224 (16 bytes)
  displayParams: vec4f,       // offset 240 (16 bytes) — x=gamma
  fallbackDims: vec4f,        // offset 256 (16 bytes) — xyz=dims, w=hasFallback
  chunkDims: vec4u,           // offset 272 (16 bytes) — xyz=chunk dimensions
  gridDims: vec4u,            // offset 288 (16 bytes) — xyz=grid dimensions
  atlasSlotDims: vec4u,       // offset 304 (16 bytes) — xyz=slots per axis = 320 total
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var volumeTex: texture_3d<u32>;
@group(0) @binding(2) var fallbackTex: texture_3d<u32>;
@group(0) @binding(3) var<storage, read> indirection: array<u32>;

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

fn sampleVolume(texCoord: vec3i) -> u32 {
  // Compute chunk grid coordinate
  let chunkCoord = vec3u(
    u32(texCoord.x) / u.chunkDims.x,
    u32(texCoord.y) / u.chunkDims.y,
    u32(texCoord.z) / u.chunkDims.z,
  );
  let gridIdx = chunkCoord.z * u.gridDims.y * u.gridDims.x
              + chunkCoord.y * u.gridDims.x
              + chunkCoord.x;
  let slot = indirection[gridIdx];

  if (slot == 0xFFFFFFFFu) {
    return 0u; // chunk not loaded — caller handles fallback
  }

  // Decode slot index to atlas grid position
  let slotCoord = vec3u(
    slot % u.atlasSlotDims.x,
    (slot / u.atlasSlotDims.x) % u.atlasSlotDims.y,
    slot / (u.atlasSlotDims.x * u.atlasSlotDims.y),
  );
  let localTexel = vec3u(
    u32(texCoord.x) % u.chunkDims.x,
    u32(texCoord.y) % u.chunkDims.y,
    u32(texCoord.z) % u.chunkDims.z,
  );
  let atlasCoord = vec3i(
    i32(slotCoord.x * u.chunkDims.x + localTexel.x),
    i32(slotCoord.y * u.chunkDims.y + localTexel.y),
    i32(slotCoord.z * u.chunkDims.z + localTexel.z),
  );
  return textureLoad(volumeTex, atlasCoord, 0).r;
}

@fragment
fn fs(input: VSOut) -> @location(0) vec4f {
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
  let localRo4 = u.invModelMatrix * vec4f(worldRo, 1.0);
  let localRd4 = u.invModelMatrix * vec4f(worldRd, 0.0);
  let ro = localRo4.xyz;
  let rd = normalize(localRd4.xyz);

  // Intersect unit cube [0,1]^3 representing the volume in local space
  let tt = intersectAABB(ro, rd);
  if (tt.x >= tt.y || tt.y < 0.0) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }

  let tStart = max(tt.x, 0.0);
  let tEnd = tt.y;

  let dims = vec3i(u.volumeDims.xyz);
  let intensityMin = u.intensityRange.x;
  let intensityMax = u.intensityRange.y;
  let opacityScale = u.intensityRange.z;
  let stepSize = u.intensityRange.w;

  let range = intensityMax - intensityMin;
  let renderMode = i32(u.displayParams.z);

  let rayLen = tEnd - tStart;
  let adaptiveStep = max(stepSize, rayLen / 512.0);

  // Front-to-back compositing
  var color = vec3f(0.0);
  var alpha = 0.0;
  var maxVal = 0.0;
  var t = tStart;

  let maxSteps = i32(ceil(rayLen / adaptiveStep));
  let steps = select(min(maxSteps, 512), min(maxSteps, 256), renderMode == 1);

  for (var i = 0; i < steps; i++) {
    if (renderMode == 0 && alpha >= 0.98) { break; } // early termination (translucent)
    if (renderMode == 1 && maxVal >= 0.98) { break; } // early termination (MIP)

    let pos = ro + rd * t;
    // Map [0,1] position to texel coordinates (flip Y to match 2D image convention)
    let texCoord = vec3i(
      clamp(i32(pos.x * f32(dims.x)), 0, dims.x - 1),
      clamp(i32((1.0 - pos.y) * f32(dims.y)), 0, dims.y - 1),
      clamp(i32(pos.z * f32(dims.z)), 0, dims.z - 1),
    );

    var val = sampleVolume(texCoord);
    if (val == 0u && u.fallbackDims.w > 0.5) {
      let fbDims = vec3i(u.fallbackDims.xyz);
      let fbCoord = vec3i(
        clamp(i32(pos.x * u.fallbackDims.x), 0, fbDims.x - 1),
        clamp(i32((1.0 - pos.y) * u.fallbackDims.y), 0, fbDims.y - 1),
        clamp(i32(pos.z * u.fallbackDims.z), 0, fbDims.z - 1),
      );
      val = textureLoad(fallbackTex, fbCoord, 0).r;
    }
    if (val == 0u) { t += adaptiveStep; continue; }
    let rawVal = f32(val);
    let gamma = u.displayParams.x;
    let normalized = pow(clamp((rawVal - intensityMin) / range, 0.0, 1.0), gamma);

    if (renderMode == 1) {
      // MIP: track maximum intensity
      maxVal = max(maxVal, normalized);
    } else {
      // Translucent: front-to-back blending
      let sampleAlpha = normalized * opacityScale;
      let sampleColor = vec3f(normalized);
      color += (1.0 - alpha) * sampleAlpha * sampleColor;
      alpha += (1.0 - alpha) * sampleAlpha;
    }

    t += adaptiveStep;
  }

  // Pre-multiply by layer opacity for compositing
  let layerOpacity = u.displayParams.y;
  if (renderMode == 1) {
    return vec4f(maxVal, maxVal, maxVal, 1.0) * layerOpacity;
  }
  return vec4f(color * layerOpacity, alpha * layerOpacity);
}
