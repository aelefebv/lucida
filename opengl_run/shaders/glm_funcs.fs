#version 330 core
in vec3 fsColor;
in vec2 texCoords;

out vec4 FragColor;

uniform vec4 custom_color;
uniform sampler2D ourTexture;

void main() {
    // FragColor = custom_color * vec4(fsColor, 1.0);
    FragColor = texture(ourTexture, texCoords);// * custom_color * vec4(fsColor, 1.0);
}
