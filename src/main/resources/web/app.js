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
import { Sounds } from './sound.js';
import { SectionCache } from './cache.js';
import { EFFECTS } from './effects.js';
import { Recorder } from './recorder.js';
import { GuiOverlay } from './gui.js';
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
// ?clean: only the picture, without the camera overlay and toolbar (reference renders in CI)
document.body.classList.toggle('clean', params.has('clean'));

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
// ?occlusion=0 draws every section of the units in the frustum (SectionOcclusionGraph and per-section culling
// off, for comparisons)
renderer.occlusionEnabled = params.get('occlusion') !== '0';
renderer.sectionCulling = renderer.occlusionEnabled;
const environment = new Environment();
const sky = new SkyRenderer(gl);
const clouds = new CloudRenderer(gl);
const weather = new WeatherRenderer(gl);
const post = new PostProcessor(gl, renderer);
const entities = new EntityRenderer(renderer);
// ?skinning=0 poses entity models on the CPU (GPU skinning off, for comparisons)
entities.sink.skinning = params.get('skinning') !== '0';
const particles = new Particles(gl);
const sounds = new Sounds(query);
particles.environment = environment;
const world = new World((key, section, message) => {
	renderer.setSectionMesh(key, section, message, performance.now());
});

// --- settings: server defaults (config/cctv/config.json "viewer") + the viewer's own choices ---------------

