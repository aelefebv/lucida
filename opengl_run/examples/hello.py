from opengl_run.window import LucidaWindow
from opengl_run.shader import Shader
from opengl_run.render import Renderer
from OpenGL import GL as gl
from pathlib import Path

window = LucidaWindow(800, 600, "Hello OpenGL")

class Clearer(Renderer):
    def update(self, dt: float):
        gl.glClearColor(0.0, 0.0, 0.0, 1.0)
        gl.glClear(gl.GL_COLOR_BUFFER_BIT)

window.renderers.append(Clearer())
window.run()

shader_dir = Path(r"C:\Users\austin\GitHub\lucida\opengl_run\shaders")
vs_path = shader_dir / 'set_uniform.vs'
fs_path = shader_dir / 'set_uniform.fs'
shader = Shader(vs_path, fs_path)


