from opengl_run.window import LucidaWindow
from opengl_run.shader import Shader
from opengl_run.render import Renderer, Clearer
from OpenGL import GL as gl
import numpy as np
import glfw
from pathlib import Path
import ctypes
import tifffile

window = LucidaWindow(800, 800, "Hello OpenGL")
window.renderers.append(Clearer())

shader_dir = Path(r"C:\Users\austin\GitHub\lucida\opengl_run\shaders")
vs_path = shader_dir / 'lucida_tif_texture.vs'
fs_path = shader_dir / 'lucida_tif_texture.fs'
shader = Shader(vs_path, fs_path)

tif_path = Path(r"D:\test_files\nellie_all_tests\yeast_3d_mitochondria.ome.tif")
test_np = tifffile.imread(tif_path)
mip = np.max(test_np[0], axis=0)  # Create a maximum intensity projection
test_np = np.flipud(mip)
# normalize to 0-65535 range
test_np = (test_np - np.min(test_np)) / (np.max(test_np) - np.min(test_np)) * 65535
test_np = test_np.astype(np.uint16)
im = np.ascontiguousarray(test_np, dtype=np.uint16)  # ensure packed rows
h, w = im.shape[-2:]
pixel_format = gl.GL_RED
gl_type = gl.GL_UNSIGNED_SHORT
internal_format = gl.GL_R16

tex = gl.glGenTextures(1)
gl.glBindTexture(gl.GL_TEXTURE_2D, tex)
gl.glPixelStorei(gl.GL_UNPACK_ALIGNMENT, 1)  # ensure no padding, rows are tightly packed
gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_MIN_FILTER, gl.GL_NEAREST)
gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_MAG_FILTER, gl.GL_NEAREST)
gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_WRAP_S, gl.GL_CLAMP_TO_BORDER)
gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_WRAP_T, gl.GL_CLAMP_TO_BORDER)

gl.glTexImage2D(
    gl.GL_TEXTURE_2D,  # target texture
    0,  # level of detail (0 is base level, others are mipmaps)
    internal_format,  # dtype, 
    w,  # width of the texture
    h,  # height of the texture
    0,  # border (must be 0..)
    pixel_format,  # pixel data format (number of color components), RED is 1 component
    gl_type,   # data type of the pixel data, UNSIGNED_SHORT is 2 bytes per pixel
    im  # the image data in memory
)

gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_SWIZZLE_R, gl.GL_RED)
gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_SWIZZLE_G, gl.GL_RED)
gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_SWIZZLE_B, gl.GL_RED)
gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_SWIZZLE_A, gl.GL_ONE)

gl.glBindTexture(gl.GL_TEXTURE_2D, 0)  # unbind texture

vertices = np.array([
    # Position         # Color           # Texture Coords
     1,  1, 0.0,   1.0, 0.0, 0.0,    1.0, 1.0,
     1, -1, 0.0,   0.0, 1.0, 1.0,    1.0, 0.0,
    -1, -1, 0.0,   0.0, 0.0, 1.0,    0.0, 0.0,
    -1,  1, 0.0,   1.0, 1.0, 0.0,    0.0, 1.0,
], dtype=np.float32)

indices = np.array([
    0, 1, 3,  # First triangle
    1, 2, 3   # Second triangle
], dtype=np.uint32)

vao = gl.glGenVertexArrays(1)
vbo = gl.glGenBuffers(1)
ebo = gl.glGenBuffers(1)

s = (3, 3, 2)  # Sizes of each attribute (3 for vec3)
attributes_per_vertex = sum(s)  # Total size per vertex in floats
types = (gl.GLfloat, gl.GLfloat, gl.GLfloat)  # Type of each attribute
n = len(s)
bits_per_vertex = np.sum([s[i] * gl.sizeof(types[i]) for i in range(n)])  # Total size per vertex in bytes
vn = len(vertices) // attributes_per_vertex  # Number of vertices
offsets = [s[i] * gl.sizeof(types[i]) for i in range(n)]  # Size of each attribute in bytes
offsets_cumul = np.cumsum(offsets)  # Cumulative offsets for each attribute
# VAO
gl.glBindVertexArray(vao)

# VBO
gl.glBindBuffer(gl.GL_ARRAY_BUFFER, vbo)
gl.glBufferData(gl.GL_ARRAY_BUFFER, vertices.nbytes, vertices, gl.GL_STATIC_DRAW)

gl.glBindBuffer(gl.GL_ELEMENT_ARRAY_BUFFER, ebo)
gl.glBufferData(gl.GL_ELEMENT_ARRAY_BUFFER, indices.nbytes, indices, gl.GL_STATIC_DRAW)

gl.glVertexAttribPointer(0, s[0], gl.GL_FLOAT, gl.GL_FALSE, bits_per_vertex, ctypes.c_void_p(0))
gl.glEnableVertexAttribArray(0)

gl.glVertexAttribPointer(1, s[1], gl.GL_FLOAT, gl.GL_FALSE, bits_per_vertex, ctypes.c_void_p(int(offsets_cumul[0])))
gl.glEnableVertexAttribArray(1)

gl.glVertexAttribPointer(2, s[2], gl.GL_FLOAT, gl.GL_FALSE, bits_per_vertex, ctypes.c_void_p(int(offsets_cumul[1])))
gl.glEnableVertexAttribArray(2)

class ColorChanger(Renderer):
    def update(self, dt: float):
        time = glfw.get_time() * 5
        # green_value = (np.sin(time * 1.5) + 1.0) / 2.0
        # red_value = (np.sin(time * 2.3) + 1.0) / 2.0
        # blue_value = (np.sin(time * 1.8) + 1.0) / 2.0
        # blue_value = 1
        gl.glUseProgram(shader.program)
        gl.glActiveTexture(gl.GL_TEXTURE0)  # Activate texture unit 0
        gl.glBindTexture(gl.GL_TEXTURE_2D, tex)
        # shader.set_uniform("custom_color", (1.0, 1.0, 0.0, 0.0))
        # shader.set_uniform("custom_color", (red_value, green_value, blue_value, 1.0))
        # shader.set_uniform("custom_texture", (red_value, green_value, blue_value, 1.0))
        gl.glBindVertexArray(vao)
        gl.glDrawElements(gl.GL_TRIANGLES, len(indices), gl.GL_UNSIGNED_INT, None)
        # gl.glDrawArrays(gl.GL_TRIANGLES, 0, vn)

window.renderers.append(ColorChanger())

window.run()
