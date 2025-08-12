import glfw

from opengl_run.render import Renderer

class LucidaWindow:
    def __init__(self, width=800, height=600, title="Lucida", *, min_dt=0.00833):
        self.width = width
        self.height = height
        self.title = title
        self.window = self._initialize_window()
        
        self.min_dt = min_dt
        
        self.renderers: list[Renderer] = []
    
    ###################
    # Public Methods ##
    ###################
        
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
                
            glfw.poll_events()
            glfw.swap_buffers(self.window)

        glfw.terminate()
        print("Window closed and context released.")
    
    def add_renderer(self, renderer: Renderer):
        if not isinstance(renderer, Renderer):
            raise TypeError("Renderer must be an instance of Renderer class.")
        self.renderers.append(renderer)
    
    #####################
    # Internal Methods ##
    #####################
    
    def _initialize_window(self):
        if not glfw.init():
            raise RuntimeError("Failed to initialize GLFW")

        glfw.window_hint(glfw.CONTEXT_VERSION_MAJOR, 3)
        glfw.window_hint(glfw.CONTEXT_VERSION_MINOR, 3)
        glfw.window_hint(glfw.OPENGL_PROFILE, glfw.OPENGL_CORE_PROFILE)

        window = glfw.create_window(self.width, self.height, self.title, None, None)
        if not window:
            glfw.terminate()
            raise RuntimeError("Failed to create GLFW window")

        glfw.make_context_current(window)
        return window
    
    
    
if __name__ == "__main__":
    lucida_window = LucidaWindow()
    lucida_window.run()
