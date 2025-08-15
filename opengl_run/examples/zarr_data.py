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
import zarr

window = LucidaWindow(1200, 1200, "Hello OpenGL")
window.renderers.append(Clearer())

# tif_path = Path("/Users/austin/test_files/nellie_all_tests/yeast_3d_mitochondria.ome.tif"); shader_dir = Path("/Users/austin/GitHub/lucida/opengl_run/shaders")
# tif_path = Path(r"D:\test_files\nellie_all_tests\yeast_3d_mitochondria.ome.tif"); shader_dir = Path(r"C:\Users\austin\GitHub\lucida\opengl_run\shaders")
# zarr_path = Path(r"C:\test_files_C\test_zarr.zarr"); shader_dir = Path(r"C:\Users\austin\GitHub\lucida\opengl_run\shaders")
zarr_path = Path("/Users/austin/test_files/test_zarr.zarr"); shader_dir = Path("/Users/austin/GitHub/lucida/opengl_run/shaders")
vs_path = shader_dir / 'texture_3d.vs'
fs_path = shader_dir / 'texture_3d_max_intensity.fs'
shader = Shader(vs_path, fs_path)

zarr_store = zarr.open_group(zarr_path, mode='r')
test_np = np.array(zarr_store['ds_1'])[0]
# test_np = tifffile.imread(tif_path)
# mip = np.max(test_np[0], axis=0)  # Create a maximum intensity projection
test_np = np.flip(test_np[0], axis=1)
# normalize to 0-65535 range
test_np = (test_np - np.min(test_np)) / (np.max(test_np) - np.min(test_np)) * 65535
test_np = test_np.astype(np.uint16)
im = np.ascontiguousarray(test_np, dtype=np.uint16)  # ensure packed rows
d, h, w = im.shape

voxel_sizes = (0.2, 0.2, 1)
phys_size = glm.vec3(float(w), float(h), float(d)) * voxel_sizes

# normalize so longest side is 1.0 in world units
scale = 1
L = max(phys_size.x, phys_size.y, phys_size.z) / scale
model_scale = phys_size / L

# base step in world units (the smallest voxel edge, normalized)
world_step = min(voxel_sizes) / L

pixel_format = gl.GL_RED
gl_type = gl.GL_UNSIGNED_SHORT
internal_format = gl.GL_R16

# window.adjust_aspect_ratio(w, h)
# window.toggle_aspect_ratio_lock(force=True)
# window.change_size(w, h)

vec = glm.vec4(1.0, 0.0, 0.0, 1.0)
trans_test = glm.mat4(1.0)

trans_test = glm.translate(trans_test, glm.vec3(1.0, 1.0, 0.0))
vec = trans_test * vec
# should print 2.0, 1.0, 0.0

# Change the near value to clip anything close to the camera.

tex = gl.glGenTextures(1)
gl.glBindTexture(gl.GL_TEXTURE_3D, tex)
gl.glPixelStorei(gl.GL_UNPACK_ALIGNMENT, 1)  # ensure no padding, rows are tightly packed
gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_MIN_FILTER, gl.GL_NEAREST)
gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_MAG_FILTER, gl.GL_NEAREST)
gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_WRAP_R, gl.GL_CLAMP_TO_EDGE)
gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_WRAP_S, gl.GL_CLAMP_TO_EDGE)
gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_WRAP_T, gl.GL_CLAMP_TO_EDGE)

gl.glTexImage3D(
    gl.GL_TEXTURE_3D,  # target texture
    0,  # level of detail (0 is base level, others are mipmaps)
    internal_format,  # dtype, 
    w,  # width of the texture
    h,  # height of the texture
    d, 
    0,  # border (must be 0..)
    pixel_format,  # pixel data format (number of color components), RED is 1 component
    gl_type,   # data type of the pixel data, UNSIGNED_SHORT is 2 bytes per pixel
    im  # the image data in memory
)

gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_SWIZZLE_R, gl.GL_RED)
gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_SWIZZLE_G, gl.GL_RED)
gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_SWIZZLE_B, gl.GL_RED)
gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_SWIZZLE_A, gl.GL_ONE)

gl.glBindTexture(gl.GL_TEXTURE_3D, 0)  # unbind texture

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


# view = glm.mat4(1.0)
# view = glm.translate(view, glm.vec3(0, 0, -3))