const DEFAULTS = {
	graphics: 'vanilla', shaderQuality: 'medium', postShader: '', clouds: 'fancy', labels: true, mobLabels: false,
	mode: 'color', cctvEffect: false, skybox: 'default', renderScale: 1, particles: true, fog: 'vanilla', fov: '', blend: '2', music: 'default', musicToast: 'on', timelapse: '5',
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
		fog: d.fog, fov: d.fov ? String(d.fov) : undefined, blend: d.biomeBlend !== undefined ? String(d.biomeBlend) : undefined,
		music: d.music, musicToast: d.musicToast,
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
	environment.fogMode = settings.fog || 'vanilla';
	sounds.musicFrequency = settings.music || 'default';
	const blend = Math.min(7, Math.max(0, Math.round(Number(settings.blend ?? 2)) || 0));
	if (world.config.blend !== blend) world.setBiomeBlend(blend);
	// A wider field of view than the stream was opened with needs the server to send a wider cone of sections.
	if (source && viewFovSetting() > streamFov) connect();
	const name = settings.postShader || '';
	if (name !== (post.customName || '')) {
		const builtin = name.startsWith('builtin:') ? EFFECTS[name.slice(8)] : null;
		if (!name) {
			post.setCustomShader(null, null);
		} else if (builtin) {
			reportShaderError(post.setCustomShader(name, builtin.source));
		} else if (name.startsWith('builtin:')) {
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
	const builtIn = document.createElement('optgroup');
	builtIn.label = 'Built in';
	for (const [id, effect] of Object.entries(EFFECTS)) builtIn.append(new Option(effect.name, 'builtin:' + id));
	shaderSelect.append(builtIn);
	if ((viewerInfo.shaders || []).length) {
		const server = document.createElement('optgroup');
		server.label = 'This server (config/cctv/shaders)';
		for (const name of viewerInfo.shaders) server.append(new Option(name, name));
		shaderSelect.append(server);
	}
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

// Sections kept in IndexedDB between visits (cache.js); off with ?cache=0.
const sectionCache = new SectionCache();
const useCache = sectionCache.available && params.get('cache') !== '0';

/** Settings > Field of view in degrees, 0 for the camera's own. */
function viewFovSetting() {
	const fov = Number(settings.fov);
	return fov >= 30 && fov <= 110 ? fov : 0;
}

/** The field of view the picture uses before zooming: the viewer's own, else the camera's. */
function viewFov(c) {
	return viewFovSetting() || (c ? c.fov : 70);
}

/** The FOV the current stream asked the server to cover (0: the camera's). */
let streamFov = 0;

function streamUrl() {
	const params = [];
	if (useCache) params.push('cache=1');
	streamFov = viewFovSetting();
	if (streamFov) params.push('fov=' + streamFov);
	const base = '/api/cameras/' + encodeURIComponent(cameraName) + '/stream' + query;
	return params.length ? base + (query ? '&' : '?') + params.join('&') : base;
}

/** Tells the server which sections the cache has near the camera (after each "init"), so it sends only the rest. */
function sendCacheManifest(init) {
	const c = init.camera;
	const center = [Math.floor(c.x / 16), Math.floor(c.y / 16), Math.floor(c.z / 16)];
	const range = Math.ceil((c.range || 128) / 16) + 1;
	sectionCache.load(c.dimension, center, range)
		.catch(() => [])
		.then(manifest => fetch('/api/cameras/' + encodeURIComponent(cameraName) + '/cache' + query + (query ? '&' : '?')
			+ 'vid=' + encodeURIComponent(init.vid) + '&epoch=' + init.epoch, {
			method: 'POST', credentials: 'same-origin', body: manifest.map(m => m.join(',')).join(','),
		}))
		.catch(() => {});
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
		if (data.dim && data.dim.height) renderer.setWorldHeight(data.dim.minY, data.dim.height);
		world.setDimension(data.dim || { hasSky: c.dimension !== 'minecraft:the_nether', cardinal: c.dimension === 'minecraft:the_nether' ? 'nether' : 'default' });
		world.setBiomes(data.biomes || {});
		environment.setDimension(data.dim || { id: c.dimension, skybox: c.dimension === 'minecraft:the_end' ? 'end' : c.dimension === 'minecraft:the_nether' ? 'none' : 'overworld' });
		renderer.clearSections(origin);
		renderer.setCamera([c.x - origin[0], c.y - origin[1], c.z - origin[2]]);
		entities.reset();
		weather.setColumns(null);
		sounds.resetAmbience();
		loadAssets();
		state.received = 0;
		state.total = data.sections || 0;
		state.ready = false;
		if (useCache && data.vid) sendCacheManifest(data);
		$('cam-sub').textContent = `${c.dimension.replace('minecraft:', '')} · ${c.x.toFixed(0)} ${c.y.toFixed(0)} ${c.z.toFixed(0)}`;
		loadingEl.hidden = false;
		updateLoading();
		hideMessage();
		setStatus('live');
	});
	on('palette', data => world.addPalette(data.s));
	on('section', (data, raw) => {
		world.setSection(data);
		if (useCache) sectionCache.store(data.x, data.y, data.z, raw);
		state.received++;
		updateLoading();
	});
	// cached sections the server found unchanged: shown from the cache
	on('keep', data => {
		const k = data.k;
		for (let i = 0; i + 2 < k.length; i += 3) {
			const raw = sectionCache.take(k[i], k[i + 1], k[i + 2]);
			if (!raw) continue;
			world.setSection(JSON.parse(raw));
			state.received++;
		}
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
		if (useCache) sectionCache.finish();
	});
	on('entities', data => {
		entities.push(data, state.init ? state.init.entityTicks : 1);
		// particles from level events, particle packets, explosions and entity events, due at the frame's tick
		if (data.fx) {
			particles.queueEffects(data.t, data.fx);
			sounds.queue(data.t, data.fx, data.e);
			for (const fx of data.fx) if (fx[0] === 'js' && fx[5]) showNowPlaying(fx[5]);
		}
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
			handler(JSON.parse(e.data), e.data);
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
	const fov = viewFov(state.camera) / state.zoom;
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

// The game's sounds at the camera: off until asked for (browsers only play sound after a click), remembered.
const soundButton = $('sound');
function showSound() {
	soundButton.textContent = sounds.enabled ? '🔊 Sound on' : '🔈 Sound off';
	soundButton.classList.toggle('on', sounds.enabled);
}
async function setSound(on) {
	if (on) await sounds.enable();
	else sounds.disable();
	// blocks' own sounds (animateTick) come from the particle system's block ticks
	particles.onSound = sounds.enabled ? (...args) => sounds.local(...args) : null;
	try {
		localStorage.setItem('cctv-sound', sounds.enabled ? '1' : '0');
	} catch {
		// not remembered
	}
	showSound();
}
soundButton.addEventListener('click', () => setSound(!sounds.enabled));

// Recording in the browser (recorder.js): a video, or a timelapse, with the overlay's text burnt in.
const recorder = new Recorder(canvas, {
	audio: () => sounds.recordingStream(),
	name: () => cameraName,
	label: () => ({
		left: [$('cam-name').textContent, $('cam-sub').textContent],
		right: [clockEl.textContent, gameTimeEl.textContent],
	}),
});
const recordButton = $('record');
const timelapseButton = $('timelapse');
const clockText = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
function updateRecording() {
	const mode = recorder.mode;
	recordButton.textContent = mode === 'video' ? `⏹ Stop ${clockText(recorder.elapsed())}` : '⏺ Record';
	timelapseButton.textContent = mode === 'timelapse' ? `⏹ Stop timelapse · ${recorder.frames.length}`
		: mode === 'encoding' ? `Saving… ${Math.round(recorder.encoded / recorder.total * 100)} %` : '⏱ Timelapse';
	recordButton.disabled = mode === 'timelapse' || mode === 'encoding';
	timelapseButton.disabled = mode === 'video' || mode === 'encoding';
	recordButton.classList.toggle('on', mode === 'video');
	timelapseButton.classList.toggle('on', mode === 'timelapse');
}
recorder.onchange = updateRecording;
recordButton.addEventListener('click', () => (recorder.mode === 'video' ? recorder.stop() : recorder.startVideo()));
timelapseButton.addEventListener('click', () => (recorder.mode === 'timelapse' ? recorder.stop()
	: recorder.startTimelapse(Number(settings.timelapse) || 5)));
setInterval(() => { if (recorder.mode === 'video') updateRecording(); }, 1000);
let soundWanted = false;
try {
	soundWanted = localStorage.getItem('cctv-sound') === '1';
} catch {
	// no storage
}
if (soundWanted) {
	// turned on last time: starts with the first click or key on the page
	const resume = () => {
		window.removeEventListener('pointerdown', resume, true);
		window.removeEventListener('keydown', resume, true);
		if (!sounds.enabled) setSound(true);
	};
	window.addEventListener('pointerdown', resume, true);
	window.addEventListener('keydown', resume, true);
}
showSound();
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
	const t = Math.tan(Math.min(170, viewFov(c) / state.zoom) * Math.PI / 360);
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

// The game's Now Playing toast for the background music and the jukebox's "Now Playing" line, in the game's
// sprites and font (gui.js)
const gui = new GuiOverlay($('gui'), () => (entities.text.ready ? entities.text.font : null), query, document.querySelector('.hud.top-left'));
sounds.onMusicChange = title => {
	if (settings.musicToast !== 'off') gui.showNowPlaying(title);
};

function showNowPlaying(text) {
	gui.showOverlay(text);
}

function frame(now) {
	requestAnimationFrame(frame);
	if (embed && (!onScreen || document.hidden)) return;
	if (now - state.lastFrame < frameInterval() - 2) return;
	const dt = now - state.lastFrame;
	state.lastFrame = now;
	state.fps = lerp(state.fps, 1000 / Math.max(1, dt), 0.05);
	const frameStart = performance.now();

	const aspect = renderer.resize();
	updateHud(now);
	gui.draw(now);

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
			const c0 = state.camera;
			const gameTime = Math.floor(environment.gameTime(now));
			const eye = world.entryAt(Math.floor(c0.x), Math.floor(c0.y), Math.floor(c0.z));
			const eyeInfo = world.infoAt(Math.floor(c0.x), Math.floor(c0.y), Math.floor(c0.z));
			for (let i = Math.min(deltaTicks, 4) - 1; i >= 0; i--) {
				particles.tick(world, c0, environment.current.rain || 0, entities.tick, state.entityList, weather.columns, gameTime - i);
				sounds.ambient({ world, camera: c0, ambience: environment.current.amb, music: environment.current.music, inWater: !!(eyeInfo && eyeInfo.water), block: eye, flash: environment.flash, entities: state.entityList,
					dimension: environment.dim && environment.dim.id, timmStructure: environment.current.timm });
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
	// what item models read from the world (ClockItem's time, context_dimension)
	entities.dayTime = environment.current ? environment.current.time || 0 : 0;
	entities.dimension = state.init && state.init.camera ? state.init.camera.dimension : null;
	sounds.update(entities.tick, c, dir, state.entityList);
	const fov = Math.min(170, viewFov(c) / state.zoom) * Math.PI / 180;
	const range = c.range;

	// Environment at the camera.
	const bx = Math.floor(c.x), by = Math.floor(c.y), bz = Math.floor(c.z);
	const cameraBlock = world.infoAt(bx, by, bz);
	const inWater = !!(cameraBlock && cameraBlock.water);
	// Camera.getFluidInCamera: the fog (and the underwater overlay) of what the camera is in
	const medium = inWater ? 'water' : cameraBlock && cameraBlock.lava ? 'lava' : cameraBlock && cameraBlock.name === 'minecraft:powder_snow' ? 'powder_snow' : null;
	const [skyLight, blockLight] = world.lightAt(bx, by, bz);
	state.medium = medium;
	environment.update(now, { x: c.x, y: c.y, z: c.z, forward: dir }, range, skyLight, medium, deltaTicks);
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
		width: canvas.width, height: canvas.height,
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
			entities.drawOutlines(frameData, renderer.scene);
			if (medium === 'water') {
				// ScreenEffectRenderer: brightness of the light at the camera (getMaxLocalRawBrightness, LightTexture.getBrightness)
				const raw = Math.max(skyLight - (environment.current.skyDarken || 0), blockLight) / 15;
				const curve = raw / (4 - 3 * raw);
				const brightness = lerp(curve, 1, environment.dim.ambient || 0);
				entities.drawUnderwater(renderer.scene, brightness, c.yaw + state.lookYaw, pitch);
			}
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
	// the page's own time per frame (CI budget; the GPU works on afterwards)
	state.frameMs = state.frameMs ? lerp(state.frameMs, performance.now() - frameStart, 0.05) : performance.now() - frameStart;
}

loadViewerInfo().finally(() => {
	soundButton.hidden = viewerInfo.sounds === false || embed;
	recordButton.hidden = timelapseButton.hidden = viewerInfo.recording === false || embed || !recorder.supported;
	connect();
	requestAnimationFrame(frame);
});

// Handy for debugging from the browser console.
window.cctv = { world, renderer, entities, particles, sounds, state, environment, settings: () => settings, sky, clouds, weather, post, recorder, gui };
