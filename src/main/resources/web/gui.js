// The game's own HUD pieces the viewer shows, drawn the way the client draws them with its GUI sprites and font
// (both from the server's client jar and packs): the Now Playing toast of the background music (NowPlayingToast,
// 26.3) and the "Now Playing" line of a jukebox (Hud.extractOverlayMessage). A 2D canvas over the picture at the
// game's automatic GUI scale (Window.calculateScale).

const SLIDE_MS = 600; // ToastManager.ToastInstance.SLIDE_ANIMATION_DURATION_MS
const TOAST_VISIBLE_MS = 5000; // NowPlayingToast.VISIBILITY_DURATION
const TOAST_HEIGHT = 30;
const TOAST_TEXT_COLOR = 0xd3d3d3; // DyeColor.LIGHT_GRAY.getTextColor()
const NOTE_COLOR_MS = 25; // MUSIC_COLOR_CHANGE_FREQUENCY_MS
const NOTE_COLOR_DURATION = 30; // ColorLerper.Type.MUSIC_NOTE colorDuration

// ColorLerper.MUSIC_NOTE_COLORS as getModifiedColor(dye, 1.25): the dyes' texture colours brightened, white fixed
const NOTE_COLORS = [0xe6e6e6, 0x9d9d97, 0x3ab3da, 0x3c44aa, 0x169c9c, 0x5e7c16, 0x80c71f, 0xfed83d, 0xf9801d, 0xf38baa,
	0xb02e26, 0xc74ebd].map((c, i) => (i === 0 ? c : [16, 8, 0].reduce((out, shift) => out
		| Math.min(255, Math.floor((c >> shift & 255) * 1.25)) << shift, 0)));

/** Mth.lerpInt */
const lerpInt = (t, a, b) => a + Math.floor(t * (b - a));

/** ColorLerper.getLerpedColor(MUSIC_NOTE, tick): ARGB.srgbLerp between one dye colour and the next. */
function noteColor(tick) {
	const value = Math.floor(tick / NOTE_COLOR_DURATION);
	const c1 = NOTE_COLORS[value % NOTE_COLORS.length], c2 = NOTE_COLORS[(value + 1) % NOTE_COLORS.length];
	const t = (tick % NOTE_COLOR_DURATION) / NOTE_COLOR_DURATION;
	return [16, 8, 0].reduce((out, shift) => out | lerpInt(t, c1 >> shift & 255, c2 >> shift & 255) << shift, 0);
}

/** Mth.hsvToArgb */
function hsv(hue, saturation, value) {
	const h = (hue % 1 + 1) % 1;
	const sector = Math.floor(h * 6) % 6, f = h * 6 - Math.floor(h * 6);
	const p = value * (1 - saturation), q = value * (1 - f * saturation), t = value * (1 - (1 - f) * saturation);
	const [r, g, b] = [[value, t, p], [q, value, p], [p, value, t], [p, q, value], [t, p, value], [value, p, q]][sector];
	return (Math.floor(r * 255) << 16) | (Math.floor(g * 255) << 8) | Math.floor(b * 255);
}

const css = (rgb, alpha = 1) => `rgba(${rgb >> 16 & 255}, ${rgb >> 8 & 255}, ${rgb & 255}, ${alpha})`;

export class GuiOverlay {
	/**
	 * canvas: the 2D canvas over the picture; font(): the GameFont once loaded, or null; above: the page's own
	 * label in the top left corner (the camera's name), which the toast goes under instead of covering it
	 */
	constructor(canvas, font, query, above = null) {
		this.canvas = canvas;
		this.above = above;
		this.g = canvas.getContext('2d');
		this.font = font;
		this.query = query;
		this.sprites = {};
		this.toast = null;
		this.overlay = null;
		this.noteTick = 0;
		this.lastNoteChange = 0;
		this.scratch = document.createElement('canvas');
		this.dirty = true;
		for (const [name, path] of [['toast', 'toast/now_playing'], ['notes', 'icon/music_notes']]) this.loadSprite(name, path);
	}

