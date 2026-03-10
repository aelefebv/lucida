// Full-screen triangle compositor — samples an offscreen layer texture and outputs as-is.
// Blending is controlled by the pipeline blend state, not the shader.

@group(0) @binding(0) var layerTex: texture_2d<f32>;

struct VSOut {
  @builtin(position) pos: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) vid: u32) -> VSOut {
  var out: VSOut;
  let x = f32(i32(vid & 1u)) * 4.0 - 1.0;
  let y = f32(i32(vid >> 1u)) * 4.0 - 1.0;
  out.pos = vec4f(x, y, 0.0, 1.0);
  return out;
}

@fragment
fn fs(input: VSOut) -> @location(0) vec4f {
  let coord = vec2i(input.pos.xy);
  return textureLoad(layerTex, coord, 0);
}
