// Live camera viewer: connects to the server's event stream, keeps a local copy
// of the blocks around the camera (meshed in Web Workers) and renders them with
// the game's sky, light, weather and entities.

import { World } from './world.js';
import { Renderer } from './renderer.js';
import { EntityRenderer } from './entities.js';
import { Assets } from './assets.js';
import { Environment } from './environment.js';
import { SkyRenderer, customBrightness } from './sky.js';
import { CloudRenderer } from './clouds.js';
import { WeatherRenderer } from './weather.js';
import { PostProcessor } from './post.js';
import { Particles } from './particles.js';
import { perspective, lookDir, multiply, direction, lerp, transformPoint } from './math.js';

const params = new URLSearchParams(location.search);
const token = params.get('token');
const query = token ? '?token=' + encodeURIComponent(token) : '';
const embed = params.has('embed');
const cameraName = decodeURIComponent(location.pathname.replace(/^\/cam\//, '').replace(/\/.*$/, ''));

const $ = id => document.getElementById(id);
const canvas = $('view');
const statusEl = $('status');
const statsEl = $('stats');
const clockEl = $('clock');
const gameTimeEl = $('game-time');
const loadingEl = $('loading');
const loadingFill = $('loading-fill');
const loadingText = $('loading-text');
const messageEl = $('message');

document.body.classList.toggle('embed', embed);

// Video wall tiles (embed): nothing is drawn while the tile is off screen or the tab is hidden, the frame rate
// is capped (lower for small tiles) and the picture uses one pixel per CSS pixel. The stream keeps running, so
// a tile is current the moment it shows again.
let onScreen = true;
if (embed && 'IntersectionObserver' in window) {
	new IntersectionObserver(entries => { onScreen = entries.some(entry => entry.isIntersecting); }).observe(canvas);
}
const frameInterval = () => (!embed ? 0 : canvas.clientWidth * canvas.clientHeight < 480 * 270 ? 1000 / 20 : 1000 / 30);
$('cam-name').textContent = cameraName.toUpperCase();
document.title = 'CCTV · ' + cameraName;

let renderer;
try {
	renderer = new Renderer(canvas);
} catch (e) {
	showMessage('This browser does not support WebGL2: ' + e.message);
	throw e;
}
const gl = renderer.gl;
const environment = new Environment();
const sky = new SkyRenderer(gl);
const clouds = new CloudRenderer(gl);
const weather = new WeatherRenderer(gl);
const post = new PostProcessor(gl, renderer);
const entities = new EntityRenderer(renderer);
const particles = new Particles(gl);
const world = new World((key, section, message) => {
	renderer.setSectionMesh(key, section, message, performance.now());
});

// --- settings: server defaults (config/cctv/config.json "viewer") + the viewer's own choices ---------------

const DEFAULTS = {
	graphics: 'vanilla', shaderQuality: 'medium', postShader: '', clouds: 'fancy', labels: true, mobLabels: false,
	mode: 'color', cctvEffect: false, skybox: 'default', renderScale: 1, particles: true,
};
const viewerInfo = { defaults: { ...DEFAULTS, skyboxes: {} }, locked: false, skyboxes: {}, shaders: [] };
let settings = { ...DEFAULTS };

function loadLocal() {
	try {
		return JSON.parse(localStorage.getItem('cctv-settings-v2') || '{}');
	} catch {
		return {};
	}
}

function saveLocal() {
	if (viewerInfo.locked) return;
	try {
		localStorage.setItem('cctv-settings-v2', JSON.stringify(settings));
	} catch {
		// Storage unavailable (private mode): settings are just not remembered.
	}
}

async function loadViewerInfo() {
	try {
		const response = await fetch('/api/viewer' + query, { credentials: 'same-origin' });
		if (response.ok) Object.assign(viewerInfo, await response.json());
	} catch {
		// Older server or offline: built-in defaults.
	}
	const d = viewerInfo.defaults || {};
	const server = {
		graphics: d.graphics, shaderQuality: d.shaderQuality, postShader: d.postShader || '', clouds: d.clouds,
		labels: d.labels, mobLabels: d.mobLabels, particles: d.particles, mode: d.mode, cctvEffect: d.cctvEffect,
	};
	for (const key of Object.keys(server)) if (server[key] === undefined) delete server[key];
	settings = { ...DEFAULTS, ...server, ...(viewerInfo.locked ? {} : loadLocal()) };
	buildSettingsPanel();
	applySettings();
}

const shaderSources = new Map();

function applySettings() {
	document.body.dataset.mode = settings.mode;
	document.body.classList.toggle('fx', !!settings.cctvEffect);
	renderer.configure({ graphics: settings.graphics, quality: settings.shaderQuality, renderScale: Number(settings.renderScale) || 1, maxPixelRatio: embed ? 1 : 2 });
	entities.showLabels = !!settings.labels;
	entities.showMobLabels = !!settings.mobLabels;
	particles.enabled = settings.particles !== false;
	if (!particles.enabled) particles.clear();
	const name = settings.postShader || '';
	if (name !== (post.customName || '')) {
		if (!name) {
			post.setCustomShader(null, null);
		} else if (shaderSources.has(name)) {
			reportShaderError(post.setCustomShader(name, shaderSources.get(name)));
		} else {
			post.customName = name;
			fetch('/custom/shaders/' + encodeURIComponent(name) + '.glsl' + query, { credentials: 'same-origin' })
				.then(r => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
				.then(source => {
					shaderSources.set(name, source);
					if (settings.postShader === name) reportShaderError(post.setCustomShader(name, source));
				})
				.catch(() => reportShaderError('could not load ' + name + '.glsl'));
		}
	}
	for (const input of document.querySelectorAll('[data-setting]')) {
		const key = input.dataset.setting;
		if (input.type === 'checkbox') input.checked = !!settings[key];
		else input.value = settings[key] ?? '';
	}
	document.body.classList.toggle('locked', !!viewerInfo.locked);
}

function reportShaderError(error) {
	$('assets-status').textContent = error ? 'Shader: ' + error.split('\n')[0] : '';
}

/** Which custom sky box applies to the current dimension ('' = vanilla sky). */
function skyboxFor(dimension) {
	const choice = settings.skybox;
	if (choice && choice !== 'default') return choice === 'none' ? '' : choice;
	return (viewerInfo.defaults.skyboxes || {})[dimension] || '';
}

let panelBuilt = false;

function buildSettingsPanel() {
	const panel = $('settings');
	if (!panel || panelBuilt) return;
	panelBuilt = true;
	const skyboxSelect = panel.querySelector('[data-setting="skybox"]');
	for (const name of Object.keys(viewerInfo.skyboxes || {})) skyboxSelect.append(new Option(name, name));
	const shaderSelect = panel.querySelector('[data-setting="postShader"]');
	for (const name of viewerInfo.shaders || []) shaderSelect.append(new Option(name, name));
	for (const input of panel.querySelectorAll('[data-setting]')) {
		input.addEventListener('change', () => {
			const key = input.dataset.setting;
			settings[key] = input.type === 'checkbox' ? input.checked : input.value;
			saveLocal();
			applySettings();
		});
	}
	$('settings-reset').addEventListener('click', () => {
		try { localStorage.removeItem('cctv-settings-v2'); } catch { /* ignore */ }
		loadViewerInfo();
	});
}

$('open-settings').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; });
$('close-settings').addEventListener('click', () => { $('settings').hidden = true; });

// --- state -------------------------------------------------------------------------------------------

const state = {
	camera: null,
	init: null,
	received: 0,
	total: 0,
	ready: false,
	removed: false,
	lookYaw: 0,
	lookPitch: 0,
	zoom: 1,
	lastFrame: performance.now(),
	fps: 60,
	gameTick: 0,
};
let assetsRequested = false;

// --- stream ------------------------------------------------------------------------------------------

let source = null;
let retryTimer = null;

function streamUrl() {
	return '/api/cameras/' + encodeURIComponent(cameraName) + '/stream' + query;
}

function connect() {
	clearTimeout(retryTimer);
	if (source) source.close();
	setStatus('connecting');
	source = new EventSource(streamUrl());

	source.addEventListener('open', () => setStatus('live'));
	source.addEventListener('error', () => {
		if (state.removed) return;
		if (source.readyState === EventSource.CLOSED) {
			// Server refused (unknown camera, too many viewers, restart...) - try again later.
			setStatus('offline');
			retryTimer = setTimeout(connect, 5000);
		} else {
			setStatus('connecting');
		}
	});

	on('init', data => {
		state.init = data;
		state.camera = data.camera;
		const c = data.camera;
		const origin = [Math.floor(c.x), Math.floor(c.y), Math.floor(c.z)];
		world.reset(origin);
		particles.clear();
		world.setDimension(data.dim || { hasSky: c.dimension !== 'minecraft:the_nether', cardinal: c.dimension === 'minecraft:the_nether' ? 'nether' : 'default' });
		world.setBiomes(data.biomes || {});
		environment.setDimension(data.dim || { id: c.dimension, skybox: c.dimension === 'minecraft:the_end' ? 'end' : c.dimension === 'minecraft:the_nether' ? 'none' : 'overworld' });
		renderer.clearSections(origin);
		renderer.setCamera([c.x - origin[0], c.y - origin[1], c.z - origin[2]]);
		entities.reset();
		weather.setColumns(null);
		loadAssets();
		state.received = 0;
		state.total = data.sections || 0;
		state.ready = false;
		$('cam-sub').textContent = `${c.dimension.replace('minecraft:', '')} · ${c.x.toFixed(0)} ${c.y.toFixed(0)} ${c.z.toFixed(0)}`;
		loadingEl.hidden = false;
		updateLoading();
		hideMessage();
		setStatus('live');
	});
	on('palette', data => world.addPalette(data.s));
	on('section', data => {
		world.setSection(data);
		state.received++;
		updateLoading();
	});
	on('progress', data => {
		state.progress = data;
		updateLoading();
	});
	on('blocks', data => {
		for (const b of data.b) world.setBlock(b[0], b[1], b[2], b[3]);
	});
	on('ready', () => {
		state.ready = true;
		updateLoading();
	});
	on('entities', data => {
		entities.push(data, state.init ? state.init.entityTicks : 1);
		// particles from level events, particle packets, explosions and entity events, due at the frame's tick
		if (data.fx) particles.queueEffects(data.t, data.fx);
	});
	on('env', data => environment.push(data, performance.now()));
	on('weather', data => weather.setColumns(data));
	on('removed', () => {
		state.removed = true;
		source.close();
		setStatus('removed');
		showMessage('This camera has been removed.');
	});
}

function loadAssets() {
	if (assetsRequested) return;
	assetsRequested = true;
	Assets.load(gl, query, text => { $('assets-status').textContent = text; })
		.then(assets => {
			$('assets-status').textContent = '';
			if (!assets) return;
			renderer.atlas = assets.texture;
			world.setAssets(assets);
			entities.setAssets(assets);
			particles.setAssets(assets.bundle, assets.colormaps, assets).catch(err => console.warn('CCTV: particles unavailable', err));
			clouds.setTexture(assets.environment.clouds);
			state.assets = assets;
		})
		.catch(err => {
			console.error('CCTV: textures unavailable', err);
			$('assets-status').textContent = '';
		});
}

function on(event, handler) {
	source.addEventListener(event, e => {
		try {
			handler(JSON.parse(e.data));
		} catch (err) {
			console.error('CCTV: bad "' + event + '" message', err);
		}
	});
}

function updateLoading() {
	if (!state.init) {
		loadingEl.hidden = true;
		return;
	}
	if (!state.init.loaded) showMessage('The camera\'s dimension is not loaded on the server.');
	if (state.ready) {
		loadingEl.hidden = true;
		return;
	}
	const p = state.progress;
	const done = p ? p.d : state.received;
	const total = p ? p.t : state.total;
	const pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
	loadingEl.hidden = false;
	loadingFill.style.width = pct + '%';
	loadingText.textContent = 'Loading the picture… ' + pct + '%';
}

function setStatus(kind) {
	const labels = { live: 'LIVE', connecting: 'CONNECTING…', offline: 'NO SIGNAL', removed: 'CAMERA REMOVED' };
	statusEl.textContent = labels[kind] || kind;
	statusEl.dataset.state = kind;
	document.body.classList.toggle('no-signal', kind !== 'live');
}

function showMessage(text) {
	messageEl.textContent = text;
	messageEl.hidden = false;
}

function hideMessage() {
	messageEl.hidden = true;
}

// --- controls ----------------------------------------------------------------------------------------

let drag = null;
canvas.addEventListener('pointerdown', e => {
	drag = { x: e.clientX, y: e.clientY, yaw: state.lookYaw, pitch: state.lookPitch };
	canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
	if (!drag) return;
	const fov = (state.camera ? state.camera.fov : 70) / state.zoom;
	const perPixel = fov / canvas.clientHeight;
	drag.lastX = e.clientX;
	drag.lastY = e.clientY;
	state.lookYaw = drag.yaw + (e.clientX - drag.x) * perPixel;
	state.lookPitch = Math.max(-89, Math.min(89, drag.pitch + (e.clientY - drag.y) * perPixel));
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('pointercancel', () => { drag = null; });
canvas.addEventListener('dblclick', resetView);
canvas.addEventListener('wheel', e => {
	e.preventDefault();
	state.zoom = Math.max(1, Math.min(8, state.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
}, { passive: false });

function resetView() {
	state.lookYaw = 0;
	state.lookPitch = 0;
	state.zoom = 1;
}

$('reset-view').addEventListener('click', resetView);
$('fullscreen').addEventListener('click', () => {
	const el = $('screen');
	if (document.fullscreenElement) document.exitFullscreen();
	else el.requestFullscreen?.();
});

// --- frame loop --------------------------------------------------------------------------------------

function frustumFrom(m) {
	const planes = [];
	for (const [i, s] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
		const a = m[3] + s * m[i], b = m[7] + s * m[4 + i], c = m[11] + s * m[8 + i], d = m[15] + s * m[12 + i];
		const l = Math.hypot(a, b, c) || 1;
		planes.push([a / l, b / l, c / l, d / l]);
	}
	return (x, y, z, r = 14) => {
		for (const p of planes) {
			if (p[0] * x + p[1] * y + p[2] * z + p[3] < -r) return false;
		}
		return true;
	};
}

/**
 * The server only streams the terrain inside a cone around the camera's direction ("cone" in init, degrees).
 * Turning the view further would show the edge of the loaded world, so the turn is held inside the cone.
 */
function limitLook(c, aspect) {
	const cone = state.init && state.init.cone;
	if (!cone || cone >= 179 || (state.lookYaw === 0 && state.lookPitch === 0)) return;
	const limit = Math.cos(cone * Math.PI / 180);
	const base = direction(c.yaw, c.pitch);
	const t = Math.tan(Math.min(170, c.fov / state.zoom) * Math.PI / 360);
	const inside = k => {
		const f = direction(c.yaw + state.lookYaw * k, Math.max(-89.9, Math.min(89.9, c.pitch + state.lookPitch * k)));
		const l = Math.hypot(f[0], f[2]) || 1;
		const s = [-f[2] / l, 0, f[0] / l];
		const u = [-s[2] * f[1], s[2] * f[0] - s[0] * f[2], s[0] * f[1]];
		for (const a of [-t * aspect, t * aspect]) {
			for (const b of [-t, t]) {
				const x = f[0] + s[0] * a + u[0] * b, y = f[1] + s[1] * a + u[1] * b, z = f[2] + s[2] * a + u[2] * b;
				if ((x * base[0] + y * base[1] + z * base[2]) / Math.hypot(x, y, z) < limit) return false;
			}
		}
		return true;
	};
	if (inside(1)) return;
	let lo = 0, hi = 1;
	for (let i = 0; i < 14; i++) {
		const mid = (lo + hi) / 2;
		if (inside(mid)) lo = mid;
		else hi = mid;
	}
	state.lookYaw *= lo;
	state.lookPitch *= lo;
	// Dragging on past the edge must not build up a dead zone: continue from here.
	if (drag && drag.lastX !== undefined) Object.assign(drag, { x: drag.lastX, y: drag.lastY, yaw: state.lookYaw, pitch: state.lookPitch });
}

const pad2 = n => String(n).padStart(2, '0');

function updateHud(now) {
	const d = new Date();
	clockEl.textContent = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
	const env = environment.current;
	if (state.camera && environment.dim.skybox === 'overworld') {
		const time = env.time || 0;
		const t = ((time % 24000) + 24000) % 24000;
		const hours = Math.floor(t / 1000 + 6) % 24;
		const minutes = Math.floor((t % 1000) / 1000 * 60);
		const day = Math.floor(time / 24000) + 1;
		const weatherText = env.thunder > 0.5 ? ' · thunderstorm' : env.rain > 0.2 ? (env.precipitation === false ? '' : ' · rain') : '';
		gameTimeEl.textContent = `Day ${day} · ${pad2(hours)}:${pad2(minutes)}${weatherText}`;
	} else {
		gameTimeEl.textContent = '';
	}
	if (now - (state.lastStats || 0) > 500) {
		state.lastStats = now;
		const s = renderer.stats;
		statsEl.textContent = `${Math.round(state.fps)} fps · sections ${world.sections.size} · drawn ${s.drawn} · entities ${entities.visibleCount}`;
	}
}

function frame(now) {
	requestAnimationFrame(frame);
	if (embed && (!onScreen || document.hidden)) return;
	if (now - state.lastFrame < frameInterval() - 2) return;
	const dt = now - state.lastFrame;
	state.lastFrame = now;
	state.fps = lerp(state.fps, 1000 / Math.max(1, dt), 0.05);

	const aspect = renderer.resize();
	updateHud(now);

	const c = state.camera;
	if (!c) {
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, canvas.width, canvas.height);
		gl.clearColor(0.02, 0.02, 0.02, 1);
		gl.clear(gl.COLOR_BUFFER_BIT);
		return;
	}

	// Game ticks drive texture animations, torch flicker and flashes, like the client.
	const tick = Math.floor(now / 50);
	let deltaTicks = 0;
	if (tick !== state.gameTick) {
		deltaTicks = Math.min(20, tick - state.gameTick);
		for (let i = 0; i < Math.min(deltaTicks, 4); i++) environment.tick();
		if (state.camera) {
			for (let i = 0; i < Math.min(deltaTicks, 4); i++) {
				particles.tick(world, state.camera, environment.current.rain || 0, entities.tick, state.entityList);
			}
		}
		state.gameTick = tick;
		if (state.assets) state.assets.tick(tick);
	}

	const o = world.origin;
	const eye = [c.x - o[0], c.y - o[1], c.z - o[2]];
	limitLook(c, aspect);
	const pitch = Math.max(-89.9, Math.min(89.9, c.pitch + state.lookPitch));
	const dir = direction(c.yaw + state.lookYaw, pitch);
	const fov = Math.min(170, c.fov / state.zoom) * Math.PI / 180;
	const range = c.range;

	// Environment at the camera.
	const bx = Math.floor(c.x), by = Math.floor(c.y), bz = Math.floor(c.z);
	const cameraBlock = world.infoAt(bx, by, bz);
	const inWater = !!(cameraBlock && cameraBlock.water);
	const skyLight = world.lightAt(bx, by, bz)[0];
	environment.update(now, { x: c.x, y: c.y, z: c.z, forward: dir }, range, skyLight, inWater, deltaTicks);
	renderer.setLightmap(environment.lightmap(settings.mode === 'night' ? 1 : 0));
	const skyState = environment.sky;
	const customName = skyboxFor(environment.dim.id);
	const customDef = customName ? (viewerInfo.skyboxes || {})[customName] : null;
	const custom = customDef ? sky.loadCustom(customName, customDef, query) : null;
	let fog = environment.fog;
	if (custom && custom.ready && custom.horizonColor && !inWater) {
		// Distant terrain fades into the sky box's horizon instead of the vanilla fog colour.
		const k = customBrightness(custom, skyState);
		fog = { ...fog, color: custom.horizonColor.map(c => Math.min(1, c * k)) };
	}

	const cloudRadius = settings.clouds === 'off' ? 0 : Math.min(fog.cloudEnd, settings.graphics === 'shaders' || settings.shaderQuality === 'ultra' ? 2048 : 1024);
	const far = Math.max(range * 2 + 64, cloudRadius + 64, 600);
	const projection = perspective(fov, aspect, 0.05, far);
	const viewRotation = lookDir([0, 0, 0], dir);
	const viewProj = multiply(projection, viewRotation);
	const frustum = frustumFrom(viewProj);

	world.update(eye);

	const list = entities.sample(now);
	state.entityList = list;
	if (deltaTicks > 0 && list.some(e => e.type === 'minecraft:lightning_bolt')) environment.lightning();

	const daylight = environment.daylight();
	const rain = environment.current.rain || 0;
	const sunColor = skyState.sunrise[3] > 0.05
		? [lerp(1, skyState.sunrise[0] * 1.2, skyState.sunrise[3]), lerp(0.95, skyState.sunrise[1], skyState.sunrise[3]), lerp(0.85, skyState.sunrise[2] * 0.8, skyState.sunrise[3])]
		: (Math.cos(skyState.sunAngle) < 0 ? [0.35, 0.42, 0.62] : [1, 0.95, 0.85]);
	const frameData = {
		projection, viewRotation, viewProj, frustum,
		camPos: eye, origin: o, originMod: [((o[0] % 1024) + 1024) % 1024, o[1], ((o[2] % 1024) + 1024) % 1024],
		fog, fogEnd: range, sky: skyState, now, time: now / 1000, daylight, rain, sunColor,
	};
	entities.prepare(frameData, list, world, environment);


	const shadow = renderer.render(frameData, {
		sky: () => sky.render(frameData, skyState, state.assets ? state.assets.environment : null, custom && custom.ready ? custom : null),
		entities: (pass, shadowInfo) => entities.draw(pass, frameData, shadowInfo),
		translucent: () => {
			particles.render(frameData, renderer.lightmap, { x: c.x, y: c.y, z: c.z }, (now / 50) % 1);
			entities.drawNameTags(frameData);
			const showClouds = !(custom && custom.ready && custom.options && custom.options.showClouds === false);
			if (cloudRadius > 0 && showClouds) {
				clouds.render(viewProj, { x: c.x, y: c.y, z: c.z }, settings.clouds === 'fast' ? 'fast' : 'fancy', skyState.cloudColor,
					skyState.cloudHeight, environment.gameTime(now), cloudRadius, fog.cloudEnd);
			}
			weather.render({ viewProj, camera: { x: c.x, y: c.y, z: c.z }, fog, lightmap: renderer.lightmap }, rain, environment.gameTime(now),
				(x, y, z) => world.lightAt(x, y, z), state.assets ? state.assets.environment : null);
			weather.renderLightning(frameData, entities.bolts);
		},
	});

	// Post-processing to the screen.
	let sunScreen = null;
	if (skyState.skybox === 'overworld') {
		const light = renderer.lightDirection(skyState);
		const p = transformPoint(viewProj, light.dir[0] * 100, light.dir[1] * 100, light.dir[2] * 100);
		if (p[3] > 0) sunScreen = [p[0] * 0.5 + 0.5, p[1] * 0.5 + 0.5];
	}
	post.run(renderer.scene, {
		shaders: settings.graphics === 'shaders',
		quality: settings.shaderQuality,
		sun: sunScreen,
		sunColor: shadow && shadow.moon ? [0.25, 0.3, 0.45] : sunColor,
		rays: true,
		raysStrength: (shadow && shadow.moon ? 0.25 : 0.55) * (1 - rain * 0.8) * Math.max(0.15, daylight),
		time: now / 1000,
		daylight,
		rain,
		near: 0.05,
		far,
	});

}

loadViewerInfo().finally(() => {
	connect();
	requestAnimationFrame(frame);
});

// Handy for debugging from the browser console.
window.cctv = { world, renderer, entities, particles, state, environment, settings: () => settings, sky, clouds, weather, post };
