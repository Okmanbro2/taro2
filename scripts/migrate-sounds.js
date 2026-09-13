#!/usr/bin/env node

/**
 * One-time migration: copies every external sound file referenced by
 * src/game.json's data.sound library into assets/audio/, then rewrites
 * game.json to point at the local copies instead.
 *
 * Sound bytes are copied exactly as downloaded - no transcoding, re-encoding,
 * normalization, or format conversion. The engine only needs the resulting
 * file URL, and preserving the original bytes avoids changing playback
 * characteristics or file compatibility.
 *
 * The script only rewrites URLs for sounds that were downloaded successfully.
 * Failed downloads are left completely untouched and listed in a failure
 * report. A timestamped backup of game.json is created before any rewrite.
 *
 * Usage:
 *   node scripts/migrate-sounds.js
 *
 * Run this from a machine with normal internet access. The script needs to
 * reach the external sound URLs currently stored in game.json.
 *
 * What it does, in order:
 *   1. Reads and parses src/game.json.
 *   2. Collects every non-empty data.sound.*.file URL and deduplicates them.
 *   3. Downloads each sound as raw bytes into assets/audio/.
 *   4. Refuses to overwrite an existing different file with the same name;
 *      conflicting names get a short URL-hash suffix instead.
 *   5. Rewrites every occurrence of each successfully-downloaded URL in
 *      game.json to /audio/<filename>.
 *   6. Leaves failed URLs untouched and reports exactly which sound entry
 *      referenced each failed URL.
 *   7. Creates a timestamped backup of the original game.json first.
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const GAME_JSON_PATH = path.join(__dirname, '..', 'src', 'game.json');
const AUDIO_DIR = path.join(__dirname, '..', 'assets', 'audio');
const LOCAL_URL_PREFIX = '/audio/';

const MAX_CONCURRENT_DOWNLOADS = 8;
const DOWNLOAD_TIMEOUT_MS = 20_000;

const AUDIO_EXTENSIONS = new Set([
	'.ogg',
	'.mp3',
	'.wav',
	'.m4a',
	'.aac',
	'.opus',
	'.flac',
]);

function collectSoundUrls(gameData) {
	const sounds = gameData?.data?.sound;
	const entries = sounds && typeof sounds === 'object' && !Array.isArray(sounds)
		? Object.entries(sounds)
		: [];

	const results = [];
	const seen = new Set();

	for (const [key, sound] of entries) {
		const file = sound && typeof sound.file === 'string' ? sound.file.trim() : '';
		if (!file || !/^https?:\/\//i.test(file)) continue;

		if (!seen.has(file)) {
			seen.add(file);
			results.push({ url: file, keys: [key] });
		} else {
			const existing = results.find((r) => r.url === file);
			if (existing) existing.keys.push(key);
		}
	}

	return results;
}

function localFilenameForUrl(url) {
	const parsed = new URL(url);
	let filename = decodeURIComponent(path.basename(parsed.pathname));

	// Some hosts do not provide an ordinary audio extension. Preserve the
	// remote name, but add .bin rather than inventing an audio format.
	if (!filename || filename === '.' || filename === '..') {
		filename = `sound-${crypto.createHash('sha1').update(url).digest('hex').slice(0, 12)}.bin`;
	}

	return filename;
}

function hashSuffix(url) {
	return crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);
}

async function chooseDestination(url) {
	const base = localFilenameForUrl(url);
	const basePath = path.join(AUDIO_DIR, base);

	let existing;
	try {
		existing = await fs.readFile(basePath);
	} catch (err) {
		if (err.code === 'ENOENT') return { filename: base, destPath: basePath, exists: false };
		throw err;
	}

	// If the same bytes are already present, reuse the existing file.
	// The caller still treats this as a successful local copy.
	const downloaded = await fetchBytes(url);
	if (Buffer.compare(existing, downloaded) === 0) {
		return { filename: base, destPath: basePath, exists: true, alreadySame: true, bytes: existing.length };
	}

	// Same basename but different content: never overwrite silently.
	const ext = path.extname(base);
	const stem = ext ? base.slice(0, -ext.length) : base;
	const filename = `${stem}-${hashSuffix(url)}${ext}`;
	const destPath = path.join(AUDIO_DIR, filename);

	try {
		const conflictExisting = await fs.readFile(destPath);
		if (Buffer.compare(conflictExisting, downloaded) === 0) {
			return { filename, destPath, exists: true, alreadySame: true, bytes: conflictExisting.length };
		}
		throw new Error(`destination collision: ${filename} already exists with different bytes`);
	} catch (err) {
		if (err.code === 'ENOENT') {
			return { filename, destPath, exists: false, downloaded };
		}
		throw err;
	}
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

async function downloadOne(sound) {
	const { url } = sound;

	try {
		const parsed = new URL(url);
		const ext = path.extname(parsed.pathname).toLowerCase();
		if (ext && !AUDIO_EXTENSIONS.has(ext)) {
			// Do not block migration solely because a host uses an unexpected
			// extension. We still download the exact file bytes.
		}

		const destination = await chooseDestination(url);

		if (destination.alreadySame) {
			return {
				url,
				filename: destination.filename,
				ok: true,
				bytes: destination.bytes,
				alreadyPresent: true,
			};
		}

		const buffer = destination.downloaded || await fetchBytes(url);
		await fs.writeFile(destination.destPath, buffer);

		return {
			url,
			filename: destination.filename,
			ok: true,
			bytes: buffer.length,
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

function buildUrlLocationIndex(gameData) {
	const index = new Map();
	const soundEntries = gameData?.data?.sound;

	if (soundEntries && typeof soundEntries === 'object' && !Array.isArray(soundEntries)) {
		for (const [key, sound] of Object.entries(soundEntries)) {
			const file = sound && typeof sound.file === 'string' ? sound.file.trim() : '';
			if (!file) continue;

			if (!index.has(file)) index.set(file, []);
			index.get(file).push({
				key,
				name: sound && typeof sound.name === 'string' ? sound.name : undefined,
			});
		}
	}

	return index;
}

async function main() {
	console.log('Reading game.json...');
	const gameJsonText = await fs.readFile(GAME_JSON_PATH, 'utf8');
	const gameData = JSON.parse(gameJsonText);

	const sounds = collectSoundUrls(gameData);
	console.log(`Found ${sounds.length} unique external sound URLs.`);

	if (sounds.length === 0) {
		console.log('No external sound URLs found in data.sound. Nothing to migrate.');
		return;
	}

	const urlLocationIndex = buildUrlLocationIndex(gameData);
	await fs.mkdir(AUDIO_DIR, { recursive: true });

	console.log(`Downloading into ${AUDIO_DIR} (concurrency: ${MAX_CONCURRENT_DOWNLOADS})...`);
	let completed = 0;
	const results = await mapWithConcurrency(sounds, MAX_CONCURRENT_DOWNLOADS, async (sound) => {
		const result = await downloadOne(sound);
		completed++;
		const status = result.ok
			? result.alreadyPresent
				? `already present (${result.bytes} bytes)`
				: `ok (${result.bytes} bytes)`
			: `FAILED - ${result.reason}`;
		console.log(`[${completed}/${sounds.length}] ${result.filename}: ${status}`);
		return result;
	});

	const succeeded = results.filter((r) => r.ok);
	const failed = results.filter((r) => !r.ok);

	console.log(`\nAvailable locally: ${succeeded.length}/${sounds.length} sounds.`);

	if (failed.length > 0) {
		console.log(`${failed.length} FAILED (left untouched in game.json - these need manual attention):`);
		for (const f of failed) {
			const usedBy = urlLocationIndex.get(f.url) || [];
			const usedByText = usedBy.length > 0
				? usedBy.map((u) => `data.sound.${u.key}${u.name ? ` (${u.name})` : ''}`).join(', ')
				: '(sound entry not found)';
			console.log(`  - ${f.url}  (${f.reason})`);
			console.log(`      used by: ${usedByText}`);
		}
	}

	// Back up the original before rewriting anything.
	const backupPath = GAME_JSON_PATH.replace(/\.json$/, `.pre-sound-migration-${Date.now()}.json`);
	await fs.copyFile(GAME_JSON_PATH, backupPath);
	console.log(`\nBacked up original game.json to ${backupPath}`);

	// Plain string replacement, not JSON.parse/stringify. This preserves the
	// existing 12MB file's formatting and changes only successful URL strings.
	console.log('Rewriting sound URLs in game.json...');
	let updatedText = gameJsonText;
	for (const r of succeeded) {
		const localUrl = LOCAL_URL_PREFIX + r.filename;
		updatedText = updatedText.split(r.url).join(localUrl);
	}

	await fs.writeFile(GAME_JSON_PATH, updatedText, 'utf8');
	console.log(`Done. game.json now points ${succeeded.length} sound URLs at ${LOCAL_URL_PREFIX}`);

	if (failed.length > 0) {
		const reportPath = path.join(__dirname, 'sound-migration-failures.json');
		await fs.writeFile(reportPath, JSON.stringify(failed, null, 2), 'utf8');
		console.log(`Failure report written to ${reportPath}`);
	}
}

main().catch((err) => {
	console.error('Sound migration failed:', err);
	process.exit(1);
});
