import glfw
import OpenGL.GL as gl
from opengl_run.render import Renderer

class LucidaWindow:
    def __init__(self, width=800, height=600, title="Lucida", *, min_dt=0.00833):
        self.width = width
        self.height = height
        self.title = title
        self.window = self._initialize_window()
        
        self.min_dt = min_dt
        
        self.renderers: list[Renderer] = []
        
        self._is_aspect_ratio_locked = False
        
        # Callbacks
        glfw.set_framebuffer_size_callback(self.window, self._on_framebuffer_resize)
        glfw.set_key_callback(self.window, self._on_key_press)
        
    ####################
    # Run ##############
    ####################    
    
    def run(self):
        last_time = glfw.get_time()
        while not glfw.window_should_close(self.window):
            time = glfw.get_time()
            dt = time - last_time
            if dt < self.min_dt:
                continue
            last_time = time
            
            for renderer in self.renderers:
                renderer.update(dt)
                
            # glfw.wait_events()
            glfw.poll_events()
            glfw.swap_buffers(self.window)

        glfw.terminate()
        print("Window closed and context released.")
    
    ###################
    # Public Methods ##
    ###################
    
    def add_renderer(self, renderer: Renderer):
        if not isinstance(renderer, Renderer):
            raise TypeError("Renderer must be an instance of Renderer class.")
        self.renderers.append(renderer)
        
    def adjust_aspect_ratio(self, width: int | float, height: int | float, lock: bool = True):
        aspect_ratio = width / height
        fbw, fbh = glfw.get_framebuffer_size(self.window)
        if aspect_ratio > 1:  # Width is larger
            new_width = min(fbw, fbh * aspect_ratio)
            new_height = new_width / aspect_ratio
        else:  # Height is larger or square
            new_height = min(fbh, fbw / aspect_ratio)
            new_width = new_height * aspect_ratio
        self.change_size(int(new_width), int(new_height))
        if lock and not self._is_aspect_ratio_locked:
            self.toggle_aspect_ratio_lock()
        
    def change_size(self, width: int, height: int):
        if width <= 0 or height <= 0:
            raise ValueError("Width and height must be positive integers.")            
        glfw.set_window_size(self.window, width, height)  # calls the framebuffer size callback
        
    def toggle_aspect_ratio_lock(self, force: bool | None = None):
        if force is None:
            # Simple toggle
            if self._is_aspect_ratio_locked:
                glfw.set_window_aspect_ratio(self.window, glfw.DONT_CARE, glfw.DONT_CARE)
                self._is_aspect_ratio_locked = False
            else:
                fbw, fbh = glfw.get_framebuffer_size(self.window)
                glfw.set_window_aspect_ratio(self.window, int(fbw), int(fbh))
                self._is_aspect_ratio_locked = True
        elif force is False:
            # Force unlocked
            if not self._is_aspect_ratio_locked: return
            glfw.set_window_aspect_ratio(self.window, glfw.DONT_CARE, glfw.DONT_CARE)
            self._is_aspect_ratio_locked = False
        else:  # force is True
            # Force locked
            if self._is_aspect_ratio_locked: return
            fbw, fbh = glfw.get_framebuffer_size(self.window)
            glfw.set_window_aspect_ratio(self.window, int(fbw), int(fbh))
            self._is_aspect_ratio_locked = True
    
    #####################
    # Internal Methods ##
    #####################
    
    def _initialize_window(self):
        if not glfw.init():
            raise RuntimeError("Failed to initialize GLFW")

        glfw.window_hint(glfw.CONTEXT_VERSION_MAJOR, 3)
        glfw.window_hint(glfw.CONTEXT_VERSION_MINOR, 3)
        glfw.window_hint(glfw.OPENGL_PROFILE, glfw.OPENGL_CORE_PROFILE)
        glfw.window_hint(glfw.OPENGL_FORWARD_COMPAT, gl.GL_TRUE)

        window = glfw.create_window(self.width, self.height, self.title, None, None)
        if not window:
            glfw.terminate()
            raise RuntimeError("Failed to create GLFW window")

        glfw.make_context_current(window)
        return window
    
    ######################
    # Callbacks ##########
    ######################
    
    def _on_framebuffer_resize(self, _, width, height):
        self.width = width
        self.height = height
        gl.glViewport(0, 0, width, height)
        
    def _on_key_press(self, window, key: int, scancode: int, action: int, mods: int):
        if (key == glfw.KEY_ESCAPE and action == glfw.PRESS):
            glfw.set_window_should_close(window, True)
    
    
if __name__ == "__main__":
    lucida_window = LucidaWindow()
    lucida_window.run()
