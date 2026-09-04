// Volume ray marching shader for OME-Zarr 3D rendering

// Matches DESCRIPTOR_MAX_LEVEL_SOURCES in descriptor/layout.ts: one level pool binding per slot.
const MAX_LEVEL_SOURCES: u32 = 4u;
// The indirection sentinel, and the sample value for "nothing resident here".
const MISS: u32 = 0xFFFFFFFFu;

struct Uniforms {
  invViewProj: mat4x4f,                // offset 0   (64 bytes)
  cameraPos: vec4f,                    // offset 64  (16 bytes)
  // stepInfo.x=opacityScale (translucent compositing constant),
  // stepInfo.y=renderMode (0=translucent,1=MIP), zw=reserved.
  stepInfo: vec4f,                     // offset 80  (16 bytes)
  levelAtlasSlotDims: array<vec4u, 4>, // offset 96  (64 bytes) — xyz=slots per axis, one per level pool binding
  coarseAtlasSlotDims: vec4u,          // offset 160 (16 bytes) — xyz=slots per axis
  viewProj: mat4x4f,                   // offset 176 (64 bytes)
  camForward: vec4f,                   // offset 240 (16 bytes) — xyz=camera forward dir
  clipParams: vec4f,                   // offset 256 (16 bytes) — x=clipDist, y=clipMode (0=plane,1=sphere), zw=reserved
  // total = 272 bytes
};

struct EntityRef { index: vec4u }; // x = entity index

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
  tileProxyPoolIndex: u32,
  tileProxySlotIndex: u32,
  groupProxyPoolIndex: u32,
  groupProxySlotIndex: u32,
  _pad_proxy0: u32,
  _pad_proxy1: u32,
  _pad_proxy2: u32,
  tileProxyDims: vec3<u32>,
  _pad_tile: u32,
  groupProxyDims: vec3<u32>,
  _pad_group: u32,
  contrastMin: f32,
  contrastMax: f32,
  gamma: f32,
  opacity: f32,
  colormapLutIndex: u32,
  levelSourceCount: u32,
  colormapMode: u32,
  labelOpacity: f32,
  levelSources: array<ChunkTierSource, 4>,
  coarseSource: ChunkTierSource,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var lutTex: texture_2d<f32>;
@group(0) @binding(2) var lutSampler: sampler;
@group(0) @binding(3) var coarseTex: texture_3d<u32>;
@group(0) @binding(4) var<storage, read> coarseIndirection: array<u32>;
// Proxy textures. Same r16uint format as the chunk atlas. Slots occupy
// a 3-D grid in the texture; the grid shape is derived from
// textureDimensions(tex) / slot dims, matching `proxySlotOrigin()` in
// proxyAtlas.ts.
@group(0) @binding(5) var tileProxyTex: texture_3d<u32>;
@group(0) @binding(6) var groupProxyTex: texture_3d<u32>;
// One level pool per resident-level slot. A level source's `poolIndex`
// says which of these it reads; levels of one entity may live in
// different pools when their chunk shapes differ.
@group(0) @binding(7) var levelTex0: texture_3d<u32>;
@group(0) @binding(8) var levelTex1: texture_3d<u32>;
@group(0) @binding(9) var levelTex2: texture_3d<u32>;
@group(0) @binding(10) var levelTex3: texture_3d<u32>;
@group(0) @binding(11) var<storage, read> levelIndirection0: array<u32>;
@group(0) @binding(12) var<storage, read> levelIndirection1: array<u32>;
@group(0) @binding(13) var<storage, read> levelIndirection2: array<u32>;
@group(0) @binding(14) var<storage, read> levelIndirection3: array<u32>;

@group(1) @binding(0) var<storage, read> entityDescriptors: array<EntityDescriptor>;
@group(1) @binding(1) var<uniform> currentEntity: EntityRef;
// Declared label palette for categorical draws: flat [id, packedRgba]
// pairs; `currentEntity.index.y` holds the pair count (0 for intensity).
@group(1) @binding(2) var<storage, read> labelColors: array<u32>;

// Active entity descriptor for the current fragment, populated once at
// the top of fs() and read by sampleWithFallback per ray sample. Reading
// from <private> (register-promoted in practice) instead of the storage
// buffer per sample recovers 3D FPS lost when descriptor data moved out
// of the per-frame uniform.
var<private> activeEntity: EntityDescriptor;

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

