// Recording a camera in the browser: a video of the picture (with the game's sounds when they are on), or a
// timelapse that keeps one picture every few seconds and turns them into a video at 30 pictures a second when it
// is stopped. Like a CCTV recording, the camera's name, place, date and the game's time are burnt into the corner.
// Nothing is recorded on the server; the browser downloads the file.

const TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
const TIMELAPSE_FPS = 30;
/** Pictures kept for a timelapse at most (two minutes of video); past it every second one is dropped. */
const MAX_FRAMES = 3600;

function videoType() {
	if (typeof MediaRecorder === 'undefined') return null;
	return TYPES.find(type => MediaRecorder.isTypeSupported(type)) || null;
}

function stamp() {
	const d = new Date();
	const p = n => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/**
 * MediaRecorder writes WebM without a duration, so players cannot seek in it: adds the Duration element to the
 * Segment's Info (EBML; the Segment's size is left "unknown" by MediaRecorder, the Info's own size is rewritten).
 */
async function withDuration(blob, ms) {
	if (!blob.type.includes('webm')) return blob;
	const data = new Uint8Array(await blob.arrayBuffer());
	const vint = (pos, keepMarker) => {
		const first = data[pos];
		let length = 1;
		while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
		if (length > 8) return null;
		let value = keepMarker ? first : first & (0xff >> length);
		for (let i = 1; i < length; i++) value = value * 256 + data[pos + i];
		return { length, value };
	};
	const SEGMENT = 0x18538067, INFO = 0x1549a966, DURATION = 0x4489, CLUSTER = 0x1f43b675;
	let pos = 0;
	const header = vint(pos, true), headerSize = vint(pos + header.length);
	pos += header.length + headerSize.length + headerSize.value;
	const segment = vint(pos, true);
	if (!segment || segment.value !== SEGMENT) return blob;
	pos += segment.length + vint(pos + segment.length).length;
	while (pos < data.length) {
		const id = vint(pos, true), size = vint(pos + id.length);
		if (!id || !size || id.value === CLUSTER) return blob;
		const body = pos + id.length + size.length;
		if (id.value === INFO) {
			for (let child = body; child < body + size.value;) {
				const childId = vint(child, true), childSize = vint(child + childId.length);
				if (childId.value === DURATION) return blob;
				child += childId.length + childSize.length + childSize.value;
			}
			const duration = new Uint8Array(11);
			duration.set([0x44, 0x89, 0x88]);
			new DataView(duration.buffer).setFloat64(3, ms);
			const newSize = size.value + duration.length;
			const info = new Uint8Array(4 + 8 + newSize);
			info.set([0x15, 0x49, 0xa9, 0x66, 0x01]);
			for (let i = 0; i < 7; i++) info[5 + i] = Math.floor(newSize / 2 ** (8 * (6 - i))) & 0xff;
			info.set(data.subarray(body, body + size.value), 12);
			info.set(duration, 12 + size.value);
			return new Blob([data.subarray(0, pos), info, data.subarray(body + size.value)], { type: blob.type });
		}
		pos = body + size.value;
	}
	return blob;
}

function download(blob, name) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export class Recorder {
	/**
	 * canvas: the picture; options.audio(): a MediaStream with the game's sounds or null; options.name(): the
	 * camera's name for file names; options.label(): {left: [lines], right: [lines]} burnt into the picture
	 */
	constructor(canvas, options) {
		this.canvas = canvas;
		this.options = options;
		this.type = videoType();
		this.mode = null; // 'video' | 'timelapse' | 'encoding'
		this.started = 0;
		this.frames = [];
		this.encoded = 0;
		this.total = 0;
		this.onchange = () => {};
		this.composed = document.createElement('canvas');
	}

	get supported() {
		return !!this.type && typeof this.composed.captureStream === 'function';
	}

	get extension() {
		return this.type && this.type.startsWith('video/mp4') ? 'mp4' : 'webm';
	}

	/** Seconds since the recording started. */
	elapsed() {
		return this.mode ? (performance.now() - this.started) / 1000 : 0;
	}

	/** The picture with the label, into the recording canvas. */
	compose() {
		const out = this.composed;
		const { width, height } = this.canvas;
		if (out.width !== width || out.height !== height) {
			out.width = width;
			out.height = height;
		}
		const g = out.getContext('2d');
		g.drawImage(this.canvas, 0, 0);
		const label = this.options.label();
		const size = Math.max(12, Math.round(height / 36));
		g.save();
		g.textBaseline = 'top';
		g.shadowColor = 'rgba(0, 0, 0, 0.9)';
		g.shadowBlur = size / 4;
		g.shadowOffsetY = 1;
		const lines = (list, align, x) => {
			g.textAlign = align;
			let y = size * 0.8;
			list.forEach((text, i) => {
				const small = i > 0;
				g.font = `${small ? 500 : 600} ${small ? Math.round(size * 0.8) : size}px ui-monospace, Consolas, monospace`;
				g.fillStyle = small ? 'rgba(255, 255, 255, 0.85)' : '#fff';
				g.fillText(text, x, y);
				y += (small ? size * 0.8 : size) * 1.35;
			});
		};
		lines(label.left || [], 'left', size);
		lines(label.right || [], 'right', width - size);
		g.restore();
		return out;
	}

	startVideo() {
		if (this.mode || !this.supported) return;
		this.compose();
		const stream = this.composed.captureStream(30);
		const sound = this.options.audio();
		if (sound) for (const track of sound.getAudioTracks()) stream.addTrack(track);
		const chunks = [];
		const recorder = new MediaRecorder(stream, { mimeType: this.type, videoBitsPerSecond: 8_000_000 });
		recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
		recorder.onstop = async () => {
			for (const track of stream.getVideoTracks()) track.stop();
			const video = await withDuration(new Blob(chunks, { type: this.type }), performance.now() - this.started);
			download(video, `cctv-${this.options.name()}-${stamp()}.${this.extension}`);
			this.mode = null;
			this.onchange();
		};
		this.recorder = recorder;
		this.mode = 'video';
		this.started = performance.now();
		const frame = () => {
			if (this.mode !== 'video') return;
			this.compose();
			this.raf = requestAnimationFrame(frame);
		};
		frame();
		recorder.start(1000);
		this.onchange();
	}

	/** Keeps a picture every `seconds` until stopped. */
	startTimelapse(seconds) {
		if (this.mode || !this.supported) return;
		this.frames = [];
		this.every = 1;
		this.count = 0;
		this.mode = 'timelapse';
		this.started = performance.now();
		const grab = () => {
			if (this.count++ % this.every !== 0) return;
			this.compose().toBlob(blob => {
				if (!blob || this.mode !== 'timelapse') return;
				this.frames.push(blob);
				if (this.frames.length >= MAX_FRAMES) {
					this.frames = this.frames.filter((_, i) => i % 2 === 0);
					this.every *= 2;
				}
				this.onchange();
			}, 'image/jpeg', 0.92);
		};
		grab();
		this.timer = setInterval(grab, Math.max(0.25, seconds) * 1000);
		this.onchange();
	}

	stop() {
		if (this.mode === 'video') {
			cancelAnimationFrame(this.raf);
			this.recorder.stop();
		} else if (this.mode === 'timelapse') {
			clearInterval(this.timer);
			this.encodeTimelapse();
		}
	}

	/** Plays the kept pictures into a canvas at 30 a second and records that. */
	async encodeTimelapse() {
		const frames = this.frames;
		this.frames = [];
		if (!frames.length) {
			this.mode = null;
			this.onchange();
			return;
		}
		this.mode = 'encoding';
		this.encoded = 0;
		this.total = frames.length;
		this.onchange();
		const first = await createImageBitmap(frames[0]);
		const canvas = document.createElement('canvas');
		canvas.width = first.width;
		canvas.height = first.height;
		const g = canvas.getContext('2d');
		g.drawImage(first, 0, 0);
		first.close();
		const stream = canvas.captureStream(TIMELAPSE_FPS);
		const track = stream.getVideoTracks()[0];
		const chunks = [];
		const recorder = new MediaRecorder(stream, { mimeType: this.type, videoBitsPerSecond: 12_000_000 });
		recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
		const finished = new Promise(resolve => { recorder.onstop = resolve; });
		const wait = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
		recorder.start(1000);
		const recordStart = performance.now();
		// the encoder drops what comes before it is running, and the last picture is held for a moment
		await wait(300);
		const frameMs = 1000 / TIMELAPSE_FPS;
		let next = performance.now();
		for (const blob of frames) {
			const image = await createImageBitmap(blob);
			g.drawImage(image, 0, 0, canvas.width, canvas.height);
			image.close();
			next += frameMs;
			await wait(next - performance.now());
			this.encoded++;
			if (this.encoded % 10 === 0) this.onchange();
		}
		await wait(500);
		recorder.stop();
		await finished;
		track.stop();
		const video = await withDuration(new Blob(chunks, { type: this.type }), performance.now() - recordStart);
		download(video, `cctv-${this.options.name()}-timelapse-${stamp()}.${this.extension}`);
		this.mode = null;
		this.onchange();
	}
}
