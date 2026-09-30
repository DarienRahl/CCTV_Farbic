// The game's item model definitions (assets/*/items/*.json, ItemModel in 26.x): which models an item stack is
// drawn with and the tints of their layers. The definitions come from client.jar and the resource packs, so new
// items and new properties of later versions are drawn without changes here as long as they use the same model
// types; properties the viewer cannot know (a player's cooldowns, the selected hotbar slot...) take the value an
// idle item has.

const ns = id => (id.includes(':') ? id : 'minecraft:' + id);
const strip = id => String(id || '').replace(/^minecraft:/, '');

/** ARGB int or [r, g, b] floats (ExtraCodecs.RGB_COLOR_CODEC) -> [r, g, b] 0..1 */
function rgb(value, fallback = [1, 1, 1]) {
	if (Array.isArray(value)) return [value[0] ?? 1, value[1] ?? 1, value[2] ?? 1];
	if (typeof value === 'number') return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
	return fallback;
}

/**
 * props: what the server read from the stack (EntityEncoder.writeItemProperties): c dye, p potion, f firework,
 * m map colour, t trim material, ch charge type, cmd custom model data {f, b, s, c}, d damage 0..1, b broken.
 * ctx: {context: ItemDisplayContext name, dimension, entityType, dayTime, using, useTicks, cast}
 */
export class ItemDefinitions {
	constructor(definitions, colormap) {
		this.definitions = definitions || {};
		this.colormap = colormap;
	}

	has(id) {
		return !!this.definitions[ns(id)];
	}

	/** The models to draw ({model, tints: [[r, g, b]...]} or {special}), in order, or null without a definition. */
	resolve(id, props = {}, ctx = {}) {
		const root = this.definitions[ns(id)];
		if (!root) return null;
		const out = [];
		this.walk(root, props || {}, ctx, out, 0);
		return out;
	}

	walk(node, p, ctx, out, depth) {
		if (!node || typeof node !== 'object' || depth > 24) return;
		switch (strip(node.type)) {
			case 'model':
				if (node.model) out.push({ model: ns(node.model), tints: (node.tints || []).map(t => this.tint(t, p, ctx)) });
				break;
			case 'composite':
				for (const child of node.models || []) this.walk(child, p, ctx, out, depth + 1);
				break;
			case 'condition':
				this.walk(this.condition(node, p, ctx) ? node.on_true : node.on_false, p, ctx, out, depth + 1);
				break;
			case 'select': {
				const value = this.select(node, p, ctx);
				const hit = (node.cases || []).find(c => (Array.isArray(c.when) ? c.when : [c.when]).some(w => same(w, value)));
				this.walk(hit ? hit.model : node.fallback, p, ctx, out, depth + 1);
				break;
			}
			case 'range_dispatch': {
				// RangeSelectItemModel: the last entry whose threshold is not above the value
				const value = this.range(node, p, ctx) * (node.scale ?? 1);
				let pick = null;
				const entries = [...(node.entries || [])].sort((a, b) => a.threshold - b.threshold);
				for (const entry of entries) if (value >= entry.threshold) pick = entry.model;
				this.walk(pick || node.fallback, p, ctx, out, depth + 1);
				break;
			}
			case 'special':
				out.push({ special: node });
				break;
			default:
				// empty, bundle/selected_item: nothing to draw
				break;
		}
	}

	/** ConditionalItemModelProperty */
	condition(node, p, ctx) {
		const cmd = p.cmd || {};
		switch (strip(node.property)) {
			case 'using_item': return !!ctx.using;
			case 'broken': return !!p.b;
			case 'damaged': return (p.d || 0) > 0;
			case 'fishing_rod/cast': return !!ctx.cast;
			case 'custom_model_data': return !!(cmd.b || [])[node.index || 0];
			case 'view_entity': return false;
			default: return false;
		}
	}