// Sample one voxel from a proxy atlas slot.
//   - `dims.x` = slot Z, `dims.y` = slot Y, `dims.z` = slot X (matches
//     `proxyAtlas.ts` `slotDims: [Z, Y, X]`).
//   - Slot origin is derived from slot index over a 3-D atlas grid.
//   - `frac` is in [0,1]³ over the slot's voxel cube; Y is flipped to
//     match the chunk path's image-convention sampling.
// Returns MISS if the slot index is the sentinel.
fn sampleProxy(tex: texture_3d<u32>, slotIdx: u32, dims: vec3<u32>, frac: vec3f) -> u32 {
  if (slotIdx == MISS) {
    return MISS;
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
  let voxX = clamp(u32(frac.x * f32(slotX)), 0u, slotX - 1u);
  let voxY = clamp(u32((1.0 - frac.y) * f32(slotY)), 0u, slotY - 1u);
  let voxZ = clamp(u32(frac.z * f32(slotZ)), 0u, slotZ - 1u);
  let coord = vec3i(
    i32(origin.x + voxX),
    i32(origin.y + voxY),
    i32(origin.z + voxZ),
  );
  return textureLoad(tex, coord, 0).r;
}

// The chunk-grid cell of one source under a local [0,1]^3 position, and
// the texel inside that chunk. Y is flipped for image convention.
struct Cell3D {
  gridIdx: u32,
  localTexel: vec3u,
  chunkDims: vec3u,
};

fn locateCell3D(source: ChunkTierSource, pos: vec3f) -> Cell3D {
  let levelDims = vec3f(f32(source.levelDims.x), f32(source.levelDims.y), f32(source.levelDims.z));
  let chunkDims = source.chunkDims;
  let gridDims = source.gridDims;
  let texCoord = vec3u(
    u32(clamp(i32(pos.x * levelDims.x), 0, i32(levelDims.x) - 1)),
    u32(clamp(i32((1.0 - pos.y) * levelDims.y), 0, i32(levelDims.y) - 1)),
    u32(clamp(i32(pos.z * levelDims.z), 0, i32(levelDims.z) - 1)),
  );
  let chunkCoord = texCoord / chunkDims;
  var cell: Cell3D;
  cell.gridIdx = source.indirectionOffset
    + chunkCoord.z * gridDims.y * gridDims.x
    + chunkCoord.y * gridDims.x
    + chunkCoord.x;
  cell.localTexel = texCoord % chunkDims;
  cell.chunkDims = chunkDims;
  return cell;
}

fn atlasCoord3D(slot: u32, slotDims: vec3u, cell: Cell3D) -> vec3i {
  let slotCoord = vec3u(
    slot % slotDims.x,
    (slot / slotDims.x) % slotDims.y,
    slot / (slotDims.x * slotDims.y),
  );
  return vec3i(slotCoord * cell.chunkDims + cell.localTexel);
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

fn levelTexelAt(poolIdx: u32, coord: vec3i) -> u32 {
  switch (poolIdx) {
    case 0u: { return textureLoad(levelTex0, coord, 0).r; }
    case 1u: { return textureLoad(levelTex1, coord, 0).r; }
    case 2u: { return textureLoad(levelTex2, coord, 0).r; }
    default: { return textureLoad(levelTex3, coord, 0).r; }
  }
}

fn sampleLevelVolume(source: ChunkTierSource, pos: vec3f) -> u32 {
  let slotDims = u.levelAtlasSlotDims[source.poolIndex].xyz;
  if (source.valid == 0u || slotDims.x == 0u || slotDims.y == 0u || slotDims.z == 0u) {
    return MISS;
  }
  let cell = locateCell3D(source, pos);
  let slot = levelSlotAt(source.poolIndex, cell.gridIdx);
  if (slot == MISS) {
    return MISS;
  }
  return levelTexelAt(source.poolIndex, atlasCoord3D(slot, slotDims, cell));
}

fn sampleCoarseVolume(source: ChunkTierSource, pos: vec3f) -> u32 {
  let slotDims = u.coarseAtlasSlotDims.xyz;
  if (source.valid == 0u || slotDims.x == 0u || slotDims.y == 0u || slotDims.z == 0u) {
    return MISS;
  }
  let cell = locateCell3D(source, pos);
  let slot = coarseIndirection[cell.gridIdx];
  if (slot == MISS) {
    return MISS;
  }
  return textureLoad(coarseTex, atlasCoord3D(slot, slotDims, cell), 0).r;
}

// The march step for a level: two thirds of one sample spacing along
// its densest axis, in local [0,1] units.
fn stepForDims(dims: vec3<u32>) -> f32 {
  let maxDim = max(max(dims.x, dims.y), dims.z);
  return 1.0 / (f32(max(maxDim, 1u)) * 1.5);
}

// One ray sample: the value and the march step of the level that
// answered. On a miss the step is the finest bound level's, so a
// resident chunk of it is never stepped over.
struct VolumeSample {
  value: u32,
  step: f32,
};

// Sampling order: the level sources finest first (the target level,
// then the coarser resident levels), then the coarse tier, then empty.
// Every sample comes from exactly one level; there is no blending.
//
// Proxy assets are consulted only when the entity binds no chunk tier at
// all (group-as-proxy entries). The group-proxy sample uses the tile's
// local `pos` (no tile-to-group transform): spatially incorrect for tile
// entries but non-blank while detail chunks load, and exact for
// group-as-proxy entries, which sample their own proxy at group-local
// coords.
fn sampleWithFallback(pos: vec3f) -> VolumeSample {
  var out: VolumeSample;
  out.value = MISS;
  out.step = 1.0;

  let count = min(activeEntity.levelSourceCount, MAX_LEVEL_SOURCES);
  if (count != 0u || activeEntity.coarseSource.valid != 0u) {
    for (var i = 0u; i < count; i++) {
      let v = sampleLevelVolume(activeEntity.levelSources[i], pos);
      if (v != MISS) {
        out.value = v;
        out.step = stepForDims(activeEntity.levelSources[i].levelDims);
        return out;
      }
    }
    let c = sampleCoarseVolume(activeEntity.coarseSource, pos);
    if (c != MISS) {
      out.value = c;
      out.step = stepForDims(activeEntity.coarseSource.levelDims);
      return out;
    }
    if (count != 0u) {
      out.step = stepForDims(activeEntity.levelSources[0].levelDims);
    } else {
      out.step = stepForDims(activeEntity.coarseSource.levelDims);
    }
    return out;
  }

  let tileSlot = activeEntity.tileProxySlotIndex;
  if (tileSlot != MISS) {
    out.step = stepForDims(activeEntity.tileProxyDims);
    let v = sampleProxy(tileProxyTex, tileSlot, activeEntity.tileProxyDims, pos);
    if (v != MISS) { out.value = v; return out; }
  }
  let groupSlot = activeEntity.groupProxySlotIndex;
  if (groupSlot != MISS) {
    out.step = stepForDims(activeEntity.groupProxyDims);
    let v = sampleProxy(groupProxyTex, groupSlot, activeEntity.groupProxyDims, pos);
    if (v != MISS) { out.value = v; return out; }
  }
  return out;
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

struct FsOut {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
};

@fragment
fn fs(input: VSOut) -> FsOut {
  activeEntity = entityDescriptors[currentEntity.index.x];
  let entity = activeEntity;

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

  let intensityMin = entity.contrastMin;
  let intensityMax = entity.contrastMax;
  let opacityScale = u.stepInfo.x;
  let renderMode = i32(u.stepInfo.y);

  let range = intensityMax - intensityMin;

  let rayLen = tEnd - tStart;
  // The march advances by the sampled level's own spacing, floored so the
  // ray always reaches tEnd within the step budget.
  let maxSteps = select(512, 256, renderMode == 1);
  let minStep = rayLen / f32(maxSteps);

  // Categorical label overlay: a first-hit colored surface, NOT translucent
  // accumulation (which yields noisy haze). March until the first non-zero
  // label voxel, paint its categorical color opaque at the per-label opacity,
  // record frag depth, and stop. MISS (not resident) and `0u` (background)
  // are transparent so the intensity volume shows through. Declared OME
  // colors win; the glasbey hash covers the rest. Nearest sampling (integer
  // ids never interpolate).
  if (entity.colormapMode == 1u) {
    let labelMinStep = rayLen / 512.0;
    var lt = tStart;
    for (var i = 0; i < 512; i++) {
      if (lt >= tEnd) { break; }
      let pos = ro + rd * lt;
      let s = sampleWithFallback(pos);
      if (s.value != MISS && s.value != 0u) {
        let labelRgba = labelColorFor(s.value, currentEntity.index.y);
        let labelOp = entity.labelOpacity * labelRgba.a;
        // Record frag depth at the surface so the cursor occludes correctly.
        let worldHit = entity.modelMatrix * vec4f(pos, 1.0);
        let clipHit = u.viewProj * worldHit;
        var hit: FsOut;
        hit.depth = clipHit.z / clipHit.w * 0.5 + 0.5;
        // Opaque paint at the per-label opacity (folds in the declared
        // alpha); premultiplied for the alpha-blend composite. Non-accumulated.
        hit.color = vec4f(labelRgba.rgb * labelOp, labelOp);
        return hit;
      }
      lt += max(s.step, labelMinStep);
    }
    // No label voxel along this ray: contribute nothing AND leave the
    // intensity volume's depth intact. `discard` skips both the color and
    // the frag_depth write — returning a far depth here would clobber the
    // intensity depth and break cursor occlusion behind the overlay.
    var labelMiss: FsOut;
    labelMiss.color = vec4f(0.0, 0.0, 0.0, 0.0);
    labelMiss.depth = 1.0;
    discard;
    return labelMiss;
  }

  // Front-to-back compositing
  var color = vec3f(0.0);
  var alpha = 0.0;
  var maxVal = 0.0;
  var t = tStart;
  var hitDepth = 1.0;
  var depthRecorded = false;

  for (var i = 0; i < maxSteps; i++) {
    if (t >= tEnd) { break; }
    if (renderMode == 0 && alpha >= 0.98) { break; } // early termination (translucent)
    if (renderMode == 1 && maxVal >= 0.98) { break; } // early termination (MIP)

    let pos = ro + rd * t;

    let s = sampleWithFallback(pos);
    let advance = max(s.step, minStep);
    if (s.value == MISS || s.value == 0u) {
      t += advance;
      continue;
    }
    let rawVal = f32(s.value);
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

    t += advance;
  }

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
