#version 330 core
in vec3 fsColor;
out vec4 FragColor;

uniform vec4 custom_color;

void main() {
    FragColor = custom_color * vec4(fsColor, 1.0);
}
