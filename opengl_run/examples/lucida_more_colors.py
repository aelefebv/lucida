from opengl_run.window import LucidaWindow
from opengl_run.shader import Shader
from opengl_run.render import Renderer, Clearer
from OpenGL import GL as gl
import numpy as np
import glfw
from pathlib import Path
import ctypes

window = LucidaWindow(800, 600, "Hello OpenGL")
window.renderers.append(Clearer())

shader_dir = Path(r"C:\Users\austin\GitHub\lucida\opengl_run\shaders")
vs_path = shader_dir / 'lucida_more_colors.vs'
fs_path = shader_dir / 'lucida_more_colors.fs'
shader = Shader(vs_path, fs_path)

vertices = np.array([
    # Position        # Color
    -0.5, -0.5, 0.0,  1.0, 0.0, 0.0,
     0.5, -0.5, 0.0,  0.0, 1.0, 0.0,
     0.0,  0.5, 0.0,  0.0, 0.0, 1.0,
], dtype=np.float32)

vao = gl.glGenVertexArrays(1)
vbo = gl.glGenBuffers(1)
n = 2  # Number of attributes per vertex (position + color)
s = 3  # Size of each attribute (3 for vec3)
bits_per_vertex = n * s * gl.sizeof(gl.GLfloat)  # Total size per vertex in bytes
vn = len(vertices) // (n * s)  # Number of vertices
offset_size = s * gl.sizeof(gl.GLfloat)  # Size of each attribute in bytes

gl.glBindVertexArray(vao)
gl.glBindBuffer(gl.GL_ARRAY_BUFFER, vbo)
gl.glBufferData(gl.GL_ARRAY_BUFFER, vertices.nbytes, vertices, gl.GL_STATIC_DRAW)

gl.glVertexAttribPointer(0, s, gl.GL_FLOAT, gl.GL_FALSE, bits_per_vertex, ctypes.c_void_p(offset_size * 0))
gl.glEnableVertexAttribArray(0)
gl.glVertexAttribPointer(1, s, gl.GL_FLOAT, gl.GL_FALSE, bits_per_vertex, ctypes.c_void_p(offset_size * 1))
gl.glEnableVertexAttribArray(1)

class ColorChanger(Renderer):
    def update(self, dt: float):
        gl.glUseProgram(shader.program)
        time = glfw.get_time() * 5
        green_value = (np.sin(time * 1.5) + 1.0) / 2.0
        red_value = (np.sin(time * 2.3) + 1.0) / 2.0
        # blue_value = (np.sin(time * 1.8) + 1.0) / 2.0
        blue_value = 0.5
        shader.set_uniform("custom_color", (red_value, green_value, blue_value, 1.0))
        
        gl.glBindVertexArray(vao)
        gl.glDrawArrays(gl.GL_TRIANGLES, 0, vn)

window.renderers.append(ColorChanger())

window.run()
