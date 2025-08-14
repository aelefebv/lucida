#version 330 core
in vec3 vPosObj;
out vec4 FragColor;

uniform sampler3D ourTexture;

uniform vec3 camPosObj;  // camera origin in object space of this cube

uniform float stepSize;  // ~1/max(d, h, w)
uniform float density;  // absorption scale
uniform float brightness;  // final scale

// Axis-aligned box [-0.5,0.5]^3 intersection
bool intersectBox(vec3 ro, vec3 rd, out float tnear, out float tfar) {
    vec3 inv = 1.0 / rd;
    vec3 t0 = (-0.5 - ro) * inv;
    vec3 t1 = ( 0.5 - ro) * inv;
    vec3 tsmaller = min(t0, t1);
    vec3 tbigger  = max(t0, t1);
    tnear = max(max(tsmaller.x, tsmaller.y), tsmaller.z);
    tfar  = min(min(tbigger.x,  tbigger.y),  tbigger.z);
    return tfar >= max(tnear, 0.0);
}

void main() {
    vec3 ro = camPosObj;                 // ray origin in object space
    vec3 rd = normalize(vPosObj - ro);   // ray dir toward this fragment

    float tnear, tfar;
    if (!intersectBox(ro, rd, tnear, tfar)) discard;

    float t = max(tnear, 0.0);
    vec3 pos = ro + rd * t;

    const int MAX_STEPS = 1024;
    vec3 accum = vec3(0.0);
    float alpha = 0.0;

    for (int i = 0; i < MAX_STEPS; ++i) {
        if (t > tfar || alpha > 0.995) break;

        // map [-0.5,0.5] → [0,1] for texture coords
        vec3 tc = pos + vec3(0.5);
        float s = texture(ourTexture, tc).r;   // single-channel sample [0,1]

        // Beer-Lambert absorption for this step
        float a = 1.0 - exp(-s * density * stepSize);

        // simple grayscale (you can add a transfer function here)
        vec3 col = vec3(s);

        // front-to-back compositing
        accum += (1.0 - alpha) * col * a;
        alpha += (1.0 - alpha) * a;

        t   += stepSize;
        pos += rd * stepSize;
    }

    FragColor = vec4(accum * brightness, alpha);
}
