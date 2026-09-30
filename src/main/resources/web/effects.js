// Post effects that come with the viewer (Settings > Post effect > Built in). They use the same API as the
// server's own shaders in config/cctv/shaders (see examples/shaders/sepia.glsl): a GLSL function
// `vec4 postProcess(vec2 uv)` with uScene, uDepth, uResolution, uTime, uDaylight, uRain and linearDepth().

const NOISE = `
float hash12(vec2 p) {
	vec3 p3 = fract(vec3(p.xyx) * 0.1031);
	p3 += dot(p3, p3.yzx + 33.33);
	return fract((p3.x + p3.y) * p3.z);
}
float luma(vec3 c) {
	return dot(c, vec3(0.2126, 0.7152, 0.0722));
}
float vignette(vec2 uv, float inner, float outer) {
	return smoothstep(outer, inner, distance(uv, vec2(0.5)));
}
`;

/** id -> {name, source} */
export const EFFECTS = {
	cinematic: {
		name: 'Cinematic (teal & orange, letterbox)',
		source: NOISE + `
vec4 postProcess(vec2 uv) {
	float aspect = uResolution.x / uResolution.y;
	float bar = max(0.0, (1.0 - aspect / 2.39) * 0.5);
	if (uv.y < bar || uv.y > 1.0 - bar) return vec4(0.0, 0.0, 0.0, 1.0);
	vec3 c = texture(uScene, uv).rgb;
	float l = luma(c);
	c += mix(vec3(-0.02, 0.03, 0.07), vec3(0.08, 0.03, -0.05), smoothstep(0.15, 0.85, l));
	c = mix(vec3(luma(c)), c, 1.12);
	c = (c - 0.5) * 1.08 + 0.5;
	c *= mix(0.72, 1.0, vignette(uv, 0.25, 0.85));
	c += (hash12(uv * uResolution + fract(uTime) * 917.0) - 0.5) * 0.03;
	return vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
	},
	noir: {
		name: 'Film noir (black and white)',
		source: NOISE + `
vec4 postProcess(vec2 uv) {
	float l = luma(texture(uScene, uv).rgb);
	l = smoothstep(0.02, 1.0, l);
	l = mix(l, l * l * (3.0 - 2.0 * l), 0.6);
	l *= mix(0.6, 1.0, vignette(uv, 0.2, 0.85));
	l += (hash12(uv * uResolution + fract(uTime) * 613.0) - 0.5) * 0.045;
	return vec4(vec3(clamp(l, 0.0, 1.0)), 1.0);
}`,
	},
	thermal: {
		name: 'Thermal camera',
		source: NOISE + `
vec3 heat(float t) {
	vec3 a = mix(vec3(0.02, 0.0, 0.12), vec3(0.25, 0.0, 0.65), smoothstep(0.0, 0.25, t));
	a = mix(a, vec3(0.85, 0.05, 0.45), smoothstep(0.25, 0.5, t));
	a = mix(a, vec3(1.0, 0.45, 0.0), smoothstep(0.5, 0.75, t));
	return mix(a, vec3(1.0, 1.0, 0.75), smoothstep(0.75, 1.0, t));
}
vec4 postProcess(vec2 uv) {
	vec3 c = texture(uScene, uv).rgb;
	bool sky = texture(uDepth, uv).r >= 0.99999;
	float near = 1.0 - clamp(linearDepth(uv) / 48.0, 0.0, 1.0);
	float warm = clamp(c.r - max(c.g, c.b) * 0.8, 0.0, 1.0);
	float bright = smoothstep(0.55, 0.95, luma(c));
	float t = sky ? 0.02 : clamp(pow(luma(c), 1.3) * 0.45 + near * 0.12 + warm * 0.6 + bright * 0.4, 0.0, 1.0);
	t += (hash12(uv * uResolution * 0.5 + fract(uTime) * 311.0) - 0.5) * 0.03;
	return vec4(heat(clamp(t, 0.0, 1.0)), 1.0);
}`,
	},
	nightvision: {
		name: 'Night vision goggles',
		source: NOISE + `
vec4 postProcess(vec2 uv) {
	vec3 c = texture(uScene, uv).rgb;
	float l = pow(clamp(luma(c) * 3.2, 0.0, 1.0), 0.75);
	l += (hash12(uv * uResolution + fract(uTime) * 1733.0) - 0.5) * 0.18;
	l *= 0.92 + 0.08 * sin(uv.y * uResolution.y * 1.5);
	l *= 0.97 + 0.03 * sin(uTime * 37.0);
	vec2 p = (uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
	float lens = smoothstep(0.62, 0.5, length(p));
	return vec4(vec3(0.12, 1.0, 0.25) * clamp(l, 0.0, 1.0) * lens, 1.0);
}`,
	},
	vhs: {
		name: 'VHS tape',
		source: NOISE + `
vec4 postProcess(vec2 uv) {
	float band = smoothstep(0.02, 0.0, abs(fract(uv.y * 0.5 - uTime * 0.07) - 0.5));
	float jitter = (hash12(vec2(floor(uv.y * uResolution.y / 3.0), floor(uTime * 24.0))) - 0.5) * 0.004;
	vec2 p = uv + vec2(jitter + band * 0.02, 0.0);
	float shift = 2.5 / uResolution.x;
	vec3 c;
	c.r = texture(uScene, p + vec2(shift, 0.0)).r;
	c.g = texture(uScene, p).g;
	c.b = texture(uScene, p - vec2(shift, 0.0)).b;
	c = mix(vec3(luma(c)), c, 0.8) * vec3(1.02, 0.98, 1.05);
	c += band * 0.25 * hash12(uv * uResolution + uTime);
	c += (hash12(uv * uResolution + fract(uTime) * 419.0) - 0.5) * 0.07;
	c *= 0.95 + 0.05 * sin(uv.y * uResolution.y * 3.14159);
	return vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
	},
	fisheye: {
		name: 'Dome camera (fisheye)',
		source: NOISE + `
vec4 postProcess(vec2 uv) {
	vec2 p = uv * 2.0 - 1.0;
	float aspect = uResolution.x / uResolution.y;
	p.x *= aspect;
	float r2 = dot(p, p);
	vec2 q = p * (1.0 + 0.22 * r2) / (1.0 + 0.22 * (1.0 + aspect * aspect));
	q.x /= aspect;
	vec2 s = q * 0.5 + 0.5;
	if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) return vec4(0.0, 0.0, 0.0, 1.0);
	vec3 c = texture(uScene, s).rgb;
	c *= mix(0.6, 1.0, vignette(uv, 0.3, 0.75));
	return vec4(c, 1.0);
}`,
	},
	tiltshift: {
		name: 'Tilt-shift (miniature)',
		source: NOISE + `
vec4 postProcess(vec2 uv) {
	float amount = smoothstep(0.08, 0.38, abs(uv.y - 0.5));
	vec2 px = 1.0 / uResolution;
	vec3 sum = texture(uScene, uv).rgb;
	float n = 1.0;
	for (int i = 0; i < 12; i++) {
		float a = float(i) * 2.39996;
		float r = sqrt(float(i) + 0.5) / 3.5;
		sum += texture(uScene, uv + vec2(cos(a), sin(a)) * r * amount * 7.0 * px).rgb;
		n += 1.0;
	}
	vec3 c = sum / n;
	c = mix(vec3(luma(c)), c, 1.35);
	c = (c - 0.5) * 1.1 + 0.5;
	return vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
	},
	comic: {
		name: 'Comic book (outlines)',
		source: NOISE + `
float depthAt(vec2 uv) {
	return log(1.0 + linearDepth(uv));
}
vec4 postProcess(vec2 uv) {
	vec2 px = 1.0 / uResolution;
	float d = depthAt(uv);
	float edge = abs(depthAt(uv + vec2(px.x, 0.0)) - d) + abs(depthAt(uv - vec2(px.x, 0.0)) - d)
		+ abs(depthAt(uv + vec2(0.0, px.y)) - d) + abs(depthAt(uv - vec2(0.0, px.y)) - d);
	vec3 c = texture(uScene, uv).rgb;
	float ledge = abs(luma(texture(uScene, uv + vec2(px.x, 0.0)).rgb) - luma(c))
		+ abs(luma(texture(uScene, uv + vec2(0.0, px.y)).rgb) - luma(c));
	c = floor(mix(vec3(luma(c)), c, 1.3) * 5.0 + 0.5) / 5.0;
	float line = clamp(smoothstep(0.06, 0.14, edge) + smoothstep(0.45, 0.7, ledge), 0.0, 1.0);
	return vec4(mix(c, vec3(0.05), line), 1.0);
}`,
	},
	retro: {
		name: 'Retro (pixels, 4 shades)',
		source: NOISE + `
vec4 postProcess(vec2 uv) {
	vec2 cells = uResolution / 4.0;
	vec2 p = (floor(uv * cells) + 0.5) / cells;
	float l = luma(texture(uScene, p).rgb);
	float dither = hash12(floor(uv * cells)) * 0.2 - 0.1;
	float level = floor(clamp(l + dither, 0.0, 0.999) * 4.0);
	vec3 palette[4] = vec3[4](vec3(0.06, 0.22, 0.06), vec3(0.19, 0.38, 0.19), vec3(0.55, 0.67, 0.06), vec3(0.61, 0.74, 0.06));
	return vec4(palette[int(level)], 1.0);
}`,
	},
	dreamy: {
		name: 'Dreamy glow',
		source: NOISE + `
vec4 postProcess(vec2 uv) {
	vec3 c = texture(uScene, uv).rgb;
	vec2 px = 3.0 / uResolution;
	vec3 glow = vec3(0.0);
	for (int i = 0; i < 16; i++) {
		float a = float(i) * 2.39996;
		float r = sqrt(float(i) + 0.5);
		glow += texture(uScene, uv + vec2(cos(a), sin(a)) * r * px).rgb;
	}
	glow /= 16.0;
	c = 1.0 - (1.0 - c) * (1.0 - glow * glow * 0.6);
	c = mix(vec3(luma(c)), c, 0.9) * vec3(1.04, 1.0, 0.96);
	c *= mix(0.85, 1.0, vignette(uv, 0.3, 0.9));
	return vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
	},
	vivid: {
		name: 'Vivid (sharper, richer colours)',
		source: NOISE + `
vec4 postProcess(vec2 uv) {
	vec2 px = 1.0 / uResolution;
	vec3 c = texture(uScene, uv).rgb;
	vec3 blur = (texture(uScene, uv + vec2(px.x, 0.0)).rgb + texture(uScene, uv - vec2(px.x, 0.0)).rgb
		+ texture(uScene, uv + vec2(0.0, px.y)).rgb + texture(uScene, uv - vec2(0.0, px.y)).rgb) * 0.25;
	c += (c - blur) * 0.6;
	c = mix(vec3(luma(c)), c, 1.25);
	c = (c - 0.5) * 1.05 + 0.5;
	return vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
	},
};
