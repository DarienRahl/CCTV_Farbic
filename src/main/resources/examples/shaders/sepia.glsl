// Example post-processing shader for the CCTV viewer (GLSL ES 3.00).
// Put your own *.glsl files next to this one and pick them in the viewer
// (Settings > Post effect) or for everybody with viewer.postShader in config.json.
//
// Write a function `vec4 postProcess(vec2 uv)`. Available:
//   sampler2D uScene      finished picture (colour)
//   sampler2D uDepth      depth buffer (0 = near, 1 = far / sky)
//   vec2  uResolution     picture size in pixels
//   float uTime           seconds since the page was opened
//   float uDaylight       0 at night .. 1 at noon
//   float uRain           0 .. 1
//   float linearDepth(vec2 uv)  distance in blocks from the camera

vec4 postProcess(vec2 uv) {
	vec3 color = texture(uScene, uv).rgb;
	float gray = dot(color, vec3(0.299, 0.587, 0.114));
	vec3 sepia = gray * vec3(1.07, 0.84, 0.62);
	float vignette = smoothstep(0.95, 0.35, distance(uv, vec2(0.5)));
	return vec4(mix(color, sepia, 0.85) * vignette, 1.0);
}
