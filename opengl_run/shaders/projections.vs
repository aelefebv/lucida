#version 330 core

layout (location = 0) in vec3 in_pos;
layout (location = 1) in vec2 in_tex_coord;

out vec2 texCoords;

uniform mat4 model;
uniform mat4 view;
uniform mat4 projection;

void main() {
    gl_Position = projection * view * model * vec4(in_pos, 1.0);
    texCoords = in_tex_coord;
}
