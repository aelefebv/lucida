from opengl_run.window import LucidaWindow
from opengl_run.shader import Shader
from opengl_run.render import Renderer, Clearer
from OpenGL import GL as gl
import numpy as np
import glfw
from pathlib import Path

window = LucidaWindow(800, 600, "Hello OpenGL")
window.renderers.append(Clearer())

shader_dir = Path(r"C:\Users\austin\GitHub\lucida\opengl_run\shaders")
vs_path = shader_dir / 'set_uniform.vs'
fs_path = shader_dir / 'set_uniform.fs'
shader = Shader(vs_path, fs_path)

vertices = np.array([
    -0.5, -0.5, 0.0,
     0.5, -0.5, 0.0,
     0.0,  0.5, 0.0
], dtype=np.float32)

vao = gl.glGenVertexArrays(1)
vbo = gl.glGenBuffers(1)
attr_size = 3

gl.glBindVertexArray(vao)
gl.glBindBuffer(gl.GL_ARRAY_BUFFER, vbo)
gl.glBufferData(gl.GL_ARRAY_BUFFER, vertices.nbytes, vertices, gl.GL_STATIC_DRAW)
gl.glVertexAttribPointer(0, attr_size, gl.GL_FLOAT, gl.GL_FALSE, attr_size * gl.sizeof(gl.GLfloat), None)
gl.glEnableVertexAttribArray(0)

class ColorChanger(Renderer):
    def update(self, dt: float):
        gl.glUseProgram(shader.program)
        time = glfw.get_time()
        green_value = np.sin(time * 5) / 2.0 + 0.5
        shader.set_uniform("custom_color", (0.0, green_value, 0.0, 1.0))
        
        gl.glBindVertexArray(vao)
        gl.glDrawArrays(gl.GL_TRIANGLES, 0, len(vertices) // attr_size)

window.renderers.append(ColorChanger())

window.run()