	/** SelectItemModelProperty */
	select(node, p, ctx) {
		const cmd = p.cmd || {};
		switch (strip(node.property)) {
			case 'display_context': return ctx.context || 'none';
			case 'charge_type': return p.ch || 'none';
			case 'trim_material': return p.t || null;
			case 'main_hand': return 'right';
			case 'context_dimension': return ctx.dimension || null;
			case 'context_entity_type': return ctx.entityType || null;
			case 'custom_model_data': return (cmd.s || [])[node.index || 0] ?? null;
			case 'block_state': return (p.bs || {})[node.block_state_property] ?? null;
			case 'local_time': return localTime(node.pattern, node.time_zone);
			default: return null;
		}
	}

	/** RangeSelectItemModelProperty */
	range(node, p, ctx) {
		const cmd = p.cmd || {};
		switch (strip(node.property)) {
			case 'damage': return node.normalize === false ? (p.d || 0) : Math.min(1, Math.max(0, p.d || 0));
			case 'use_duration': return ctx.using ? (ctx.useTicks || 0) : 0;
			case 'custom_model_data': return (cmd.f || [])[node.index || 0] ?? 0;
			case 'time': {
				// Time.DAYTIME: the sun's position as a 0..1 turn (ClockItem), MOON_PHASE: the phase / 8
				const source = strip(node.source || 'daytime');
				if (source === 'moon_phase') return ((Math.floor((ctx.dayTime || 0) / 24000) % 8) + 8) % 8 / 8;
				if (source === 'random') return Math.random();
				const t = ((ctx.dayTime || 0) % 24000) / 24000;
				const f = ((t - 0.25) % 1 + 1) % 1;
				const angle = 0.5 - Math.cos(f * Math.PI) / 2;
				return (f * 2 + angle) / 3;
			}
			case 'compass':
				return 0;
			default:
				return 0;
		}
	}

	/** ItemTintSource */
	tint(t, p, ctx) {
		const cmd = p.cmd || {};
		switch (strip(t.type)) {
			case 'constant': return rgb(t.value);
			case 'dye': return rgb(p.c ?? t.default);
			case 'potion': return rgb(p.p ?? t.default);
			case 'firework': return rgb(p.f ?? t.default);
			case 'map_color': return rgb(p.m ?? t.default);
			case 'team': return rgb(t.default);
			case 'custom_model_data': return rgb((cmd.c || [])[t.index || 0] ?? t.default);
			case 'grass': {
				const c = this.colormap ? this.colormap('grass', t.temperature ?? 0.5, t.downfall ?? 1, 0x7cbd6b) : 0x7cbd6b;
				return rgb(c);
			}
			default: return [1, 1, 1];
		}
	}
}

/**
 * LocalTime: the viewer's clock (the game's is its player's) in a date pattern such as "MM-dd" (the Christmas
 * chest), in the given time zone when there is one. Letters of the common fields, padded to their count.
 */
function localTime(pattern, timeZone) {
	if (typeof pattern !== 'string') return null;
	const now = new Date();
	let parts = null;
	try {
		const format = new Intl.DateTimeFormat('en-US', {
			timeZone: timeZone || undefined, hourCycle: 'h23',
			year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
		});
		parts = Object.fromEntries(format.formatToParts(now).map(part => [part.type, part.value]));
	} catch {
		parts = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), hour: now.getHours(), minute: now.getMinutes(), second: now.getSeconds() };
	}
	const fields = { y: parts.year, M: parts.month, d: parts.day, H: parts.hour, m: parts.minute, s: parts.second };
	return pattern.replace(/'([^']*)'|([yMdHms])\2*/g, (match, quoted, letter) => {
		if (quoted !== undefined) return quoted;
		const value = String(Number(fields[letter]));
		return letter === 'y' && match.length === 2 ? value.slice(-2) : value.padStart(match.length, '0');
	});
}

/** A "when" of a select case against the property's value (ids with or without "minecraft:"). */
function same(when, value) {
	if (value === null || value === undefined) return false;
	if (typeof when === 'string' && typeof value === 'string') return ns(when) === ns(value) || when === value;
	return when === value;
}
