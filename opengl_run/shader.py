from OpenGL import GL as gl

class Shader:
    def __init__(self, vertex_path, fragment_path):
        self.vertex_shader = self._compile_shader(vertex_path, gl.GL_VERTEX_SHADER)
        self.fragment_shader = self._compile_shader(fragment_path, gl.GL_FRAGMENT_SHADER)
        
        self.program = self._link_program()
        
    #####################
    # Public methods ####
    #####################
        
    def use(self):
        gl.glUseProgram(self.program)
        
    def set_uniform(self, name, value):
        location = gl.glGetUniformLocation(self.program, name)
        if isinstance(value, float):
            gl.glUniform1f(location, value)
        elif isinstance(value, (list, tuple)) and len(value) == 2:
            gl.glUniform2f(location, *value)
        elif isinstance(value, (list, tuple)) and len(value) == 3:
            gl.glUniform3f(location, *value)
        elif isinstance(value, (list, tuple)) and len(value) == 4:
            gl.glUniform4f(location, *value)
        elif isinstance(value, int):
            gl.glUniform1i(location, value)
        else:
            raise ValueError(f"Unsupported uniform type: {type(value)} for {name}")

    #####################
    # Private methods ###
    #####################
        
    def _compile_shader(self, path, shader_type):
        with open(path, 'r') as file:
            shader_source = file.read()
        
        shader = gl.glCreateShader(shader_type)
        gl.glShaderSource(shader, shader_source)
        gl.glCompileShader(shader)
        
        success = gl.glGetShaderiv(shader, gl.GL_COMPILE_STATUS)
        if not success:
            info_log = gl.glGetShaderInfoLog(shader).decode()
            gl.glDeleteShader(shader)
            raise RuntimeError(f"Shader compilation failed: {info_log}")
        
        return shader
    
    def _link_program(self):
        program = gl.glCreateProgram()
        gl.glAttachShader(program, self.vertex_shader)
        gl.glAttachShader(program, self.fragment_shader)
        gl.glLinkProgram(program)
        
        success = gl.glGetProgramiv(program, gl.GL_LINK_STATUS)
        if not success:
            info_log = gl.glGetProgramInfoLog(program).decode()
            gl.glDeleteProgram(program)
            raise RuntimeError(f"Program linking failed: {info_log}")
        
        gl.glDetachShader(program, self.vertex_shader)
        gl.glDetachShader(program, self.fragment_shader)
        gl.glDeleteShader(self.vertex_shader)
        gl.glDeleteShader(self.fragment_shader)
        
        return program