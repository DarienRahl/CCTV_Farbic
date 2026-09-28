// Web Worker that builds section meshes (see mesher.js) off the page's main thread.

import { Mesher, describeState, CARDINAL } from './mesher.js';
import { BlockModels, parseProps } from './models.js';
import { blockFaceColors } from './blocks.js';

const mesher = new Mesher();
const entries = [];

function describe(entry) {
	mesher.infos[entry.id] = describeState(entry, parseProps, blockFaceColors);
}

self.onmessage = event => {
	const message = event.data;
	switch (message.type) {
		case 'assets':
			mesher.models = new BlockModels(message.blockstates, message.models, new Map(message.sprites), message.missing);
			mesher.fluids = message.fluids;
			mesher.colormaps = message.colormaps || {};
			// Models changed: resolve them again for every known state.
			for (const entry of entries) describe(entry);
			break;
		case 'palette':
			for (const entry of message.entries) {
				entries.push(entry);
				describe(entry);
			}
			break;
		case 'config':
			if (message.biomeNames) mesher.biomeNames = message.biomeNames;
			if (message.biomeDefs) mesher.biomeDefs = message.biomeDefs;
			if (message.cardinal) mesher.cardinal = CARDINAL[message.cardinal] || CARDINAL.default;
			if (message.zoomSeed !== undefined) mesher.zoomSeed = BigInt(message.zoomSeed);
			if (message.smooth !== undefined) mesher.smooth = message.smooth;
			if (message.blockEntities) mesher.handledBlockEntities = new Set(message.blockEntities);
			mesher.fiddles = null;
			break;
		case 'mesh': {
			let result;
			try {
				result = mesher.mesh(message.job);
			} catch (error) {
				self.postMessage({ type: 'error', id: message.id, key: message.key, error: String(error && error.stack || error) });
				return;
			}
			self.postMessage({ type: 'mesh', id: message.id, key: message.key, version: message.version, ...result },
				[result.opaque, result.translucent]);
			break;
		}
		default:
			break;
	}
};
