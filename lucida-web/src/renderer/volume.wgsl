// Volume ray marching shader for OME-Zarr 3D rendering

struct Uniforms {
  invViewProj: mat4x4f,      // offset 0   (64 bytes)
  cameraPos: vec4f,           // offset 64  (16 bytes)
  volumeDims: vec4f,          // offset 80  (16 bytes)
  // M2: stepInfo.x=opacityScale (translucent compositing constant),
  // stepInfo.y=stepSize, stepInfo.z=renderMode (0=translucent,1=MIP),
  // stepInfo.w=reserved. Per-entity contrast/gamma/opacity moved into
  // the descriptor buffer.
  stepInfo: vec4f,            // offset 96  (16 bytes)
  atlasSlotDims: vec4u,       // offset 112 (16 bytes) — xyz=slots per axis
  viewProj: mat4x4f,          // offset 128 (64 bytes)
  camForward: vec4f,          // offset 192 (16 bytes) — xyz=camera forward dir
  clipParams: vec4f,          // offset 208 (16 bytes) — x=clipDist, y=clipMode (0=plane,1=sphere), zw=reserved
  // M1: lodParams.x = targetLodIdx; lodCount comes from the descriptor
  // buffer. renderMode (proxyParams.x in legacy layout) stays per-draw.
  // proxyParams: x=renderMode (0=detailOnly, 1=well-as-proxy,
  //   2=detailWithProxyFallback), yzw=reserved.
  lodParams: vec4u,           // offset 224 (16 bytes) — x=targetLodIdx
  proxyParams: vec4u,         // offset 240 (16 bytes)
  // total = 256 bytes
};

// M1: per-draw uniform with the entity index into entityDescriptors.
struct EntityRef { index: vec4u }; // x = entity index

// M1: per-entity descriptor. Layout matches descriptorBuffer.ts.
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
@group(0) @binding(1) var volumeTex: texture_3d<u32>;
@group(0) @binding(2) var<storage, read> indirection: array<u32>;
@group(0) @binding(3) var lutTex: texture_2d<f32>;
@group(0) @binding(4) var lutSampler: sampler;
// S8: proxy textures. Same r16uint format as the chunk atlas. A slot
// occupies texture region [slotIdx * dims.z, 0, 0] of size dims (X=dims.z,
// Y=dims.y, Z=dims.x), matching `proxySlotOrigin()` in proxyAtlas.ts.
@group(0) @binding(5) var fieldProxyTex: texture_3d<u32>;
@group(0) @binding(6) var wellProxyTex: texture_3d<u32>;

// M1: per-dataset descriptor table + per-draw entity index.
@group(1) @binding(0) var<storage, read> entityDescriptors: array<EntityDescriptor>;
@group(1) @binding(1) var<uniform> currentEntity: EntityRef;

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
//
// M1: dims is now read straight from the descriptor as a vec3<u32>
// (fieldProxyDims / wellProxyDims) — same Z/Y/X convention.
fn sampleProxy(tex: texture_3d<u32>, slotIdx: u32, dims: vec3<u32>, frac: vec3f) -> u32 {
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
//
// M1: lod array, proxy slot indices and proxy dims all come from the
// per-entity descriptor; renderMode and targetLodIdx remain per-draw.
fn sampleWithFallback(pos: vec3f) -> u32 {
  let renderMode = u.proxyParams.x;
  let entity = entityDescriptors[currentEntity.index.x];
  let fieldSlot = entity.fieldProxySlotIndex;
  let wellSlot = entity.wellProxySlotIndex;

  // S8: well-as-proxy short-circuit. Skip indirection; one direct sample
  // from the well's proxy slot. This is the major FPS win at far zoom.
  if (renderMode == 1u) {
    return sampleProxy(wellProxyTex, wellSlot, entity.wellProxyDims, pos);
  }

  let numLods = entity.lodCount;
  let targetIdx = u.lodParams.x;

  for (var i = targetIdx; i < numLods; i++) {
    let lod = entity.lods[i];
    let levelDims = vec3f(f32(lod.levelDims.x), f32(lod.levelDims.y), f32(lod.levelDims.z));
    let chunkDims = lod.chunkDims;
    let gridDims = lod.gridDims;
    let offset = lod.indirectionOffset;

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
      let v = sampleProxy(fieldProxyTex, fieldSlot, entity.fieldProxyDims, pos);
      if (v != 0xFFFFFFFFu) { return v; }
    }
    if (wellSlot != 0xFFFFFFFFu) {
      let v = sampleProxy(wellProxyTex, wellSlot, entity.wellProxyDims, pos);
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
  let entity = entityDescriptors[currentEntity.index.x];

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

  let dims = vec3i(u.volumeDims.xyz);
  // M2: per-entity display state from the descriptor buffer.
  let intensityMin = entity.contrastMin;
  let intensityMax = entity.contrastMax;
  let opacityScale = u.stepInfo.x;
  let stepSize = u.stepInfo.y;

  let range = intensityMax - intensityMin;
  let renderMode = i32(u.stepInfo.z);

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
      // Translucent: front-to-back blending
      let sampleAlpha = normalized * opacityScale;
      let sampleColor = textureSampleLevel(lutTex, lutSampler, vec2f(normalized, 0.5), 0.0).rgb;
      color += (1.0 - alpha) * sampleAlpha * sampleColor;
      alpha += (1.0 - alpha) * sampleAlpha;
    }

    t += adaptiveStep;
  }

  // M2: layer opacity from descriptor.
  let layerOpacity = entity.opacity;
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
