#version 330 core

layout (location = 0) in vec3 in_pos;
layout (location = 1) in vec3 in_color;
layout (location = 2) in vec2 in_tex_coord;

out vec3 fsColor;
out vec2 texCoords;

void main() {
    gl_Position = vec4(in_pos, 1.0);
    fsColor = in_color;
    texCoords = in_tex_coord;
}
