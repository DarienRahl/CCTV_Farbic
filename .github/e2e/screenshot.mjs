// CI: opens the live viewer of the "ci" camera in headless Chromium and saves screenshots.
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', m => console.log('[browser]', m.type(), m.text()));
page.on('pageerror', e => console.log('[browser] pageerror', e.message));

await page.goto('http://127.0.0.1:8100/cam/ci');
// Wait for block textures (downloaded by the server) and for the world to be meshed.
await page.waitForFunction(() => window.cctv && window.cctv.world.assets && window.cctv.state.ready, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(8000);
const info = await page.evaluate(() => ({
	textures: !!(window.cctv && window.cctv.world.assets),
	sections: window.cctv ? window.cctv.renderer.meshes.size : 0,
	entities: window.cctv ? window.cctv.entities.visibleCount : 0,
	status: document.getElementById('status').textContent,
}));
console.log('viewer:', JSON.stringify(info));
await page.screenshot({ path: 'viewer.png' });
// A small JPEG copy goes into the log too, so the result can be inspected without downloading artifacts.
const jpeg = await page.screenshot({ type: 'jpeg', quality: 60, clip: { x: 0, y: 0, width: 1280, height: 670 } });
const b64 = jpeg.toString('base64');
for (let i = 0; i < b64.length; i += 4000) console.log('SHOT:' + b64.slice(i, i + 4000));

await page.goto('http://127.0.0.1:8100/');
await page.waitForTimeout(2000);
await page.screenshot({ path: 'index.png' });
await browser.close();

if (!info.textures || info.sections === 0) {
	console.error('viewer did not render textured world');
	process.exit(1);
}
