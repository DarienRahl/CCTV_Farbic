// The README's pictures (screenshots workflow): the cameras of the smoke test's scene in headless Chromium,
// saved as PNG into the folder given as the first argument, for readme_images.py to put together.
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || 'shots';
const WEB = 'http://127.0.0.1:8100';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];

async function open(camera, settings, viewport = { width: 1600, height: 900 }) {
	const page = await browser.newPage({ viewport });
	page.on('pageerror', e => errors.push(camera + ': ' + e.message));
	if (settings) await page.addInitScript(s => localStorage.setItem('cctv-settings-v2', s), JSON.stringify(settings));
	await page.goto(`${WEB}/cam/${camera}`);
	// the textures, the entity models and every section meshed, then time for the far terrain and the mobs
	await page.waitForFunction(() => window.cctv && window.cctv.world.assets && window.cctv.state.ready
		&& window.cctv.world.dirty.size === 0 && window.cctv.entities.library.layers, null, { timeout: 240000 }).catch(() => {});
	await page.waitForTimeout(10000);
	return page;
}

/** The picture without the toolbar under it (the HUD in the game's font stays). */
async function picture(page, name) {
	const box = await page.locator('#screen').boundingBox();
	await page.screenshot({ path: `${OUT}/${name}.png`, clip: box });
	console.log('picture', name);
}

let page = await open('ci', null);
await picture(page, 'vanilla');
await page.close();

page = await open('ci', { graphics: 'shaders', shaderQuality: 'high' });
await picture(page, 'shaders');
await page.close();

page = await open('far', { fov: '90', fog: 'atmospheric', postShader: 'builtin:cinematic' });
await picture(page, 'far');
await page.close();

page = await open('wet', null);
await picture(page, 'underwater');
await page.close();

// every built-in post effect on the same view
page = await open('ci', null, { width: 1280, height: 760 });
const effects = await page.evaluate(() => [...document.querySelector('[data-setting="postShader"]').options]
	.filter(o => o.value.startsWith('builtin:')).map(o => [o.value, o.textContent]));
fs.writeFileSync(`${OUT}/effects.json`, JSON.stringify(effects));
for (const [value] of effects) {
	await page.evaluate(v => {
		const select = document.querySelector('[data-setting="postShader"]');
		select.value = v;
		select.dispatchEvent(new Event('change'));
	}, value);
	await page.waitForTimeout(2500);
	await picture(page, 'effect-' + value.slice('builtin:'.length));
}
await page.close();

// the page itself in the game's font: the settings open and the Now Playing toast of a song
page = await open('ci', null, { width: 1600, height: 900 });
await page.click('#open-settings');
await page.evaluate(async () => {
	const sounds = window.cctv.sounds;
	sounds.loadMusicInfo();
	for (let i = 0; i < 100 && !sounds.musicInfo; i++) await new Promise(r => setTimeout(r, 100));
	window.cctv.gui.showNowPlaying(sounds.songTitle('minecraft:music/game/sweden'));
});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/ui.png` });
console.log('picture ui');
await page.close();

page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
await page.goto(WEB + '/');
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/list.png` });
await page.close();

// the font for the labels of the pictures
const font = await fetch(WEB + '/assets/font/minecraft-bold.ttf');
fs.writeFileSync(`${OUT}/minecraft-bold.ttf`, Buffer.from(await font.arrayBuffer()));
await browser.close();

if (errors.length) {
	console.error('viewer script errors:\n' + errors.join('\n'));
	process.exit(1);
}
