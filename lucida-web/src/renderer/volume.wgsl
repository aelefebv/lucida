// Volume ray marching shader for OME-Zarr 3D rendering

struct Uniforms {
  invViewProj: mat4x4f,      // offset 0   (64 bytes)
  modelMatrix: mat4x4f,      // offset 64  (64 bytes)
  invModelMatrix: mat4x4f,   // offset 128 (64 bytes)
  cameraPos: vec4f,           // offset 192 (16 bytes)
  volumeDims: vec4f,          // offset 208 (16 bytes)
  intensityRange: vec4f,      // offset 224 (16 bytes)
  displayParams: vec4f,       // offset 240 (16 bytes) — x=gamma
  chunkDims: vec4u,           // offset 256 (16 bytes) — xyz=chunk dimensions
  gridDims: vec4u,            // offset 272 (16 bytes) — xyz=grid dimensions
  atlasSlotDims: vec4u,       // offset 288 (16 bytes) — xyz=slots per axis
  viewProj: mat4x4f,          // offset 304 (64 bytes)
  camForward: vec4f,          // offset 368 (16 bytes) — xyz=camera forward dir
  clipParams: vec4f,          // offset 384 (16 bytes) — x=clipDist, y=clipMode (0=plane,1=sphere), zw=reserved
  lodParams: vec4u,           // offset 400 (16 bytes) — x=numLods, y=targetLodIdx
  lodGridDims: array<vec4u, 4>,   // offset 416 (64 bytes) — xyz=gridDims, w=indirection offset
  lodChunkDims: array<vec4u, 4>,  // offset 480 (64 bytes) — xyz=chunkDims
  lodLevelDims: array<vec4f, 4>,  // offset 544 (64 bytes) — xyz=level voxel dimensions
  // S8: proxy fallback — see proxyAtlas.ts for slot layout (1-D-along-X).
  // Slot dim convention matches proxyAtlas slotDims = [Z, Y, X]:
  //   proxyDims.x = Z, proxyDims.y = Y, proxyDims.z = X
  // proxyParams: x=renderMode (0=detailOnly, 1=proxyDirect/well-as-proxy,
  //   2=detailWithProxyFallback), y=fieldProxySlotIndex, z=wellProxySlotIndex (0xFFFFFFFF if absent), w=reserved.
  proxyParams: vec4u,         // offset 608 (16 bytes)
  fieldProxyDims: vec4u,      // offset 624 (16 bytes) — xyz = (Z, Y, X), w = reserved
  wellProxyDims: vec4u,       // offset 640 (16 bytes) — xyz = (Z, Y, X), w = reserved
  // total = 656 bytes
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var volumeTex: texture_3d<u32>;
@group(0) @binding(2) var<storage, read> indirection: array<u32>;
@group(0) @binding(3) var lutTex: texture_2d<f32>;
@group(0) @binding(4) var lutSampler: sampler;
// S8: proxy textures. Same r16uint format as the chunk atlas. A slot
// occupies texture region [slotIdx * dims.z, 0, 0] of size dims (X=dims.z,
// Y=dims.y, Z=dims.x), matching `proxySlotOrigin()` in proxyAtlas.ts.
@group(0) @binding(5) var fieldProxyTex: texture_3d<u32>;
@group(0) @binding(6) var wellProxyTex: texture_3d<u32>;

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

// S8: Sample one voxel from a proxy atlas slot.
//
//   - `dims.x` = slot Z, `dims.y` = slot Y, `dims.z` = slot X (matches
//     `proxyAtlas.ts` `slotDims: [Z, Y, X]`).
//   - Slot origin in the texture is `[slotIdx * dims.z, 0, 0]` (1-D-along-X
//     layout — see `proxySlotOrigin()`).
//   - `frac` is in [0,1]³ over the slot's voxel cube. We Y-flip to match
//     the chunk path's image-convention sampling.
//
// Returns 0xFFFFFFFFu if the slot index is the sentinel; otherwise the
// raw u16 voxel value (zero-extended into u32).
fn sampleProxy(tex: texture_3d<u32>, slotIdx: u32, dims: vec4u, frac: vec3f) -> u32 {
  if (slotIdx == 0xFFFFFFFFu) {
    return 0xFFFFFFFFu;
  }
  let slotZ = dims.x;
  let slotY = dims.y;
  let slotX = dims.z;
  let originX = slotIdx * slotX;
  let voxX = clamp(u32(frac.x * f32(slotX)), 0u, slotX - 1u);
  let voxY = clamp(u32((1.0 - frac.y) * f32(slotY)), 0u, slotY - 1u);
  let voxZ = clamp(u32(frac.z * f32(slotZ)), 0u, slotZ - 1u);
  let coord = vec3i(
    i32(originX + voxX),
    i32(voxY),
    i32(voxZ),
  );
  return textureLoad(tex, coord, 0).r;
}

// Sample from the atlas with multi-LOD fallback, then (renderMode == 2)
// proxy fallback chain: detail → fieldProxy → wellProxy.
//
// renderMode == 1 short-circuits to a direct wellProxy sample (used by
// well-as-proxy at far zoom).
//
// pos is in [0,1]³ local space. Tries target LOD first, then coarser LODs.
fn sampleWithFallback(pos: vec3f) -> u32 {
  let renderMode = u.proxyParams.x;
  let fieldSlot = u.proxyParams.y;
  let wellSlot = u.proxyParams.z;

  // S8: well-as-proxy short-circuit. Skip indirection; one direct sample
  // from the well's proxy slot. This is the major FPS win at far zoom.
  if (renderMode == 1u) {
    return sampleProxy(wellProxyTex, wellSlot, u.wellProxyDims, pos);
  }

  let numLods = u.lodParams.x;
  let targetIdx = u.lodParams.y;

  for (var i = targetIdx; i < numLods; i++) {
    let levelDims = u.lodLevelDims[i].xyz;
    let chunkDims = u.lodChunkDims[i].xyz;
    let gridDims = u.lodGridDims[i].xyz;
    let offset = u.lodGridDims[i].w;

    // Scale [0,1] position to this LOD's voxel space (Y-flipped for image convention)
    let texCoord = vec3i(
      clamp(i32(pos.x * levelDims.x), 0, i32(levelDims.x) - 1),
      clamp(i32((1.0 - pos.y) * levelDims.y), 0, i32(levelDims.y) - 1),
      clamp(i32(pos.z * levelDims.z), 0, i32(levelDims.z) - 1),
    );

    let chunkCoord = vec3u(
      u32(texCoord.x) / chunkDims.x,
      u32(texCoord.y) / chunkDims.y,
      u32(texCoord.z) / chunkDims.z,
    );
    let gridIdx = offset + chunkCoord.z * gridDims.y * gridDims.x
                + chunkCoord.y * gridDims.x
                + chunkCoord.x;
    let slot = indirection[gridIdx];

    if (slot != 0xFFFFFFFFu) {
      let slotCoord = vec3u(
        slot % u.atlasSlotDims.x,
        (slot / u.atlasSlotDims.x) % u.atlasSlotDims.y,
        slot / (u.atlasSlotDims.x * u.atlasSlotDims.y),
      );
      let localTexel = vec3u(
        u32(texCoord.x) % chunkDims.x,
        u32(texCoord.y) % chunkDims.y,
        u32(texCoord.z) % chunkDims.z,
      );
      let atlasCoord = vec3i(
        i32(slotCoord.x * chunkDims.x + localTexel.x),
        i32(slotCoord.y * chunkDims.y + localTexel.y),
        i32(slotCoord.z * chunkDims.z + localTexel.z),
      );
      return textureLoad(volumeTex, atlasCoord, 0).r;
    }
  }

  // S8: proxy fallback (renderMode == 2). Detail missed; try field proxy
  // first, then parent well proxy. Each `sampleProxy()` call returns
  // 0xFFFFFFFFu if its slot is the sentinel, so we cascade naturally.
  //
  // Note: the well-proxy sample uses the field's local `pos` (no
  // field-to-well transform yet — see S8 PRD #405 and follow-up).
  // Visually this means the well-proxy fallback in field-mode entries
  // will display proxy voxels at field-local coordinates, which is
  // spatially incorrect but produces a non-blank result while detail
  // chunks load. The FPS win comes from renderMode == 1 (well-as-proxy
  // at far zoom) which doesn't need the transform — it samples the
  // well's own proxy at well-local coords.
  if (renderMode == 2u) {
    if (fieldSlot != 0xFFFFFFFFu) {
      let v = sampleProxy(fieldProxyTex, fieldSlot, u.fieldProxyDims, pos);
      if (v != 0xFFFFFFFFu) { return v; }
    }
    if (wellSlot != 0xFFFFFFFFu) {
      let v = sampleProxy(wellProxyTex, wellSlot, u.wellProxyDims, pos);
      if (v != 0xFFFFFFFFu) { return v; }
    }
  }

  return 0xFFFFFFFFu;
}

struct FsOut {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
};

@fragment
fn fs(input: VSOut) -> FsOut {
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
          let localHitPt = (u.invModelMatrix * vec4f(worldHitPt, 1.0)).xyz;
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
          let localHitPt = (u.invModelMatrix * vec4f(worldHitPt, 1.0)).xyz;
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
  var hitDepth = 1.0;
  var depthRecorded = false;

  let maxSteps = i32(ceil(rayLen / adaptiveStep));
  let steps = select(min(maxSteps, 512), min(maxSteps, 256), renderMode == 1);

  for (var i = 0; i < steps; i++) {
    if (renderMode == 0 && alpha >= 0.98) { break; } // early termination (translucent)
    if (renderMode == 1 && maxVal >= 0.98) { break; } // early termination (MIP)

    let pos = ro + rd * t;

    var val = sampleWithFallback(pos);
    if (val == 0xFFFFFFFFu) {
      t += adaptiveStep;
      continue;
    }
    if (val == 0u) { t += adaptiveStep; continue; }
    let rawVal = f32(val);
    let gamma = u.displayParams.x;
    let normalized = pow(clamp((rawVal - intensityMin) / range, 0.0, 1.0), gamma);

    // Record depth at first significant sample
    if (!depthRecorded && normalized > 0.01) {
      let worldHit = u.modelMatrix * vec4f(pos, 1.0);
      let clipHit = u.viewProj * worldHit;
      // Remap from clip [-1,1] to viewport [0,1] to match rasterizer depth
      hitDepth = clipHit.z / clipHit.w * 0.5 + 0.5;
      depthRecorded = true;
    }

    if (renderMode == 1) {
      // MIP: track maximum intensity
      maxVal = max(maxVal, normalized);
    } else {
      // Translucent: front-to-back blending
      let sampleAlpha = normalized * opacityScale;
      let sampleColor = textureSampleLevel(lutTex, lutSampler, vec2f(normalized, 0.5), 0.0).rgb;
      color += (1.0 - alpha) * sampleAlpha * sampleColor;
      alpha += (1.0 - alpha) * sampleAlpha;
    }

    t += adaptiveStep;
  }

  // Pre-multiply by layer opacity for compositing
  let layerOpacity = u.displayParams.y;
  var out: FsOut;
  out.depth = hitDepth;
  if (renderMode == 1) {
    let mipColor = textureSampleLevel(lutTex, lutSampler, vec2f(maxVal, 0.5), 0.0).rgb;
    out.color = vec4f(mipColor, 1.0) * layerOpacity;
  } else {
    out.color = vec4f(color * layerOpacity, alpha * layerOpacity);
  }
  return out;
}
