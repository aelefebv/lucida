// Draws one view's frame across the viewport its pass sets, the view's
// rectangle of the canvas. A view drawn at another scale than the canvas is
// filtered to fit.

@group(0) @binding(0) var frameTex: texture_2d<f32>;
@group(0) @binding(1) var frameSampler: sampler;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vid: u32) -> VSOut {
  var out: VSOut;
  let x = f32(i32(vid & 1u)) * 4.0 - 1.0;
  let y = f32(i32(vid >> 1u)) * 4.0 - 1.0;
  out.pos = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

@fragment
fn fs(input: VSOut) -> @location(0) vec4f {
  return textureSample(frameTex, frameSampler, input.uv);
}
