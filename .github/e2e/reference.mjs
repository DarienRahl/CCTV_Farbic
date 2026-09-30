// CI reference renders, the viewer's side: waits until the client game test (src/gametest, ReferenceRenders) has
// taken the game's picture and put the "ref" camera at the same eyes, takes the viewer's picture of that camera
// at the same size and tells the game test it is done.
// usage: node reference.mjs <game dir>/reference
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const dir = process.argv[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const deadline = Date.now() + 30 * 60 * 1000;
const ready = path.join(dir, 'ready.json');
while (!fs.existsSync(ready)) {
	if (Date.now() > deadline) {
		console.log('the game test never got ready');
		process.exit(1);
	}
	await sleep(2000);
}
const info = JSON.parse(fs.readFileSync(ready, 'utf8'));
console.log('game ready:', JSON.stringify(info));

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
	const page = await browser.newPage({ viewport: { width: info.width, height: info.height } });
	// the game's options the viewer has too (clouds: off / fast / fancy)
	const settings = { graphics: 'vanilla', clouds: ['off', 'fast', 'fancy'].includes(info.clouds) ? info.clouds : 'fancy' };
	await page.addInitScript(s => localStorage.setItem('cctv-settings-v2', s), JSON.stringify(settings));
	page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('[browser]', m.type(), m.text()); });
	page.on('pageerror', e => console.log('[browser] pageerror', e.message));
	await page.goto(`http://127.0.0.1:8100/cam/${info.camera}?clean`);
	// block textures (downloaded by the server), the world meshed and entity models loaded
	await page.waitForFunction(() => window.cctv && window.cctv.world.assets && window.cctv.state.ready
		&& window.cctv.world.dirty.size === 0 && window.cctv.entities.library.layers, null, { timeout: 600000 }).catch(e => console.log('not ready:', e.message));
	await page.waitForTimeout(10000);
	console.log('viewer:', await page.evaluate(() => JSON.stringify({
		sections: window.cctv.world.sections.size,
		stats: window.cctv.renderer.stats,
		entities: window.cctv.entities.visibleCount,
		canvas: [document.getElementById('view').width, document.getElementById('view').height],
	})));
	await page.screenshot({ path: path.join(dir, 'viewer.png') });
} finally {
	await browser.close();
	fs.writeFileSync(path.join(dir, 'done'), 'done');
}
