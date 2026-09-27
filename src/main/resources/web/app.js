// Live camera viewer: connects to the server's event stream, keeps a local copy
// of the blocks around the camera and renders them together with live entities.

import { World } from './world.js';
import { Renderer } from './renderer.js';
import { EntityRenderer } from './entities.js';
import { Assets } from './assets.js';
import { Lighting } from './lighting.js';
import { perspective, lookDir, multiply, invert, direction, lerp } from './math.js';

const params = new URLSearchParams(location.search);
const token = params.get('token');
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
$('cam-name').textContent = cameraName.toUpperCase();
document.title = 'CCTV · ' + cameraName;

const settings = loadSettings();

let renderer;
try {
	renderer = new Renderer(canvas);
} catch (e) {
	showMessage('Ta przeglądarka nie obsługuje WebGL2: ' + e.message);
	throw e;
}

const world = new World();
const entities = new EntityRenderer(renderer, $('labels'));
const lighting = new Lighting();
let assetsRequested = false;
applySettings();

const state = {
	camera: null,
	init: null,
	env: { time: 6000, rain: false, thunder: false },
	received: 0,
	ready: false,
	connected: false,
	removed: false,
	entities: [],
	lookYaw: 0,
	lookPitch: 0,
	zoom: 1,
	lastFrame: performance.now(),
	fps: 60,
};

// --- stream ---------------------------------------------------------------

let source = null;
let retryTimer = null;

function streamUrl() {
	return '/api/cameras/' + encodeURIComponent(cameraName) + '/stream' + (token ? '?token=' + encodeURIComponent(token) : '');
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
		world.biomeDefs = data.biomes || {};
		loadAssets();
		state.received = 0;
		state.ready = false;
		const c = data.camera;
		world.reset([Math.floor(c.x), Math.floor(c.y), Math.floor(c.z)]);
		renderer.clearSections();
		entities.reset();
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
	on('blocks', data => {
		for (const b of data.b) world.setBlock(b[0], b[1], b[2], b[3]);
	});
	on('ready', () => {
		state.ready = true;
		updateLoading();
	});
	on('entities', data => entities.push(data, state.init ? state.init.entityTicks : 1));
	on('env', data => { state.env = data; });
	on('removed', () => {
		state.removed = true;
		source.close();
		setStatus('removed');
		showMessage('Kamera została usunięta.');
	});
}

