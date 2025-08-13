from opengl_run.window import LucidaWindow
from opengl_run.shader import Shader
from opengl_run.render import Renderer, Clearer
from OpenGL import GL as gl
import numpy as np
import glfw
from pathlib import Path
import ctypes
import tifffile
from pyglm import glm

window = LucidaWindow(1200, 1200, "Hello OpenGL")
window.renderers.append(Clearer())

# tif_path = Path("/Users/austin/test_files/nellie_all_tests/yeast_3d_mitochondria.ome.tif"); shader_dir = Path("/Users/austin/GitHub/lucida/opengl_run/shaders")
tif_path = Path(r"D:\test_files\nellie_all_tests\yeast_3d_mitochondria.ome.tif"); shader_dir = Path(r"C:\Users\austin\GitHub\lucida\opengl_run\shaders")
vs_path = shader_dir / 'projections.vs'
fs_path = shader_dir / 'projections.fs'
shader = Shader(vs_path, fs_path)

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

window.adjust_aspect_ratio(w, h)
window.toggle_aspect_ratio_lock(force=True)
# window.change_size(w, h)

vec = glm.vec4(1.0, 0.0, 0.0, 1.0)
trans_test = glm.mat4(1.0)

trans_test = glm.translate(trans_test, glm.vec3(1.0, 1.0, 0.0))
vec = trans_test * vec
print(vec.x, vec.y, vec.z)
# should print 2.0, 1.0, 0.0

# Change the near value to clip anything close to the camera.

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

# vertices = np.array([
#     # Position         # Color           # Texture Coords
#      1,  1, 0.0,   1.0, 0.0, 0.0,    1.0, 1.0,
#      1, -1, 0.0,   0.0, 1.0, 1.0,    1.0, 0.0,
#     -1, -1, 0.0,   0.0, 0.0, 1.0,    0.0, 0.0,
#     -1,  1, 0.0,   1.0, 1.0, 0.0,    0.0, 1.0,
# ], dtype=np.float32)
vertices = np.array([
    -0.5, -0.5, -0.5,  0.0, 0.0,
     0.5, -0.5, -0.5,  1.0, 0.0,
     0.5,  0.5, -0.5,  1.0, 1.0,
    -0.5,  0.5, -0.5,  0.0, 1.0,

    -0.5, -0.5,  0.5,  0.0, 0.0,
     0.5, -0.5,  0.5,  1.0, 0.0,
     0.5,  0.5,  0.5,  1.0, 1.0,
    -0.5,  0.5,  0.5,  0.0, 1.0,

    -0.5,  0.5,  0.5,  1.0, 0.0,
    -0.5,  0.5, -0.5,  1.0, 1.0,
    -0.5, -0.5, -0.5,  0.0, 1.0,
    -0.5, -0.5,  0.5,  0.0, 0.0,

     0.5,  0.5, -0.5,  1.0, 1.0,
     0.5, -0.5, -0.5,  0.0, 1.0,
     0.5, -0.5,  0.5,  0.0, 0.0,
     0.5,  0.5,  0.5,  1.0, 0.0,

     0.5, -0.5, -0.5,  1.0, 1.0,
     0.5, -0.5,  0.5,  1.0, 0.0,
    -0.5, -0.5,  0.5,  0.0, 0.0,
    -0.5, -0.5, -0.5,  0.0, 1.0,

     0.5,  0.5, -0.5,  1.0, 1.0,
     0.5,  0.5,  0.5,  1.0, 0.0,
    -0.5,  0.5,  0.5,  0.0, 0.0,
    -0.5,  0.5, -0.5,  0.0, 1.0
], dtype=np.float32)

indices = np.array([
    0, 1, 3,  # First triangle
    1, 2, 3,   # Second triangle

    4, 5, 7,  # Third triangle
    5, 6, 7,   # Fourth triangle
    
    8, 9, 11,  # Fifth triangle
    9, 10, 11,   # Sixth triangle
    
    12, 13, 15,  # Seventh triangle
    13, 14, 15,   # Eighth triangle
    
    16, 17, 19,  # Ninth triangle
    17, 18, 19,   # Tenth triangle
    
    20, 21, 23,  # Eleventh triangle
    21, 22, 23    # Twelfth triangle
], dtype=np.uint32)

vao = gl.glGenVertexArrays(1)
vbo = gl.glGenBuffers(1)
ebo = gl.glGenBuffers(1)

s = (3, 2)  # Sizes of each attribute (3 for vec3)
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

gl.glUseProgram(shader.program)
gl.glActiveTexture(gl.GL_TEXTURE0)  # Activate texture unit 0
gl.glBindTexture(gl.GL_TEXTURE_2D, tex)
gl.glBindVertexArray(vao)

view = glm.mat4(1.0)
view = glm.translate(view, glm.vec3(0, 0, -3))

ortho_proj = glm.ortho(-1.0, 1.0, -1.0, 1.0, 0.1, 100.0)
print(ortho_proj, '\n')

print(window.width, window.height)
# persp_proj = glm.perspective(glm.radians(45.0), window.width/window.height, 0.1, 100.0)
persp_proj = glm.perspective(glm.radians(45.0), 1, 0.1, 100.0)
print(persp_proj)

proj = persp_proj
# proj = ortho_proj

class MainRenderer(Renderer):
    def update(self, dt: float):
        time = glfw.get_time() 
        
        
        model = glm.mat4(1.0)
        model = glm.rotate(model, time * glm.radians(50), glm.vec3(1, -0.7, 0.5))
        # model = glm.translate(model, glm.vec3(0.5, -0.5, 0.0))
        shader.set_uniform("model", model)
        shader.set_uniform("view", view)
        shader.set_uniform("projection", proj)
        gl.glDrawElements(gl.GL_TRIANGLES, len(indices), gl.GL_UNSIGNED_INT, None)
        
        # model = glm.mat4(1.0)
        # model = glm.translate(model, glm.vec3(-0.5, 0.5, 0.0))
        # shader.set_uniform("model", model)
        # gl.glDrawElements(gl.GL_TRIANGLES, len(indices), gl.GL_UNSIGNED_INT, None)
        

window.renderers.append(MainRenderer())

window.run()
