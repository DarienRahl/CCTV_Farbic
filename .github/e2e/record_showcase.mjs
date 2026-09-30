// The README's video (screenshots workflow): the "party" camera recorded with the viewer's own Record button
// (recorder.js: the picture, the game's GUI over it, the camera's label and the game's sounds) while
// showcase.py plays the party.
//
// Chromium draws in software on CI, a few pictures a second, so the video is made in slow motion: the server
// runs at SPEED times its pace (/tick rate), the page's clock and its sounds at the same pace (the sounds
// lower by as much), and make_video.sh speeds the recording up again, which brings the sounds back to their
// own pitch.
//
//     SPEED=0.2 node record_showcase.mjs <out.webm>      (the server set to the same pace: showcase.py --speed)
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const OUT = process.argv[2] || 'showcase.webm';
const SPEED = Number(process.env.SPEED || 0.25);
const WEB = 'http://127.0.0.1:8100';

/** Runs in the page before its scripts: its clock, timers and Web Audio at `scale` times real time. */
function slowMotion(scale) {
	const realNow = performance.now.bind(performance);
	const origin = realNow();
	const now = () => origin + (realNow() - origin) * scale;
	performance.now = now;
	const raf = window.requestAnimationFrame.bind(window);
	window.requestAnimationFrame = callback => raf(() => callback(now()));
	const setTimeoutReal = window.setTimeout.bind(window), setIntervalReal = window.setInterval.bind(window);
	window.setTimeout = (fn, ms, ...args) => setTimeoutReal(fn, (ms || 0) / scale, ...args);
	window.setInterval = (fn, ms, ...args) => setIntervalReal(fn, (ms || 0) / scale, ...args);
	// every sound plays at `scale` times its rate (slower and lower) and starts when it is due in page time
	const rates = new WeakSet();
	const value = Object.getOwnPropertyDescriptor(AudioParam.prototype, 'value');
	Object.defineProperty(AudioParam.prototype, 'value', {
		configurable: true,
		enumerable: true,
		get() { return rates.has(this) ? value.get.call(this) / scale : value.get.call(this); },
		set(v) { value.set.call(this, rates.has(this) ? v * scale : v); },
	});
	for (const name of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime']) {
		const original = AudioParam.prototype[name];
		AudioParam.prototype[name] = function (v, ...rest) { return original.call(this, rates.has(this) ? v * scale : v, ...rest); };
	}
	const createBufferSource = BaseAudioContext.prototype.createBufferSource;
	BaseAudioContext.prototype.createBufferSource = function () {
		const node = createBufferSource.call(this);
		rates.add(node.playbackRate);
		value.set.call(node.playbackRate, scale);
		return node;
	};
	const start = AudioBufferSourceNode.prototype.start;
	AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) {
		const t = this.context.currentTime;
		return start.call(this, when > t ? t + (when - t) / scale : when, ...rest);
	};
}

const browser = await chromium.launch({
	args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') console.log('[browser]', m.text()); });
await page.addInitScript(slowMotion, SPEED);
// the jukebox is the music (no background music), the game's look
await page.addInitScript(() => localStorage.setItem('cctv-settings-v2', JSON.stringify({ music: 'off', graphics: 'vanilla' })));
await page.goto(`${WEB}/cam/party`);
// the picture fills the page (the recording is the picture, its label is burnt in by the recorder)
await page.addStyleTag({ content: '#toolbar { display: none !important; } .hud { display: none !important; }' });
await page.waitForFunction(() => window.cctv && window.cctv.world.assets && window.cctv.state.ready
	&& window.cctv.world.dirty.size === 0 && window.cctv.entities.library.layers, null, { timeout: 600000 });
await page.waitForTimeout(20000);
await page.evaluate(() => document.getElementById('sound').click());
await page.waitForTimeout(4000);
console.log('before recording:', await page.evaluate(() => JSON.stringify({
	sound: window.cctv.sounds.ctx && window.cctv.sounds.ctx.state, sections: window.cctv.world.sections.size,
	entities: window.cctv.entities.visibleCount,
})));

const download = page.waitForEvent('download', { timeout: 900000 });
await page.evaluate(() => {
	window.cctv.recorder.startVideo();
	// a slow pan from left to right over the party, in page time
	const state = window.cctv.state;
	const t0 = performance.now();
	const pan = () => {
		const t = Math.min(1, (performance.now() - t0) / 15000);
		state.lookYaw = -9 + 18 * (0.5 - 0.5 * Math.cos(Math.PI * t));
		if (window.cctv.recorder.mode === 'video') requestAnimationFrame(pan);
	};
	pan();
});
const party = spawn('python3', ['showcase.py', '--play', String(SPEED)], { stdio: 'inherit' });
const code = await new Promise(resolve => party.on('exit', resolve));
await page.waitForTimeout(1000 / SPEED);
const fps = await page.evaluate(() => Math.round(window.cctv.state.fps * 10) / 10);
await page.evaluate(() => window.cctv.recorder.stop());
await (await download).saveAs(OUT);
console.log(`recorded ${OUT} (${fps} pictures a second in page time, party script exit ${code})`);
await browser.close();
if (errors.length || code !== 0) {
	console.error('errors:\n' + errors.join('\n'));
	process.exit(1);
}
