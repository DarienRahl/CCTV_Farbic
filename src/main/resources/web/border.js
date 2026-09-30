// The world border like Minecraft 26.3's WorldBorderRenderer: textures/misc/forcefield.png on the walls within
// the render distance, scrolling once every three seconds, tinted by the border's status (BorderStatus colours)
// and fading in with (1 - distance / render distance)^4, blended additively (BlendFunction.OVERLAY).

import { program } from './gl.js';

const VS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
uniform mat4 uViewProj;
uniform vec2 uScroll;
out vec2 vUv;
void main() {
	gl_Position = uViewProj * vec4(aPos, 1.0);
	// the texture matrix: translation(offset, offset, 0)
	vUv = aUv + uScroll;
}`;

// world_border.fsh (no fog)
const FS = `
in vec2 vUv;
uniform sampler2D uTexture;
uniform vec4 uColor;
out vec4 outColor;
void main() {
	vec4 color = texture(uTexture, vUv);
	if (color.a == 0.0) discard;
	outColor = color * uColor;
}`;

/** WorldBorderRenderer.RENDERING_OFFSET: the walls are drawn this far inside the border. */
const RENDERING_OFFSET = 0.01;
/** How far above and below the camera the walls reach (the game uses the depth of the far plane). */
const HALF_HEIGHT = 512;

export class WorldBorder {
	constructor(gl) {
		this.gl = gl;
		this.program = null;
		this.vao = null;
		this.buffer = null;
		this.mipmapped = null;
		this.data = new Float32Array(4 * 6 * 5);
	}

	/**
	 * WorldBorderRenderer.extract, prepare and render. border: [minX, maxX, minZ, maxZ] of the border now,
	 * tint: its BorderStatus colour, range: the render distance in blocks, texture: forcefield.png (or null).
	 */
	render(frame, camera, border, tint, range, texture) {
		if (!border || border.length < 4 || !texture || !(range > 0)) return;
		const [bMinX, bMaxX, bMinZ, bMaxZ] = border;
		const x = camera.x, z = camera.z;
		const inside = x < bMaxX - range && x > bMinX + range && z < bMaxZ - range && z > bMinZ + range;
		const outside = x < bMinX - range || x > bMaxX + range || z < bMinZ - range || z > bMaxZ + range;
		if (inside || outside) return;
		// WorldBorder.getDistanceToBorder (negative outside)
		const distance = Math.min(z - bMinZ, bMaxZ - z, x - bMinX, bMaxX - x);
		const alpha = Math.min(1, Math.max(0, Math.pow(1 - distance / range, 4)));
		if (!(alpha > 0)) return;

		// rebuildWorldBorderBuffer: the walls between the camera's render distance and the border's corners
		const borderMinX = bMinX + RENDERING_OFFSET, borderMaxX = bMaxX - RENDERING_OFFSET;
		const borderMinZ = bMinZ + RENDERING_OFFSET, borderMaxZ = bMaxZ - RENDERING_OFFSET;
		const minZ = Math.max(Math.floor(z - range), borderMinZ), maxZ = Math.min(Math.ceil(z + range), borderMaxZ);
		const minX = Math.max(Math.floor(x - range), borderMinX), maxX = Math.min(Math.ceil(x + range), borderMaxX);
		if (!(maxX > minX) || !(maxZ > minZ)) return;
		const u0z = (Math.floor(minZ) & 1) * 0.5, u1z = (maxZ - minZ) / 2;
		const u0x = (Math.floor(minX) & 1) * 0.5, u1x = (maxX - minX) / 2;
		const top = HALF_HEIGHT, bottom = -HALF_HEIGHT;
		// the texture repeats every two blocks upwards too, anchored to the world
		const vTop = -(camera.y + top) / 2, vBottom = -(camera.y + bottom) / 2;
		const data = this.data;
		let n = 0;
		const vertex = (wx, y, wz, u, v) => {
			data[n++] = wx - x; data[n++] = y; data[n++] = wz - z; data[n++] = u; data[n++] = v;
		};
		const quad = corners => {
			// two triangles of the quad's four corners
			for (const i of [0, 1, 2, 0, 2, 3]) vertex(...corners[i]);
		};
		// WorldBorderRenderState.closestBorder: only the sides nearer than the render distance
		if (bMaxZ - z < range) {
			quad([[minX, bottom, borderMaxZ, u0x, vBottom], [maxX, bottom, borderMaxZ, u1x + u0x, vBottom],
				[maxX, top, borderMaxZ, u1x + u0x, vTop], [minX, top, borderMaxZ, u0x, vTop]]);
		}
		if (x - bMinX < range) {
			quad([[borderMinX, bottom, minZ, u0z, vBottom], [borderMinX, bottom, maxZ, u1z + u0z, vBottom],
				[borderMinX, top, maxZ, u1z + u0z, vTop], [borderMinX, top, minZ, u0z, vTop]]);
		}
		if (z - bMinZ < range) {
			quad([[maxX, bottom, borderMinZ, u0x, vBottom], [minX, bottom, borderMinZ, u1x + u0x, vBottom],
				[minX, top, borderMinZ, u1x + u0x, vTop], [maxX, top, borderMinZ, u0x, vTop]]);
		}
		if (bMaxX - x < range) {
			quad([[borderMaxX, bottom, maxZ, u0z, vBottom], [borderMaxX, bottom, minZ, u1z + u0z, vBottom],
				[borderMaxX, top, minZ, u1z + u0z, vTop], [borderMaxX, top, maxZ, u0z, vTop]]);
		}
		if (!n) return;

		const gl = this.gl;
		if (!this.program) this.setup();
		if (this.mipmapped !== texture) {
			// MipmappedTexture(forcefield, 4)
			gl.bindTexture(gl.TEXTURE_2D, texture);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 4);
			gl.generateMipmap(gl.TEXTURE_2D);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
			this.mipmapped = texture;
		}
		const p = this.program;
		gl.useProgram(p.program);
		gl.uniformMatrix4fv(p.u.uViewProj, false, frame.viewProj);
		const offset = (Date.now() % 3000) / 3000;
		gl.uniform2f(p.u.uScroll, offset, offset);
		gl.uniform4f(p.u.uColor, (tint >> 16 & 255) / 255, (tint >> 8 & 255) / 255, (tint & 255) / 255, alpha);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.uniform1i(p.u.uTexture, 0);
		gl.bindVertexArray(this.vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
		gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n), gl.DYNAMIC_DRAW);
		gl.enable(gl.BLEND);
		gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ZERO);
		gl.enable(gl.DEPTH_TEST);
		gl.depthMask(false);
		gl.disable(gl.CULL_FACE);
		gl.enable(gl.POLYGON_OFFSET_FILL);
		gl.polygonOffset(3, 3);
		gl.drawArrays(gl.TRIANGLES, 0, n / 5);
		gl.disable(gl.POLYGON_OFFSET_FILL);
		gl.enable(gl.CULL_FACE);
		gl.depthMask(true);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.disable(gl.BLEND);
		gl.bindVertexArray(null);
	}

	setup() {
		const gl = this.gl;
		this.program = program(gl, VS, FS);
		this.vao = gl.createVertexArray();
		this.buffer = gl.createBuffer();
		gl.bindVertexArray(this.vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
		gl.enableVertexAttribArray(1);
		gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
		gl.bindVertexArray(null);
	}
}
