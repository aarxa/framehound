#version 450
layout(push_constant) uniform Push { mat4 mvp; mat4 model; vec4 color; vec4 params; } pc;
layout(set = 0, binding = 0) uniform sampler2D tex;
layout(location = 0) in vec3 vNormal;
layout(location = 1) in vec2 vUV;
layout(location = 2) in vec3 vWorld;
layout(location = 0) out vec4 outColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 sun = normalize(vec3(0.45, 0.8, 0.35));
  float light = 0.32 + 0.68 * max(dot(n, sun), 0.0) + 0.12 * max(n.y, 0.0);
  vec3 albedo = pc.color.rgb * texture(tex, vUV).rgb;
  float fog = clamp((length(vWorld) - 10.0) / 14.0, 0.0, 1.0);
  vec3 c = mix(albedo * light, vec3(0.52, 0.66, 0.80), fog);
  outColor = vec4(c, pc.color.a);
}
