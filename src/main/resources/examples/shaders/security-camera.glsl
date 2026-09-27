// Old security camera look: green tint, noise, rolling bar and slight fisheye.
// See sepia.glsl for what is available.

float hash(vec2 p) {
	return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

vec4 postProcess(vec2 uv) {
	vec2 centered = uv - 0.5;
	vec2 bent = 0.5 + centered * (1.0 - 0.08 * dot(centered, centered));
	vec3 color = texture(uScene, bent).rgb;
	float gray = dot(color, vec3(0.299, 0.587, 0.114));
	float noise = hash(uv * uResolution + fract(uTime) * 100.0) - 0.5;
	float bar = smoothstep(0.0, 0.08, abs(fract(uv.y - uTime * 0.07) - 0.5)) * 0.08 + 0.92;
	float scan = 0.94 + 0.06 * sin(uv.y * uResolution.y * 3.14159);
	vec3 tint = vec3(0.75, 1.0, 0.8) * (gray + noise * 0.08) * bar * scan;
	return vec4(tint * smoothstep(0.9, 0.4, length(centered)), 1.0);
}
