#!/usr/bin/env node

/**
 * One-time migration: copies every cache.modd.io image referenced in
 * src/game.json down into assets/sprites/, then rewrites game.json to
 * point at the local copies instead.
 *
 * Deliberately does NOT touch image bytes in any way - no resizing, no
 * re-encoding, no format conversion. Sprite sheets (cellSheet.rowCount /
 * cellSheet.columnCount) only slice correctly because the engine computes
 * each frame's size from the image's exact pixel dimensions at load time;
 * changing so much as one pixel of width/height would silently misalign
 * every animation that uses that sheet. So this script is a pure byte-for-
 * byte copy, and it never touches rowCount/columnCount/frames anywhere in
 * game.json - only the `url` strings themselves get replaced.
 *
 * Usage:
 *   node scripts/migrate-images.js
 *
 * Run this from a machine with normal internet access (your own laptop,
 * or a Render shell) - it needs to reach cache.modd.io.
 *
 * What it does, in order:
 *   1. Scans game.json for every image URL (same URLs the game currently
 *      loads sprites from).
 *   2. Downloads each one as raw bytes into assets/sprites/.
 *   3. Rewrites every occurrence of each successfully-downloaded URL in
 *      game.json to its new local path (/sprites/<filename>).
 *   4. Leaves any URL that failed to download completely untouched in
 *      game.json, and lists it in the failure report at the end - those
 *      need a manual re-upload, since there's nothing left to copy.
 *   5. Writes a timestamped backup of the original game.json before
 *      touching anything.
 */

const fs = require('fs/promises');
const path = require('path');

const GAME_JSON_PATH = path.join(__dirname, '..', 'src', 'game.json');
const SPRITES_DIR = path.join(__dirname, '..', 'assets', 'sprites');
const LOCAL_URL_PREFIX = '/sprites/';

// matches the same shape of URL we found when auditing image usage -
// https://cache.modd.io/asset/spriteImage/<file>.<ext>, and .svg/.gif/.webp
// too in case any of those slipped in elsewhere in the game
const IMAGE_URL_PATTERN = /https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg)/gi;
const FULL_STRING_IMAGE_URL_PATTERN = /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg)$/i;

const MAX_CONCURRENT_DOWNLOADS = 8;
const DOWNLOAD_TIMEOUT_MS = 20_000;

function extractImageUrls(gameJsonText) {
	const matches = gameJsonText.match(IMAGE_URL_PATTERN) || [];
	// dedupe - the same sprite is very often reused across multiple
	// units/items, and we only need to download it once
	return [...new Set(matches)];
}

// Walks the parsed game data and builds url -> [{category, key, name}, ...],
// so that if a download fails, the failure report can say exactly which
// entity (e.g. "itemTypes.3mtd2T1lhL (Fire Effect)") needs a manual
// re-upload, instead of leaving you to search a 12MB file for it yourself.
// Covers every top-level collection keyed by entity id (unitTypes, itemTypes,
// projectileTypes, tilesets, dialogues, etc). A handful of single-object
// sections (map, settings, ui, particleTypes) aren't collections of named
// entities the same way, so URLs found there are reported without a `name` -
// there were only a few of these in this game, easy to eyeball directly.
function buildUrlLocationIndex(gameData) {
	const index = new Map();

	function record(url, category, key, name) {
		if (!index.has(url)) index.set(url, []);
		index.get(url).push({ category, key, name });
	}

	function walk(node, category, key, name) {
		if (typeof node === 'string') {
			if (FULL_STRING_IMAGE_URL_PATTERN.test(node)) record(node, category, key, name);
			return;
		}
		if (Array.isArray(node)) {
			node.forEach((item) => walk(item, category, key, name));
			return;
		}
		if (node && typeof node === 'object') {
			for (const value of Object.values(node)) walk(value, category, key, name);
		}
	}

	for (const [category, collection] of Object.entries(gameData.data)) {
		if (collection && typeof collection === 'object' && !Array.isArray(collection)) {
			for (const [key, entity] of Object.entries(collection)) {
				const name = entity && typeof entity === 'object' ? entity.name : undefined;
				walk(entity, category, key, name);
			}
		}
	}

	return index;
}

function localFilenameForUrl(url) {
	const urlPath = new URL(url).pathname;
	// decodeURIComponent handles any %20-style encoding; modd.io filenames
	// don't tend to have literal '+' decoded to space in the path portion
	// (that's a query-string-only convention), so this is safe as-is
	return decodeURIComponent(path.basename(urlPath));
}

