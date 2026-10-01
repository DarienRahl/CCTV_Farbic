// CI reference renders, the viewer's side: for each shot of the client game test (src/gametest, ReferenceRenders)
// waits until the game has taken its picture and moved the "ref" camera to the same eyes, takes the viewer's
// picture of that camera at the same size and tells the game test it is done; stops after the last shot.
// usage: node reference.mjs <game dir>/reference
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const dir = process.argv[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const deadline = Date.now() + 40 * 60 * 1000;
const taken = new Set();

/** The next shot the game is ready for, or null once it has finished. */
async function nextShot() {
	for (;;) {
		if (fs.existsSync(dir)) {
			const ready = fs.readdirSync(dir).filter(f => /^ready-.+\.json$/.test(f)).sort((a, b) =>
				fs.statSync(path.join(dir, a)).mtimeMs - fs.statSync(path.join(dir, b)).mtimeMs);
			const next = ready.find(f => !taken.has(f));
			if (next) {
				taken.add(next);
				return JSON.parse(fs.readFileSync(path.join(dir, next), 'utf8'));
			}
			if (fs.existsSync(path.join(dir, 'finished'))) return null;
		}
		if (Date.now() > deadline) {
			console.log('the game test stopped sending shots');
			return null;
		}
		await sleep(1000);
	}
}

let browser = null;
let page = null;
try {
	for (let info = await nextShot(); info; info = await nextShot()) {
		console.log('game ready:', JSON.stringify(info));
		if (!page) {
			browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
			page = await browser.newPage({ viewport: { width: info.width, height: info.height } });
			// the game's options the viewer has too (clouds: off / fast / fancy)
			const settings = { graphics: 'vanilla', clouds: ['off', 'fast', 'fancy'].includes(info.clouds) ? info.clouds : 'fancy' };
			await page.addInitScript(s => localStorage.setItem('cctv-settings-v2', s), JSON.stringify(settings));
			page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('[browser]', m.type(), m.text()); });
			page.on('pageerror', e => console.log('[browser] pageerror', e.message));
			await page.goto(`http://127.0.0.1:8100/cam/${info.camera}?clean`);
		}
		try {
			// the camera at the game's eyes, block textures loaded, the world around it meshed and the entity models
			await page.waitForFunction(eye => {
				const c = window.cctv;
				const cam = c && c.state.camera;
				// a new "init" since the last picture: the camera was moved there and the world is being sent again
				return cam && c.state.init !== window.lastShotInit && Math.abs(cam.x - eye[0]) < 0.3 && Math.abs(cam.y - eye[1]) < 0.3 && Math.abs(cam.z - eye[2]) < 0.3
					&& c.world.assets && c.state.ready && c.world.sections.size > 0 && c.world.dirty.size === 0 && c.entities.library.layers;
			}, info.eye, { timeout: 600000, polling: 500 });
		} catch (e) {
			console.log('not ready:', e.message);
		}
		await page.waitForTimeout(10000);
		console.log('viewer:', await page.evaluate(() => JSON.stringify({
			camera: window.cctv.state.camera,
			sections: window.cctv.world.sections.size,
			stats: window.cctv.renderer.stats,
			entities: window.cctv.entities.visibleCount,
		})));
		await page.screenshot({ path: path.join(dir, `viewer-${info.shot}.png`) });
		await page.evaluate(() => { window.lastShotInit = window.cctv.state.init; });
		fs.writeFileSync(path.join(dir, `done-${info.shot}`), 'done');
	}
} finally {
	if (browser) await browser.close();
}
