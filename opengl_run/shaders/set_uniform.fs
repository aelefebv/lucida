#version 330 core

out vec4 FragColor;

uniform vec4 custom_color;

void main() {
    FragColor = custom_color;
}