	/** A GUI sprite and its .mcmeta (nine-slice or animation), from GET /assets/gui/{path}.png. */
	async loadSprite(name, path) {
		try {
			const response = await fetch('/assets/gui/' + path + '.png' + this.query, { credentials: 'same-origin' });
			if (!response.ok) return;
			const image = await createImageBitmap(await response.blob());
			let meta = {};
			const metaResponse = await fetch('/assets/gui/' + path + '.png.mcmeta' + this.query, { credentials: 'same-origin' }).catch(() => null);
			if (metaResponse && metaResponse.ok) meta = await metaResponse.json().catch(() => ({}));
			this.sprites[name] = { image, meta };
		} catch {
			// drawn without it
		}
	}

	/** ToastManager.showNowPlayingToast when a song starts; the title is the song's text. */
	showNowPlaying(title) {
		if (!title) {
			this.hideNowPlaying();
			return;
		}
		const now = performance.now();
		const t = this.toast;
		if (t && !t.finished) {
			t.title = title;
			// NowPlayingToast.showToast on a toast still on screen: it stays and counts again
			t.wanted = 'show';
			t.shownAt = now;
			if (t.visibility === 'hide') this.turn(t, 'show', now);
			return;
		}
		this.toast = { title, start: now, visibility: 'show', wanted: 'show', becameVisible: now, shownAt: now, portion: 0, finished: false };
	}

	/** ToastManager.hideNowPlayingToast (the music stopped). */
	hideNowPlaying() {
		const t = this.toast;
		if (!t || t.finished) return;
		t.title = null;
		if (t.visibility === 'show') this.turn(t, 'hide', performance.now());
	}

	/** Hud.setNowPlaying: the jukebox's line above the hotbar, 60 ticks with the animated colour. */
	showOverlay(text) {
		this.overlay = { text, start: performance.now() };
	}

	turn(t, visibility, now) {
		t.start = now - (1 - t.portion) * SLIDE_MS;
		t.visibility = visibility;
	}

	/** Window.calculateScale for automatic GUI scale: as large as keeps 320x240 GUI pixels on screen. */
	guiScale(width, height) {
		let scale = 1;
		while (scale < width && scale < height && width / (scale + 1) >= 320 && height / (scale + 1) >= 240) scale++;
		return scale;
	}

	draw(now) {
		const canvas = this.canvas;
		const dpr = window.devicePixelRatio || 1;
		const width = Math.max(1, Math.round(canvas.clientWidth * dpr)), height = Math.max(1, Math.round(canvas.clientHeight * dpr));
		const active = (this.toast && !this.toast.finished) || this.overlay;
		if (!active) {
			if (this.dirty) {
				this.g.clearRect(0, 0, canvas.width, canvas.height);
				this.dirty = false;
			}
			return;
		}
		if (canvas.width !== width || canvas.height !== height) {
			canvas.width = width;
			canvas.height = height;
		}
		const g = this.g;
		g.setTransform(1, 0, 0, 1, 0, 0);
		g.clearRect(0, 0, width, height);
		this.dirty = true;
		const scale = this.guiScale(width, height);
		g.imageSmoothingEnabled = false;
		g.setTransform(scale, 0, 0, scale, 0, 0);
		const font = this.font();
		if (this.overlay) this.drawOverlay(g, font, now, width / scale, height / scale);
		if (this.toast && !this.toast.finished) this.drawToast(g, font, now, this.topOffset(dpr, scale));
	}

	/** GUI pixels below the page's top left label when it is shown (0 without it, as in the game). */
	topOffset(dpr, scale) {
		const label = this.above;
		if (!label || !label.offsetParent || !label.textContent.trim()) return 0;
		const bottom = label.getBoundingClientRect().bottom - this.canvas.getBoundingClientRect().top;
		return Math.max(0, Math.ceil((bottom + 6) * dpr / scale));
	}

