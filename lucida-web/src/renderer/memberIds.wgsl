// A member batch's id pass: every pixel inside a member's rect takes the
// member's instance index, so that one full-screen draw of volume.wgsl's
// `fs` marches each member through the same ray the full-screen triangle
// gives the pixel when the member is drawn alone. A batch's rects do
// not meet, so a pixel has at most one member.

// Matches MemberInstance in volume.wgsl.
struct MemberInstance {
  ndcRect: vec4f,
  entity: u32,
  draw: u32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var<storage, read> instances: array<MemberInstance>;

struct RectOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) instance: u32,
};

// Two triangles over the instance's rect. Its corners lie on pixel edges, so
// it covers exactly the pixels a scissor of the same rect passes.
@vertex
fn vs(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> RectOut {
  let r = instances[iid].ndcRect;
  var corners = array<vec2f, 6>(
    vec2f(r.x, r.y), vec2f(r.z, r.y), vec2f(r.x, r.w),
    vec2f(r.x, r.w), vec2f(r.z, r.y), vec2f(r.z, r.w),
  );
  var out: RectOut;
  out.pos = vec4f(corners[vid], 0.0, 1.0);
  out.instance = iid;
  return out;
}

@fragment
fn fs(input: RectOut) -> @location(0) u32 {
  return input.instance;
}
