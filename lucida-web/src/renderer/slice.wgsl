// 2D slice viewer shader — GPU-side u16→u8 normalization

struct Uniforms {
  transform: mat4x4f,       // offset 0   (64 bytes) — inverse pan/zoom (screen UV → texture UV)
  intensityRange: vec4f,     // offset 64  (16 bytes) — x=min, y=max, z=gamma, w=opacity
  chunkDims: vec4u,          // offset 80  (16 bytes) — xy=chunk dimensions
  gridDims: vec4u,           // offset 96  (16 bytes) — xy=grid dimensions
  atlasSlotDims: vec4u,      // offset 112 (16 bytes) — xy=slots per axis = 128 total
  memberScreenSize: vec4f,   // offset 128 (16 bytes) — xy=member pixel size on screen
  lodParams: vec4u,          // offset 144 (16 bytes) — x=numLods, y=targetLodIdx
  lodGridDims: array<vec4u, 4>,   // offset 160 (64 bytes) — xy=gridDims, w=indirection offset
  lodChunkDims: array<vec4u, 4>,  // offset 224 (64 bytes) — xy=chunkDims
  lodLevelDims: array<vec4f, 4>,  // offset 288 (64 bytes) — xy=level voxel dimensions
  // S8: proxy fallback. Slice samples a fixed Z plane within each
  // proxy slot; we use the slot's Z midpoint for the MVP. A proper
  // mapping from the dataset's current Z to the proxy's Z scale is a
  // follow-up (the proxy's Z extent is not generally aligned to the
  // dataset's full-res Z).
  // proxyParams: x=renderMode (0=detailOnly, 1=proxyDirect/well-as-proxy,
  //   2=detailWithProxyFallback), y=fieldProxySlotIndex,
  //   z=wellProxySlotIndex (0xFFFFFFFF if absent), w=reserved.
  proxyParams: vec4u,         // offset 352 (16 bytes)
  fieldProxyDims: vec4u,      // offset 368 (16 bytes) — xyz = (Z, Y, X)
  wellProxyDims: vec4u,       // offset 384 (16 bytes) — xyz = (Z, Y, X)
  // total = 400 bytes
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var chunkTex: texture_2d<u32>;
@group(0) @binding(2) var<storage, read> indirection: array<u32>;
@group(0) @binding(3) var lutTex: texture_2d<f32>;
@group(0) @binding(4) var lutSampler: sampler;
// S8: proxy textures are 3D (same as volume.wgsl). Slice mode reads
// one Z plane within the slot region.
@group(0) @binding(5) var fieldProxyTex: texture_3d<u32>;
@group(0) @binding(6) var wellProxyTex: texture_3d<u32>;

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

// S8: Sample one voxel from a proxy slot using 2D UV. Reads at the slot's
// Z midpoint — see header comment on `wellProxyTex` for the rationale and
// follow-up note. Slot layout (1-D-along-X) and dim convention match
// `proxyAtlas.ts` (`slotDims: [Z, Y, X]` → `dims.x=Z, dims.y=Y, dims.z=X`).
fn sampleProxy2D(tex: texture_3d<u32>, slotIdx: u32, dims: vec4u, uv: vec2f) -> u32 {
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

  let intensityMin = u.intensityRange.x;
  let intensityMax = u.intensityRange.y;
  let range = intensityMax - intensityMin;
  let gamma = u.intensityRange.z;
  let layerOpacity = u.intensityRange.w;

  let renderMode = u.proxyParams.x;
  let fieldSlot = u.proxyParams.y;
  let wellSlot = u.proxyParams.z;

  var chunkVal = 0xFFFFFFFFu;

  // S8: well-as-proxy short-circuit. Sample the well's proxy directly
  // at the slot's Z midpoint; skip indirection.
  if (renderMode == 1u) {
    chunkVal = sampleProxy2D(wellProxyTex, wellSlot, u.wellProxyDims, texUV);
  } else {
    // Multi-LOD atlas lookup with fallback
    let numLods = u.lodParams.x;
    let targetIdx = u.lodParams.y;

    for (var i = targetIdx; i < numLods; i++) {
      let levelDims = vec2u(u32(u.lodLevelDims[i].x), u32(u.lodLevelDims[i].y));
      let chunkDims = vec2u(u.lodChunkDims[i].x, u.lodChunkDims[i].y);
      let gridDims = vec2u(u.lodGridDims[i].x, u.lodGridDims[i].y);
      let offset = u.lodGridDims[i].w;

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

    // S8: proxy fallback (renderMode == 2). Detail missed; try field
    // proxy then parent well proxy at the slot's Z midpoint. Same
    // field-to-well caveat as volume.wgsl: well-proxy sample uses the
    // field's local UV, which is spatially incorrect but visually
    // non-blank. The intended visual win is renderMode == 1 above.
    if (chunkVal == 0xFFFFFFFFu && renderMode == 2u) {
      if (fieldSlot != 0xFFFFFFFFu) {
        let v = sampleProxy2D(fieldProxyTex, fieldSlot, u.fieldProxyDims, texUV);
        if (v != 0xFFFFFFFFu) { chunkVal = v; }
      }
      if (chunkVal == 0xFFFFFFFFu && wellSlot != 0xFFFFFFFFu) {
        let v = sampleProxy2D(wellProxyTex, wellSlot, u.wellProxyDims, texUV);
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
