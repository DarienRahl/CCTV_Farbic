// Camera list and "video wall" with every camera side by side.

const token = new URLSearchParams(location.search).get('token');
const withToken = (url, sep = '?') => token ? url + sep + 'token=' + encodeURIComponent(token) : url;

const list = document.getElementById('cameras');
const wall = document.getElementById('wall');
const toggle = document.getElementById('toggle-wall');
let cameras = [];
let wallMode = location.hash === '#wall';

function el(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	Object.assign(node, props);
	for (const child of children) node.append(child);
	return node;
}

function renderList() {
	list.replaceChildren();
	if (cameras.length === 0) {
		list.append(el('div', { className: 'empty' }, [
			'Brak kamer. W grze wpisz ',
			el('code', { textContent: '/cctv create <nazwa>' }),
			' – kamera stanie tam, gdzie patrzysz.',
		]));
		return;
	}
	for (const c of cameras) {
		list.append(el('a', { className: 'card', href: withToken('/cam/' + encodeURIComponent(c.name)) }, [
			el('div', { className: 'name', textContent: c.name }),
			el('div', {
				className: 'meta',
				textContent: `${c.dimension.replace('minecraft:', '')} · ${c.x.toFixed(0)} ${c.y.toFixed(0)} ${c.z.toFixed(0)}\n`
					+ `fov ${c.fov.toFixed(0)}° · zasięg ${c.range} · widzów ${c.viewers}`,
				style: 'white-space: pre-line',
			}),
		]));
	}
}

function renderWall() {
	const names = cameras.map(c => c.name);
	const current = [...wall.querySelectorAll('iframe')].map(f => f.dataset.name);
	if (names.join('\n') === current.join('\n')) return;
	wall.replaceChildren();
	wall.style.setProperty('--cols', String(Math.max(1, Math.ceil(Math.sqrt(names.length)))));
	for (const name of names) {
		const frame = el('iframe', {
			src: withToken('/cam/' + encodeURIComponent(name) + '?embed=1', '&'),
			title: name,
			allow: 'fullscreen',
		});
		frame.dataset.name = name;
		wall.append(frame);
	}
}

function render() {
	list.hidden = wallMode;
	wall.hidden = !wallMode;
	toggle.textContent = wallMode ? 'Lista kamer' : 'Ściana monitorów';
	if (wallMode) renderWall();
	else {
		wall.replaceChildren();
		renderList();
	}
}

async function refresh() {
	try {
		const response = await fetch(withToken('/api/cameras'), { credentials: 'same-origin' });
		if (response.ok) {
			cameras = await response.json();
			render();
		}
	} catch {
		// Server restarting - try again on the next tick.
	}
}

toggle.addEventListener('click', () => {
	wallMode = !wallMode;
	history.replaceState(null, '', wallMode ? '#wall' : location.pathname + location.search);
	render();
});

refresh();
setInterval(refresh, 5000);
