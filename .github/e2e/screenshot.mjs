// CI: opens the live viewer of the "ci" camera in headless Chromium and saves screenshots
// (vanilla graphics and the shader look).
import { chromium } from 'playwright';

const pageErrors = [];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

async function shoot(name, settings, camera = 'ci') {
	const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
	page.on('console', m => console.log('[browser]', m.type(), m.text()));
	page.on('pageerror', e => { console.log('[browser] pageerror', e.message); pageErrors.push(name + ': ' + e.message); });
	if (settings) await page.addInitScript(s => localStorage.setItem('cctv-settings-v2', s), JSON.stringify(settings));
	await page.goto('http://127.0.0.1:8100/cam/' + camera);
	// Wait for block textures (downloaded by the server) and for the world to be meshed.
	await page.waitForFunction(() => window.cctv && window.cctv.world.assets && window.cctv.state.ready && window.cctv.world.dirty.size === 0, null, { timeout: 180000 }).catch(() => {});
	await page.waitForTimeout(8000);
	const info = await page.evaluate(() => ({
		textures: !!(window.cctv && window.cctv.world.assets),
		sections: window.cctv ? window.cctv.world.sections.size : 0,
		units: window.cctv ? window.cctv.renderer.units.size : 0,
		entities: window.cctv ? window.cctv.entities.visibleCount : 0,
		models: !!(window.cctv && window.cctv.entities.library.layers),
		status: document.getElementById('status').textContent,
		init: !!(window.cctv && window.cctv.state.init),
		received: window.cctv ? window.cctv.state.received : 0,
		ready: !!(window.cctv && window.cctv.state.ready),
		text: window.cctv ? window.cctv.entities.text.draws.length : 0,
		signs: window.cctv ? window.cctv.world.signs.size : 0,
		particles: window.cctv && window.cctv.particles ? window.cctv.particles.particles.length : 0,
		portals: window.cctv && window.cctv.entities.portals ? window.cctv.entities.portals.endPortal.length / 18 : 0,
		books: window.cctv && window.cctv.entities.books ? window.cctv.entities.books.size : 0,
		boxed: window.cctv && window.cctv.entities.boxed ? [...window.cctv.entities.boxed] : [],
		stats: document.getElementById('stats').textContent,
	}));
	console.log(name + ':', JSON.stringify(info));
	await page.screenshot({ path: name + '.png' });
	// A small JPEG copy goes into the log too, so the result can be inspected without downloading artifacts.
	const jpeg = await page.screenshot({ type: 'jpeg', quality: 55, clip: { x: 0, y: 0, width: 1280, height: 670 } });
	const b64 = jpeg.toString('base64');
	for (let i = 0; i < b64.length; i += 4000) console.log('SHOT:' + name + ':' + b64.slice(i, i + 4000));
	await page.close();
	return info;
}

const vanilla = await shoot('viewer', null);
await shoot('viewer-shaders', { graphics: 'shaders', shaderQuality: 'high' });
await shoot('viewer-far', null, 'far');

const index = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await index.goto('http://127.0.0.1:8100/');
await index.waitForTimeout(2000);
await index.screenshot({ path: 'index.png' });
await browser.close();

if (!vanilla.textures || vanilla.units === 0 || !vanilla.models) {
	console.error('viewer did not render a textured world with entity models');
	process.exit(1);
}
if (pageErrors.length) {
	console.error('viewer script errors:\n' + pageErrors.join('\n'));
	process.exit(1);
}
if (vanilla.portals === 0) {
	console.error('viewer drew no end portal (one is in front of the camera)');
	process.exit(1);
}
if (vanilla.books === 0) {
	console.error('viewer drew no enchanting table book (a table is in front of the camera)');
	process.exit(1);
}
if (vanilla.boxed.length) {
	console.error('entities drawn as plain boxes (model or texture missing): ' + vanilla.boxed.join(', '));
	process.exit(1);
}
if (vanilla.particles === 0) {
	console.error('viewer shows no particles (the campfire in front of the camera smokes)');
	process.exit(1);
}
