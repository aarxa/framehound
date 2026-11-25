#version 450
layout(push_constant) uniform Push { mat4 mvp; mat4 model; vec4 color; vec4 params; } pc;
layout(location = 0) in vec3 pos;
layout(location = 1) in vec3 nrm;
layout(location = 2) in vec2 uv;
layout(location = 0) out vec3 vNormal;
layout(location = 1) out vec2 vUV;
layout(location = 2) out vec3 vWorld;
void main() {
  gl_Position = pc.mvp * vec4(pos, 1.0);
  vNormal = mat3(pc.model) * nrm;
  vUV = uv * pc.params.x;
  vWorld = (pc.model * vec4(pos, 1.0)).xyz;
}