async function downloadOne(url) {
	const filename = localFilenameForUrl(url);
	const destPath = path.join(SPRITES_DIR, filename);

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) {
			return { url, filename, ok: false, reason: `HTTP ${res.status}` };
		}
		const buffer = Buffer.from(await res.arrayBuffer());
		if (buffer.length === 0) {
			return { url, filename, ok: false, reason: 'empty response body' };
		}
		await fs.writeFile(destPath, buffer);
		return { url, filename, ok: true, bytes: buffer.length };
	} catch (err) {
		return { url, filename, ok: false, reason: err.message };
	} finally {
		clearTimeout(timeout);
	}
}

// simple concurrency-limited map, so we're not opening 800+ sockets at once
async function mapWithConcurrency(items, limit, fn) {
	const results = new Array(items.length);
	let nextIndex = 0;

	async function worker() {
		while (nextIndex < items.length) {
			const current = nextIndex++;
			results[current] = await fn(items[current], current);
		}
	}

	const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
	await Promise.all(workers);
	return results;
}

async function main() {
	console.log('Reading game.json...');
	const gameJsonText = await fs.readFile(GAME_JSON_PATH, 'utf8');
	const gameData = JSON.parse(gameJsonText);

	const urls = extractImageUrls(gameJsonText);
	console.log(`Found ${urls.length} unique image URLs.`);

	console.log('Indexing which entity each URL belongs to (for the failure report)...');
	const urlLocationIndex = buildUrlLocationIndex(gameData);

	await fs.mkdir(SPRITES_DIR, { recursive: true });

	console.log(`Downloading into ${SPRITES_DIR} (concurrency: ${MAX_CONCURRENT_DOWNLOADS})...`);
	let completed = 0;
	const results = await mapWithConcurrency(urls, MAX_CONCURRENT_DOWNLOADS, async (url) => {
		const result = await downloadOne(url);
		completed++;
		const status = result.ok ? `ok (${result.bytes} bytes)` : `FAILED - ${result.reason}`;
		console.log(`[${completed}/${urls.length}] ${result.filename}: ${status}`);
		return result;
	});

	const succeeded = results.filter((r) => r.ok);
	const failed = results.filter((r) => !r.ok);

	console.log(`\nDownloaded ${succeeded.length}/${urls.length} images successfully.`);
	if (failed.length > 0) {
		console.log(`${failed.length} FAILED (left untouched in game.json - these need manual re-upload):`);
		for (const f of failed) {
			const usedBy = urlLocationIndex.get(f.url) || [];
			f.usedBy = usedBy;
			const usedByText =
				usedBy.length > 0
					? usedBy.map((u) => `${u.category}.${u.key}${u.name ? ` (${u.name})` : ''}`).join(', ')
					: '(not found in a named entity - check map/settings/ui/particleTypes directly)';
			console.log(`  - ${f.url}  (${f.reason})`);
			console.log(`      used by: ${usedByText}`);
		}
	}

	// back up the original before rewriting anything
	const backupPath = GAME_JSON_PATH.replace(/\.json$/, `.pre-migration-${Date.now()}.json`);
	await fs.copyFile(GAME_JSON_PATH, backupPath);
	console.log(`\nBacked up original game.json to ${backupPath}`);

	// plain string replacement, not JSON.parse/stringify - avoids any risk
	// of re-serialization subtly reformatting the other 12MB of the file
	console.log('Rewriting URLs in game.json...');
	let updatedText = gameJsonText;
	for (const r of succeeded) {
		const localUrl = LOCAL_URL_PREFIX + r.filename;
		updatedText = updatedText.split(r.url).join(localUrl);
	}

	await fs.writeFile(GAME_JSON_PATH, updatedText, 'utf8');
	console.log(`\nDone. game.json now points ${succeeded.length} images at ${LOCAL_URL_PREFIX}`);

	if (failed.length > 0) {
		const reportPath = path.join(__dirname, 'migration-failures.json');
		await fs.writeFile(reportPath, JSON.stringify(failed, null, 2), 'utf8');
		console.log(`Failure report written to ${reportPath} - re-upload these manually, then re-run this script.`);
	}
}

main().catch((err) => {
	console.error('Migration failed:', err);
	process.exit(1);
});
