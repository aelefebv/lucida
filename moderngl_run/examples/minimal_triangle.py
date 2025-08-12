import glfw
import moderngl
import numpy as np
from pathlib import Path

if not glfw.init():
    raise RuntimeError("Failed to initialize GLFW")

glfw.window_hint(glfw.CONTEXT_VERSION_MAJOR, 3)
glfw.window_hint(glfw.CONTEXT_VERSION_MINOR, 3)
glfw.window_hint(glfw.OPENGL_PROFILE, glfw.OPENGL_CORE_PROFILE)

window = glfw.create_window(800, 600, "ModernGL Window", None, None)
if not window:
    glfw.terminate()
    raise RuntimeError("Failed to create GLFW window")

glfw.make_context_current(window)

ctx = moderngl.create_context()
width, height = glfw.get_framebuffer_size(window)
ctx.viewport = (0, 0, width, height)

shader_dir = Path(r"C:\Users\austin\GitHub\lucida\moderngl_run\shaders")
vert_shader_path = shader_dir / 'vert.glsl'
vert_shader = open(vert_shader_path, 'r').read()
frag_shader_path = shader_dir / 'frag.glsl'
frag_shader = open(frag_shader_path, 'r').read()
prog = ctx.program(
    vertex_shader=vert_shader,
    fragment_shader=frag_shader
)

vertices = np.array([
    0.0, 0.5,
    -0.5, -0.5,
    0.5, -0.5
], dtype=np.float32)
vbo = ctx.buffer(vertices.tobytes())

vao = ctx.vertex_array(
    prog,
    [(vbo, '2f', 'in_pos'),]
)

while not glfw.window_should_close(window):
    glfw.poll_events()
    ctx.clear(color=(0.1, 0.12, 0.15, 1.0))
    vao.render(moderngl.TRIANGLES)
    glfw.swap_buffers(window)

glfw.terminate()
ctx.release()
print("Window closed and context released.")
