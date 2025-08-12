import glfw
import moderngl

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

while not glfw.window_should_close(window):
    glfw.poll_events()
    ctx.clear(color=(0.1, 0.12, 0.15, 1.0))
    glfw.swap_buffers(window)

glfw.terminate()
ctx.release()
print("Window closed and context released.")