	/** ToastInstance.update + NowPlayingToast: slide in from the left, 5 s fully shown, slide out. */
	drawToast(g, font, now, top) {
		const t = this.toast;
		const progress = Math.min(1, Math.max(0, (now - t.start) / SLIDE_MS)) ** 2;
		t.portion = t.visibility === 'hide' ? 1 - progress : progress;
		if (t.visibility === 'show' && now - t.start <= SLIDE_MS) t.becameVisible = now;
		const visibleFor = now - Math.max(t.becameVisible, t.shownAt);
		t.wanted = t.title && visibleFor < TOAST_VISIBLE_MS ? 'show' : 'hide';
		if (t.wanted !== t.visibility) this.turn(t, t.wanted, now);
		if (t.visibility === 'hide' && now - t.start > SLIDE_MS) {
			t.finished = true;
			return;
		}
		if (!t.title || !font) return;
		// NowPlayingToast.tickMusicNotes
		if (now > this.lastNoteChange + NOTE_COLOR_MS) {
			this.noteTick++;
			this.lastNoteChange = now;
		}
		const textWidth = font.width(t.title);
		const w = 30 + textWidth + 7;
		const x = w * t.portion - w;
		g.save();
		g.translate(x, top);
		this.nineSlice(g, this.sprites.toast, 0, 0, w, TOAST_HEIGHT);
		this.drawNotes(g, 7, 7, noteColor(this.noteTick), now);
		this.text(g, font, t.title, 30, 15 - 4, TOAST_TEXT_COLOR, 1, true);
		g.restore();
	}

	/**
	 * GuiGraphics.blitNineSlicedSprite: the corners as they are, the edges and the middle tiled (or the middle
	 * stretched with stretch_inner), the sprite's own size when it fits exactly.
	 */
	nineSlice(g, sprite, x, y, w, h) {
		if (!sprite) {
			g.fillStyle = 'rgba(33, 33, 33, 0.95)';
			g.fillRect(x, y, w, h);
			return;
		}
		const img = sprite.image;
		const scaling = (sprite.meta.gui && sprite.meta.gui.scaling) || {};
		const sliceW = scaling.width || img.width, sliceH = scaling.height || img.height;
		const b = typeof scaling.border === 'object' ? scaling.border : { left: scaling.border ?? 0, top: scaling.border ?? 0, right: scaling.border ?? 0, bottom: scaling.border ?? 0 };
		// a pack's sprite may have more pixels than the slice's size
		const kx = img.width / sliceW, ky = img.height / sliceH;
		const part = (sx, sy, sw, sh, dx, dy) => {
			if (sw > 0 && sh > 0) g.drawImage(img, sx * kx, sy * ky, sw * kx, sh * ky, dx, dy, sw, sh);
		};
		// blitTiledSprite: tiles of the region over the area, the last ones cut to fit
		const tiled = (dx, dy, dw, dh, sx, sy, tw, th) => {
			if (dw <= 0 || dh <= 0 || tw <= 0 || th <= 0) return;
			for (let ox = 0; ox < dw; ox += tw) {
				for (let oy = 0; oy < dh; oy += th) part(sx, sy, Math.min(tw, dw - ox), Math.min(th, dh - oy), dx + ox, dy + oy);
			}
		};
		const left = Math.min(b.left, Math.floor(w / 2)), right = Math.min(b.right, Math.floor(w / 2));
		const top = Math.min(b.top, Math.floor(h / 2)), bottom = Math.min(b.bottom, Math.floor(h / 2));
		if (w === sliceW && h === sliceH) {
			part(0, 0, w, h, x, y);
			return;
		}
		if (h === sliceH) {
			part(0, 0, left, h, x, y);
			tiled(x + left, y, w - right - left, h, left, 0, sliceW - right - left, sliceH);
			part(sliceW - right, 0, right, h, x + w - right, y);
			return;
		}
		if (w === sliceW) {
			part(0, 0, w, top, x, y);
			tiled(x, y + top, w, h - bottom - top, 0, top, sliceW, sliceH - bottom - top);
			part(0, sliceH - bottom, w, bottom, x, y + h - bottom);
			return;
		}
		const centreW = sliceW - right - left, centreH = sliceH - bottom - top;
		part(0, 0, left, top, x, y);
		part(sliceW - right, 0, right, top, x + w - right, y);
		part(0, sliceH - bottom, left, bottom, x, y + h - bottom);
		part(sliceW - right, sliceH - bottom, right, bottom, x + w - right, y + h - bottom);
		tiled(x + left, y, w - right - left, top, left, 0, centreW, top);
		tiled(x + left, y + h - bottom, w - right - left, bottom, left, sliceH - bottom, centreW, bottom);
		tiled(x, y + top, left, h - bottom - top, 0, top, left, centreH);
		tiled(x + w - right, y + top, right, h - bottom - top, sliceW - right, top, right, centreH);
		if (scaling.stretch_inner) {
			g.drawImage(img, left * kx, top * ky, centreW * kx, centreH * ky, x + left, y + top, w - right - left, h - bottom - top);
		} else {
			tiled(x + left, y + top, w - right - left, h - bottom - top, left, top, centreW, centreH);
		}
	}

