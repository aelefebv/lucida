// Peer cursor rendering: crosshairs (2D) and billboard rays (3D).
// Uses instancing: each instance = one cursor.
// type 0 (crosshair): 3 quads = 18 verts. type 1 (ray): 3 quads = 18 verts.

struct Uniforms {
  view_proj: mat4x4f,  // 3D camera (64 bytes, offset 0)
  params: vec4f,       // x=canvas_w, y=canvas_h, z=arm_length, w=line_width (offset 64)
  camera_2d: vec4f,    // x=zoom, y=center_x, z=center_y, w=mode (0=2d,1=3d) (offset 80)
  extra: vec4f,        // x=opacity_scale, y=ray_width (offset 96)
};

struct CursorInstance {
  position: vec4f,     // xyz=pos (voxel for 2D, world for 3D), w=cursor_type
  color: vec4f,        // rgba
  end_point: vec4f,    // xyz=ray end (3D only)
  marker: vec4f,       // xyz=marker pos (3D only)
};

struct VsOutput {
  @builtin(position) pos: vec4f,
  @location(0) color: vec4f,
  @location(1) remapped_depth: f32, // clip.z/clip.w * 0.5 + 0.5, matches volume frag_depth
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> cursors: array<CursorInstance>;
@group(0) @binding(2) var depthTex: texture_depth_2d;

// Quad corner from local vertex index [0..5]
fn quad_corner(local: u32) -> vec2f {
  let qx = select(-1.0, 1.0, local == 1u || local == 4u || local == 5u);
  let qy = select(-1.0, 1.0, local == 2u || local == 3u || local == 5u);
  return vec2f(qx, qy);
}

fn crosshair_vertex(cursor: CursorInstance, vid: u32) -> vec4f {
  let zoom = u.camera_2d.x;
  let cx = u.camera_2d.y;
  let cy = u.camera_2d.z;
  let cw = u.params.x;
  let ch = u.params.y;
  let arm = u.params.z;
  let lw = u.params.w;

  let base_x = (cursor.position.x - cx) * zoom * 2.0 / cw;
  let base_y = -(cursor.position.y - cy) * zoom * 2.0 / ch;

  let px = 2.0 / cw;
  let py = 2.0 / ch;

  let quad = vid / 6u;
  let q = quad_corner(vid % 6u);

  var dx: f32; var dy: f32;
  if (quad == 0u) { dx = q.x * arm; dy = q.y * lw * 0.5; }
  else if (quad == 1u) { dx = q.x * lw * 0.5; dy = q.y * arm; }
  else { dx = q.x * lw; dy = q.y * lw; }

  return vec4f(base_x + dx * px, base_y - dy * py, 0.0, 1.0);
}

fn ray_vertex(cursor: CursorInstance, vid: u32) -> vec4f {
  let cw = u.params.x;
  let ch = u.params.y;
  let arm = u.params.z;
  let lw = u.params.w;
  let ray_width = u.extra.y;

  let quad = vid / 6u;
  let q = quad_corner(vid % 6u);

  if (quad == 0u) {
    // Billboard line between start and end, extended 40px past each end
    let clip0 = u.view_proj * vec4f(cursor.position.xyz, 1.0);
    let clip1 = u.view_proj * vec4f(cursor.end_point.xyz, 1.0);

    // Screen-space direction
    let ndc0 = clip0.xy / clip0.w;
    let ndc1 = clip1.xy / clip1.w;
    let s0 = ndc0 * vec2f(cw, ch) * 0.5;
    let s1 = ndc1 * vec2f(cw, ch) * 0.5;
    let sdir = s1 - s0;
    let slen = length(sdir);
    let line_dir = select(vec2f(1.0, 0.0), sdir / slen, slen > 0.001);
    let perp = vec2f(-line_dir.y, line_dir.x) * ray_width * 0.5;
    let offset_ndc = perp * 2.0 / vec2f(cw, ch);

    // Select endpoint based on qy (-1 = start, +1 = end)
    let clip_base = select(clip0, clip1, q.y > 0.0);
    let offset = vec4f(offset_ndc * clip_base.w * q.x, 0.0, 0.0);
    return clip_base + offset;
  } else {
    // Marker crosshair at marker position (quads 1 & 2)
    let clip_m = u.view_proj * vec4f(cursor.marker.xyz, 1.0);
    let px = 2.0 / cw;
    let py = 2.0 / ch;

    var dx: f32; var dy: f32;
    if (quad == 1u) { dx = q.x * arm; dy = q.y * lw * 0.5; }
    else { dx = q.x * lw * 0.5; dy = q.y * arm; }

    let offset = vec4f(dx * px * clip_m.w, -dy * py * clip_m.w, 0.0, 0.0);
    return clip_m + offset;
  }
}

@vertex
fn vs(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> VsOutput {
  let cursor = cursors[iid];
  var out: VsOutput;
  out.color = cursor.color;

  let mode = u32(u.camera_2d.w);
  let cursor_type = u32(cursor.position.w);

  if (mode == 0u && cursor_type == 0u) {
    out.pos = crosshair_vertex(cursor, vid);
  } else if (mode == 1u && cursor_type == 1u) {
    out.pos = ray_vertex(cursor, vid);
  } else {
    out.pos = vec4f(0.0, 0.0, 0.0, 1.0);
    out.color = vec4f(0.0);
  }

  // Remap depth to match volume frag_depth convention (OpenGL [-1,1] → [0,1])
  out.remapped_depth = out.pos.z / out.pos.w * 0.5 + 0.5;

  return out;
}

@fragment
fn fs(input: VsOutput) -> @location(0) vec4f {
  var opacity_scale = u.extra.x;

  // In 3D mode, compare fragment depth against volume depth for dimming
  let mode = u32(u.camera_2d.w);
  if (mode == 1u) {
    let cursor_depth = input.remapped_depth; // same [0,1] space as volume frag_depth
    let coord = vec2i(input.pos.xy);
    let vol_depth = textureLoad(depthTex, coord, 0);
    if (cursor_depth > vol_depth) {
      opacity_scale *= 0.3; // behind volume: dim to 30%
    }
  }

  let a = input.color.a * opacity_scale;
  if (a < 0.001) { discard; }
  return vec4f(input.color.rgb * a, a);
}