function loadAssets() {
	if (assetsRequested) return;
	assetsRequested = true;
	const query = token ? '?token=' + encodeURIComponent(token) : '';
	Assets.load(renderer.gl, query, text => { $('assets-status').textContent = text; })
		.then(assets => {
			$('assets-status').textContent = '';
			if (!assets) return;
			renderer.atlas = assets.texture;
			world.setAssets(assets);
			entities.setAssets(assets);
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
	const total = state.init ? state.init.sections : 0;
	if (state.ready || total === 0) {
		loadingEl.hidden = state.ready || !state.init;
		if (state.init && !state.init.loaded) {
			showMessage('Wymiar kamery nie jest wczytany na serwerze.');
		}
		return;
	}
	const pct = Math.min(100, Math.round(state.received / total * 100));
	loadingFill.style.width = pct + '%';
	loadingText.textContent = 'Wczytywanie obrazu… ' + pct + '%';
}

function setStatus(kind) {
	state.connected = kind === 'live';
	const labels = {
		live: 'NA ŻYWO',
		connecting: 'ŁĄCZENIE…',
		offline: 'BRAK SYGNAŁU',
		removed: 'KAMERA USUNIĘTA',
	};
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

// --- controls -------------------------------------------------------------

let drag = null;
canvas.addEventListener('pointerdown', e => {
	drag = { x: e.clientX, y: e.clientY, yaw: state.lookYaw, pitch: state.lookPitch };
	canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
	if (!drag) return;
	const fov = (state.camera ? state.camera.fov : 70) / state.zoom;
	const perPixel = fov / canvas.clientHeight;
	state.lookYaw = drag.yaw + (e.clientX - drag.x) * perPixel;
	state.lookPitch = Math.max(-89, Math.min(89, drag.pitch + (e.clientY - drag.y) * perPixel));
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('pointercancel', () => { drag = null; });
canvas.addEventListener('dblclick', resetView);
canvas.addEventListener('wheel', e => {
	e.preventDefault();
	state.zoom = Math.max(1, Math.min(6, state.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
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
$('mode').addEventListener('click', () => {
	const modes = ['color', 'mono', 'night'];
	settings.mode = modes[(modes.indexOf(settings.mode) + 1) % modes.length];
	saveSettings();
	applySettings();
});
for (const button of document.querySelectorAll('[data-toggle]')) {
	button.addEventListener('click', () => {
		const key = button.dataset.toggle;
		settings[key] = !settings[key];
		saveSettings();
		applySettings();
	});
}

function loadSettings() {
	const defaults = { labels: true, allLabels: false, fx: false, mode: 'color' };
	try {
		return { ...defaults, ...JSON.parse(localStorage.getItem('cctv-settings') || '{}') };
	} catch {
		return defaults;
	}
}

function saveSettings() {
	try {
		localStorage.setItem('cctv-settings', JSON.stringify(settings));
	} catch {
		// Storage unavailable (private mode) - settings just are not remembered.
	}
}

function applySettings() {
	document.body.dataset.mode = settings.mode;
	document.body.classList.toggle('fx', settings.fx);
	const names = { color: 'Kolor', mono: 'Cz/B', night: 'Noktowizor' };
	$('mode').textContent = 'Tryb: ' + names[settings.mode];
	for (const button of document.querySelectorAll('[data-toggle]')) {
		button.classList.toggle('on', !!settings[button.dataset.toggle]);
	}
	entities.showLabels = settings.labels;
	entities.showAllLabels = settings.allLabels;
}

// --- environment ----------------------------------------------------------

function dimension() {
	return state.camera ? state.camera.dimension : 'minecraft:overworld';
}

// --- frame loop -----------------------------------------------------------

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

function meshDirty(eye, budgetMs) {
	if (world.dirty.size === 0) return;
	const start = performance.now();
	const o = world.origin;
	const keys = [...world.dirty];
	const dist = key => {
		const [x, y, z] = key.split(',').map(Number);
		const dx = x * 16 + 8 - o[0] - eye[0], dy = y * 16 + 8 - o[1] - eye[1], dz = z * 16 + 8 - o[2] - eye[2];
		return dx * dx + dy * dy + dz * dz;
	};
	const scored = keys.map(k => [dist(k), k]).sort((a, b) => a[0] - b[0]);
	for (const [, key] of scored) {
		world.dirty.delete(key);
		const section = world.sections.get(key);
		if (section) renderer.setSectionMesh(key, section, world.mesh(section));
		else renderer.removeSection(key);
		if (performance.now() - start > budgetMs) break;
	}
}

function pad2(n) {
	return String(n).padStart(2, '0');
}

function updateHud(now) {
	const d = new Date();
	clockEl.textContent = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
	if (state.camera && state.camera.dimension === 'minecraft:overworld') {
		const t = ((state.env.time % 24000) + 24000) % 24000;
		const hours = Math.floor(t / 1000 + 6) % 24;
		const minutes = Math.floor((t % 1000) / 1000 * 60);
		const dayNumber = Math.floor(state.env.time / 24000) + 1;
		gameTimeEl.textContent = `Dzień ${dayNumber} · ${pad2(hours)}:${pad2(minutes)}${state.env.rain ? (state.env.thunder ? ' · burza' : ' · deszcz') : ''}`;
	} else {
		gameTimeEl.textContent = '';
	}
	if (now - (state.lastStats || 0) > 500) {
		state.lastStats = now;
		statsEl.textContent = `${Math.round(state.fps)} fps · sekcje ${renderer.meshes.size} · encje ${entities.visibleCount}`;
	}
}

function frame(now) {
	requestAnimationFrame(frame);
	const dt = now - state.lastFrame;
	state.lastFrame = now;
	state.fps = lerp(state.fps, 1000 / Math.max(1, dt), 0.05);

	const aspect = renderer.resize();
	updateHud(now);

	const c = state.camera;
	if (!c) {
		const gl = renderer.gl;
		gl.clearColor(0.02, 0.02, 0.02, 1);
		gl.clear(gl.COLOR_BUFFER_BIT);
		return;
	}

	const o = world.origin;
	const eye = [c.x - o[0], c.y - o[1], c.z - o[2]];
	const pitch = Math.max(-89.9, Math.min(89.9, c.pitch + state.lookPitch));
	const dir = direction(c.yaw + state.lookYaw, pitch);
	const fov = Math.min(170, c.fov / state.zoom) * Math.PI / 180;
	const range = c.range;
	const projection = perspective(fov, aspect, 0.05, range * 1.5 + 32);
	const view = lookDir(eye, dir);
	const viewProj = multiply(projection, view);

	// Game ticks drive texture animations and torch flicker, like the client.
	const gameTick = Math.floor(now / 50);
	if (gameTick !== state.gameTick) {
		state.gameTick = gameTick;
		lighting.tick();
		if (world.assets) world.assets.tick(gameTick);
	}

	meshDirty(eye, state.ready ? 6 : 12);

	const sky = lighting.sky(state.env, dimension());
	renderer.setLightmap(lighting.lightmap(state.env, dimension(), settings.mode === 'night' ? 1 : 0));
	const frameData = {
		viewProj,
		invViewProj: invert(viewProj),
		camPos: eye,
		origin: o,
		fogColor: sky.fog,
		// Minecraft's render distance fog: only the last ~10% of the view distance.
		fogStart: range - Math.max(4, Math.min(64, range / 10)),
		fogEnd: range,
		horizon: sky.horizon,
		zenith: sky.zenith,
		sunDir: sky.sunDir,
		sun: sky.sun,
		moon: sky.moon,
		stars: sky.stars,
		moonPhase: sky.moonPhase,
		cloudColor: sky.cloud,
		cloudY: 192.33 - c.y,
		cloudPos: [((c.x + now / 50 * 0.03) % 3072 + 3072) % 3072, ((c.z + 3.96) % 3072 + 3072) % 3072],
		environment: world.assets ? { sun: world.assets.sunTexture, moon: world.assets.moonTexture, clouds: world.assets.cloudTexture } : null,
		time: now / 1000,
		frustum: frustumFrom(viewProj),
	};

	const list = entities.sample(now);
	renderer.render(frameData, () => entities.draw(frameData, list, now, world));
	entities.updateLabels(frameData, list, canvas.clientWidth, canvas.clientHeight);
}

connect();
requestAnimationFrame(frame);

// Handy for debugging from the browser console.
window.cctv = { world, renderer, entities, state, lighting, settings };
