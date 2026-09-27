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

await page.goto('http://127.0.0.1:8100/');
await page.waitForTimeout(2000);
await page.screenshot({ path: 'index.png' });
await browser.close();

if (!info.textures || info.sections === 0) {
	console.error('viewer did not render textured world');
	process.exit(1);
}
