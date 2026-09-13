#!/usr/bin/env node

/**
 * One-time follow-up migration: copies every remaining external sound URL
 * anywhere in src/game.json into assets/audio/, then rewrites those URLs to
 * point at the local copies instead.
 *
 * This is intentionally broader than migrate-sounds.js. The first migration
 * handled the centralized data.sound library; this script handles the other
 * cache.modd.io/asset/sound URLs embedded elsewhere in game.json, including
 * item/projectile effects and music entries.
 *
 * Sound bytes are copied exactly as downloaded - no transcoding, re-encoding,
 * normalization, or format conversion.
 *
 * Only URLs that download successfully are replaced. Failed URLs remain
 * untouched. A timestamped backup of game.json is created before any rewrite.
 * Existing local files are never silently overwritten if they contain
 * different bytes; a short URL-hash suffix is used for a conflicting name.
 *
 * Usage:
 *   node scripts/migrate-remaining-sounds.js
 *
 * What it does, in order:
 *   1. Reads and parses src/game.json.
 *   2. Finds every remaining https://cache.modd.io/asset/sound/... URL
 *      anywhere in the parsed game data and deduplicates them.
 *   3. Downloads each sound as raw bytes into assets/audio/.
 *   4. Reuses an existing local file when its bytes are identical; otherwise
 *      uses a hash-suffixed filename rather than overwriting it.
 *   5. Creates a timestamped backup of game.json before rewriting anything.
 *   6. Rewrites every occurrence of each successfully migrated external URL
 *      to /assets/audio/<filename> using plain string replacement, preserving
 *      the existing formatting of the rest of the 12 MB JSON file.
 *   7. Leaves failed URLs untouched and writes a failure report if needed.
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const GAME_JSON_PATH = path.join(__dirname, '..', 'src', 'game.json');
const AUDIO_DIR = path.join(__dirname, '..', 'assets', 'audio');
const LOCAL_URL_PREFIX = '/assets/audio/';

const MAX_CONCURRENT_DOWNLOADS = 8;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const EXTERNAL_SOUND_PREFIX = 'https://cache.modd.io/asset/sound/';

function collectRemainingSoundUrls(gameData) {
	const urls = new Set();

	function walk(node) {
		if (typeof node === 'string') {
			if (node.startsWith(EXTERNAL_SOUND_PREFIX)) urls.add(node);
			return;
		}

		if (Array.isArray(node)) {
			node.forEach(walk);
			return;
		}

		if (node && typeof node === 'object') {
			Object.values(node).forEach(walk);
		}
	}

	walk(gameData);
	return [...urls];
}

function localFilenameForUrl(url) {
	const parsed = new URL(url);
	let filename = decodeURIComponent(path.basename(parsed.pathname));

	if (!filename || filename === '.' || filename === '..') {
		filename = `sound-${crypto.createHash('sha1').update(url).digest('hex').slice(0, 12)}.bin`;
	}

	return filename;
}

function hashSuffix(url) {
	return crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);
}

async function fetchBytes(url) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`);
		}

		const buffer = Buffer.from(await res.arrayBuffer());
		if (buffer.length === 0) {
			throw new Error('empty response body');
		}

		return buffer;
	} finally {
		clearTimeout(timeout);
	}
}

async function chooseDestination(url, downloaded) {
	const base = localFilenameForUrl(url);
	const basePath = path.join(AUDIO_DIR, base);

	try {
		const existing = await fs.readFile(basePath);
		if (Buffer.compare(existing, downloaded) === 0) {
			return {
				filename: base,
				destPath: basePath,
				alreadySame: true,
				bytes: existing.length,
			};
		}
	} catch (err) {
		if (err.code !== 'ENOENT') throw err;

		return {
			filename: base,
			destPath: basePath,
			alreadySame: false,
		};
	}

	const ext = path.extname(base);
	const stem = ext ? base.slice(0, -ext.length) : base;
	const filename = `${stem}-${hashSuffix(url)}${ext}`;
	const destPath = path.join(AUDIO_DIR, filename);

	try {
		const existing = await fs.readFile(destPath);
		if (Buffer.compare(existing, downloaded) === 0) {
			return {
				filename,
				destPath,
				alreadySame: true,
				bytes: existing.length,
			};
		}

		throw new Error(`destination collision: ${filename} already exists with different bytes`);
	} catch (err) {
		if (err.code === 'ENOENT') {
			return {
				filename,
				destPath,
				alreadySame: false,
			};
		}

		throw err;
	}
}

async function downloadOne(url) {
	try {
		const buffer = await fetchBytes(url);
		const destination = await chooseDestination(url, buffer);

		if (!destination.alreadySame) {
			await fs.writeFile(destination.destPath, buffer);
		}

		return {
			url,
			filename: destination.filename,
			ok: true,
			bytes: buffer.length,
			alreadyPresent: destination.alreadySame,
		};
	} catch (err) {
		return {
			url,
			filename: localFilenameForUrl(url),
			ok: false,
			reason: err.message,
		};
	}
}

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

	const urls = collectRemainingSoundUrls(gameData);
	console.log(`Found ${urls.length} remaining external sound URLs.`);

	if (urls.length === 0) {
		console.log('No remaining external cache.modd.io sound URLs found. Nothing to migrate.');
		return;
	}

	await fs.mkdir(AUDIO_DIR, { recursive: true });

	console.log(`Downloading into ${AUDIO_DIR} (concurrency: ${MAX_CONCURRENT_DOWNLOADS})...`);
	let completed = 0;
	const results = await mapWithConcurrency(urls, MAX_CONCURRENT_DOWNLOADS, async (url) => {
		const result = await downloadOne(url);
		completed++;
		const status = result.ok
			? result.alreadyPresent
				? `already present (${result.bytes} bytes)`
				: `ok (${result.bytes} bytes)`
			: `FAILED - ${result.reason}`;
		console.log(`[${completed}/${urls.length}] ${result.filename}: ${status}`);
		return result;
	});

	const succeeded = results.filter((r) => r.ok);
	const failed = results.filter((r) => !r.ok);

	console.log(`\nMigrated ${succeeded.length}/${urls.length} remaining external sound URLs successfully.`);

	if (failed.length > 0) {
		console.log(`${failed.length} FAILED (left untouched in game.json):`);
		for (const f of failed) {
			console.log(`  - ${f.url}  (${f.reason})`);
		}
	}

	// Back up the current, already-partially-migrated game.json before rewriting
	// the remaining external URLs.
	const backupPath = GAME_JSON_PATH.replace(/\.json$/, `.pre-remaining-sound-migration-${Date.now()}.json`);
	await fs.copyFile(GAME_JSON_PATH, backupPath);
	console.log(`\nBacked up current game.json to ${backupPath}`);

	// Plain string replacement preserves the existing formatting/order of the
	// large JSON file instead of re-serializing it.
	console.log('Rewriting remaining sound URLs in game.json...');
	let updatedText = gameJsonText;

	for (const r of succeeded) {
		const localUrl = LOCAL_URL_PREFIX + r.filename;
		updatedText = updatedText.split(r.url).join(localUrl);
	}

	await fs.writeFile(GAME_JSON_PATH, updatedText, 'utf8');
	console.log(`Done. game.json now has migrated remaining sound URLs under ${LOCAL_URL_PREFIX}`);

	if (failed.length > 0) {
		const reportPath = path.join(__dirname, 'remaining-sound-migration-failures.json');
		await fs.writeFile(reportPath, JSON.stringify(failed, null, 2), 'utf8');
		console.log(`Failure report written to ${reportPath}`);
	}
}

main().catch((err) => {
	console.error('Migration failed:', err);
	process.exit(1);
});