# print(window.width, window.height)
# # persp_proj = glm.perspective(glm.radians(45.0), window.width/window.height, 0.1, 100.0)
# persp_proj = glm.perspective(glm.radians(45.0), 1, 0.1, 100.0)
# print(persp_proj)

# proj = persp_proj
# proj = ortho_proj

cube_positions = [
    glm.vec3(0.0, 0.0, 0.0),
    glm.vec3(2.0, 5.0, -15.0),
    glm.vec3(4, -2.2, -2.5),
    glm.vec3(-3.8, -2.0, -12.3),
    glm.vec3(2.4, -0.4, -3.5),
    glm.vec3(-4, 2.0, -7.5),
    glm.vec3(1.3, 1.0, -1.5),
    glm.vec3(6, 3, -1.5),
    glm.vec3(5, 0.2, -1.5),
    glm.vec3(-1.5, 2.0, -1.5)
]

class MainRenderer(Renderer):
    def __init__(self):
        super().__init__()
        self.starting_fov = 45
        self.starting_ar = 1
        
        self.world_step = float(world_step) * 0.5
        self.density = 6.0
        self.brightness = 1.2
        
    def update(self, dt: float):
        time = glfw.get_time()
        gl.glUseProgram(shader.program)
        
        # basic GL state for volume compositing
        gl.glEnable(gl.GL_DEPTH_TEST)
        # gl.glEnable(gl.GL_BLEND)
        # gl.glBlendFunc(gl.GL_SRC_ALPHA, gl.GL_ONE_MINUS_SRC_ALPHA)
        
        shader.set_uniform("projection", window.camera.proj)
        shader.set_uniform("view", window.camera.view)
        
        
        gl.glActiveTexture(gl.GL_TEXTURE0)  # Activate texture unit 0
        gl.glBindTexture(gl.GL_TEXTURE_3D, tex)
        shader.set_uniform("ourTexture", 0)
        
        # common ray-march params
        shader.set_uniform("density", float(self.density))
        shader.set_uniform("brightness", float(self.brightness))
        
        # cam_world = glm.inverse(window.camera.view) * glm.vec4(0, 0, 0, 1)
        
        gl.glBindVertexArray(vao)
        for i in range(10):
            model = glm.mat4(1.0)
            angle = 20 * i
            model = glm.rotate(model, glm.radians(angle), glm.vec3(1, -0.7, 0.5))
            model = glm.scale(model, model_scale)
            model = glm.translate(model, cube_positions[i % len(cube_positions)])
            shader.set_uniform("model", model)
            shader.set_uniform("worldStep", float(self.world_step))
            
            cam_world_pos = window.camera.position
            cam_world_dir = window.camera.forward  # already normalized in your Camera
            # camera position in object space (you already had this):
            cam_world = glm.vec4(cam_world_pos, 1.0)

            near_pt_world = window.camera.position + window.camera.forward * window.camera.near
            far_pt_world  = window.camera.position + window.camera.forward * window.camera.far
            inv_model = glm.inverse(model)
            
            nearPointObj = glm.vec3(inv_model * glm.vec4(near_pt_world, 1.0))
            farPointObj  = glm.vec3(inv_model * glm.vec4(far_pt_world,  1.0))
            shader.set_uniform("nearPointObj", nearPointObj)
            shader.set_uniform("farPointObj",  farPointObj)
            
            cam_obj   = inv_model * cam_world
            shader.set_uniform("camPosObj", glm.vec3(cam_obj))
            
            # camera forward in object space (treat as direction: w=0)
            # use inverse(model) for world->object; for non-uniform scale, prefer mat3(transpose(inverse(model)))
            cam_plane_nrm_obj = glm.normalize(glm.mat3(glm.transpose(model)) * cam_world_dir)
            shader.set_uniform("camPlaneNrmObj", cam_plane_nrm_obj)
            
            # near distance (the same value your projection uses)
            shader.set_uniform("camNear", float(window.camera.near))
            shader.set_uniform("camFar", float(window.camera.far))
            # camera in OBJECT space for this cube (model^-1 * cam_world)
            # cam_obj = glm.inverse(model) * cam_world
            # shader.set_uniform("camPosObj", glm.vec3(cam_obj))
            
            gl.glDrawElements(gl.GL_TRIANGLES, len(indices), gl.GL_UNSIGNED_INT, None)
        
        gl.glBindVertexArray(0)
        gl.glBindTexture(gl.GL_TEXTURE_3D, 0)

window.renderers.append(MainRenderer())
window.run()
