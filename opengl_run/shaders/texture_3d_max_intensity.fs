#version 330 core
in vec3 vPosObj;
out vec4 FragColor;

uniform sampler3D ourTexture;

uniform vec3 camPosObj;  // camera origin in object space of this cube
uniform float camNear;  // camera near plane distance
uniform float camFar;  // camera far plane distance
uniform vec3 camPlaneNrmObj;  // camera direction in object space of this cube
uniform float density;  // absorption scale
uniform float brightness;  // final scale

uniform float worldStep;  // base step in world units (normalized)
uniform mat4 model;
uniform vec3 nearPointObj, farPointObj;

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

    // start at the cube entry, or the near plane, whichever is farther
    float t = max(tnear, 0.0);

    float denom = dot(camPlaneNrmObj, rd);
    if (abs(denom) > 1e-6) {
        float t0 = dot(camPlaneNrmObj, nearPointObj - ro) / denom;
        float t1 = dot(camPlaneNrmObj,  farPointObj - ro) / denom;
        if (t0 > t1) { float tmp = t0; t0 = t1; t1 = tmp; }  // ensure order

        t    = max(t,    t0);
        tfar = min(tfar, t1);
        if (t > tfar) discard;
    }

    vec3 pos = ro + rd * t;

    float ds = worldStep / length(mat3(model) * rd);

    const int MAX_STEPS = 1024;

    float maxS = 0.0;          // highest scalar encountered
    vec3  maxCol = vec3(0.0);  // color at that scalar (apply your TF here)
    float tAtMax = tfar;       // optional: where the max occurred (for depth cueing)
    
    for (int i = 0; i < MAX_STEPS; ++i) {
        if (t > tfar) break;

        // map [-0.5,0.5] → [0,1] for texture coords
        vec3 tc = clamp(pos + vec3(0.5), vec3(1e-3), vec3(1.0 - 1e-3));
        float s = texture(ourTexture, tc).r; // [0,1]

        if (s > maxS) {
            maxS   = s;
            maxCol = vec3(s);  // or: maxCol = transferFunction(s);
            tAtMax = t;

            // optional early exit if we've basically hit the top
            if (maxS >= 0.999) break;
        }

        t   += ds;
        pos += rd * ds;
    }

    // Alpha choice:
    // - 1.0: fully opaque MIP
    // - maxS: handy if you want intensity to influence blending
    float alphaOut = maxS;  // or 1.0

    // Optional depth cue (fade with distance to help perceive depth):
    float depthFade = exp(-0.02 * (tAtMax - tnear));
    maxCol *= depthFade;

    FragColor = vec4(maxCol * brightness, alphaOut);
}