	/** icon/music_notes: an animated 16x16 sprite (frametime 2 ticks), tinted with the note colour. */
	drawNotes(g, x, y, color, now) {
		const sprite = this.sprites.notes;
		if (!sprite) return;
		const img = sprite.image;
		const frames = Math.max(1, Math.floor(img.height / img.width));
		const frametime = (sprite.meta.animation && sprite.meta.animation.frametime) || 1;
		const frame = Math.floor(now / 50 / frametime) % frames;
		this.tinted(g, img, 0, frame * img.width, img.width, img.width, x, y, 16, 16, color, 1);
	}

	/** A sprite region multiplied by a colour (the GUI's vertex colour). */
	tinted(g, img, sx, sy, sw, sh, dx, dy, dw, dh, color, alpha) {
		const s = this.scratch;
		if (s.width < sw || s.height < sh) {
			s.width = Math.max(s.width, sw);
			s.height = Math.max(s.height, sh);
		}
		const c = s.getContext('2d');
		c.clearRect(0, 0, s.width, s.height);
		c.globalCompositeOperation = 'source-over';
		c.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
		c.globalCompositeOperation = 'multiply';
		c.fillStyle = css(color);
		c.fillRect(0, 0, sw, sh);
		c.globalCompositeOperation = 'destination-in';
		c.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
		c.globalCompositeOperation = 'source-over';
		g.globalAlpha = alpha;
		g.drawImage(s, 0, 0, sw, sh, dx, dy, dw, dh);
		g.globalAlpha = 1;
	}

	/** Font.drawInBatch with the drop shadow (a quarter of the colour, one pixel down and right). */
	text(g, font, text, x, y, color, alpha, shadow) {
		if (shadow) {
			const dark = ((color >> 16 & 255) >> 2) << 16 | ((color >> 8 & 255) >> 2) << 8 | (color & 255) >> 2;
			this.glyphs(g, font, text, x + 1, y + 1, dark, alpha);
		}
		this.glyphs(g, font, text, x, y, color, alpha);
	}

	glyphs(g, font, text, x, y, color, alpha) {
		let pen = x;
		for (const ch of text) {
			const glyph = font.glyph(ch.codePointAt(0));
			if (glyph.image) {
				this.tinted(g, glyph.image, glyph.sx, glyph.sy, glyph.sw, glyph.sh, pen, y + (glyph.up || 0), glyph.w, glyph.h, color, alpha);
			}
			pen += glyph.advance;
		}
	}

	/** Hud.extractOverlayMessage: centred 68 GUI pixels above the bottom, fading over its last 20 ticks. */
	drawOverlay(g, font, now, guiWidth, guiHeight) {
		const o = this.overlay;
		const time = 60 - (now - o.start) / 50;
		if (time <= 0) {
			this.overlay = null;
			return;
		}
		const alpha = Math.min(255, Math.floor(time * 255 / 20));
		if (alpha <= 8 || !font) return;
		const color = hsv(time / 50, 0.7, 0.6);
		const width = font.width(o.text);
		this.text(g, font, o.text, Math.floor(guiWidth / 2) - Math.floor(width / 2), Math.floor(guiHeight) - 68 - 4, color, alpha / 255, true);
	}
}
