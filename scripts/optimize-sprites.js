#!/usr/bin/env node

/**
 * One-time pass: losslessly recompresses every PNG in assets/sprites/ in
 * place, without changing a single pixel.
 *
 * This is NOT the same thing as "compressing an image" in the lossy sense
 * (like reducing quality or color palette, the way JPEG or pngquant work).
 * PNG's compression (DEFLATE) has a tunable effort/level, and most images
 * exported quickly from an editor use a low effort setting for speed, not
 * the smallest possible file. Re-encoding at maximum effort produces a
 * byte-for-byte different FILE, but the exact same PIXELS once decoded -
 * same width, height, and every pixel value identical. That's why this is
 * safe to run against sprite sheets: cellSheet.rowCount/columnCount only
 * work correctly because the engine slices frames based on the image's
 * pixel dimensions - since dimensions and pixel data never change here,
 * animations can't be affected.
 *
 * The script proves this for every single file before overwriting it: it
 * decodes both the original and the recompressed version back to raw
 * pixels and compares them directly. If they don't match exactly, that
 * file is left completely untouched and reported as skipped - nothing
 * gets overwritten on a hunch.
 *
 * Usage:
 *   npm install sharp --no-save   (one-time, if not already installed)
 *   node scripts/optimize-sprites.js
 *
 * Safe to run repeatedly - already-optimized files just won't shrink
 * further and get left alone.
 */

const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

const SPRITES_DIR = path.join(__dirname, '..', 'assets', 'sprites');

async function recompressOne(filePath) {
	const originalBuffer = await fs.readFile(filePath);
	const originalSize = originalBuffer.length;

	const originalRaw = await sharp(originalBuffer).raw().toBuffer({ resolveWithObject: true });

	const recompressedBuffer = await sharp(originalBuffer)
		.png({ compressionLevel: 9, effort: 10, palette: false }) // lossless - max deflate effort, no color quantization
		.toBuffer();

	const recompressedRaw = await sharp(recompressedBuffer).raw().toBuffer({ resolveWithObject: true });

	const pixelsIdentical =
		originalRaw.info.width === recompressedRaw.info.width &&
		originalRaw.info.height === recompressedRaw.info.height &&
		originalRaw.info.channels === recompressedRaw.info.channels &&
		Buffer.compare(originalRaw.data, recompressedRaw.data) === 0;

	if (!pixelsIdentical) {
		return { file: filePath, status: 'skipped', reason: 'pixel mismatch after recompression (unexpected - left untouched)' };
	}

	if (recompressedBuffer.length >= originalSize) {
		return { file: filePath, status: 'skipped', reason: 'already optimal - recompression did not shrink it', originalSize };
	}

	await fs.writeFile(filePath, recompressedBuffer);
	return {
		file: filePath,
		status: 'optimized',
		originalSize,
		newSize: recompressedBuffer.length,
		savedBytes: originalSize - recompressedBuffer.length,
	};
}

async function main() {
	const entries = await fs.readdir(SPRITES_DIR);
	const pngFiles = entries.filter((f) => f.toLowerCase().endsWith('.png'));
	const nonPngFiles = entries.filter((f) => !f.toLowerCase().endsWith('.png'));

	console.log(`Found ${pngFiles.length} PNG files in ${SPRITES_DIR}.`);
	if (nonPngFiles.length > 0) {
		console.log(`Skipping ${nonPngFiles.length} non-PNG file(s) (this script only handles PNG for now): ${nonPngFiles.join(', ')}`);
	}

	let totalOriginal = 0;
	let totalNew = 0;
	let optimizedCount = 0;
	let skippedCount = 0;
	const skippedDetails = [];

	for (let i = 0; i < pngFiles.length; i++) {
		const filePath = path.join(SPRITES_DIR, pngFiles[i]);
		const result = await recompressOne(filePath);

		if (result.status === 'optimized') {
			optimizedCount++;
			totalOriginal += result.originalSize;
			totalNew += result.newSize;
			const pct = ((result.savedBytes / result.originalSize) * 100).toFixed(1);
			console.log(`[${i + 1}/${pngFiles.length}] ${pngFiles[i]}: ${result.originalSize} -> ${result.newSize} bytes (-${pct}%)`);
		} else {
			skippedCount++;
			skippedDetails.push({ file: pngFiles[i], reason: result.reason });
			console.log(`[${i + 1}/${pngFiles.length}] ${pngFiles[i]}: skipped (${result.reason})`);
		}
	}

	console.log(`\nDone. Optimized ${optimizedCount}/${pngFiles.length} files, skipped ${skippedCount}.`);
	if (totalOriginal > 0) {
		const totalSavedMB = (totalOriginal - totalNew) / 1024 / 1024;
		const totalPct = (((totalOriginal - totalNew) / totalOriginal) * 100).toFixed(1);
		console.log(`Total size before: ${(totalOriginal / 1024 / 1024).toFixed(2)} MB`);
		console.log(`Total size after:  ${(totalNew / 1024 / 1024).toFixed(2)} MB`);
		console.log(`Saved: ${totalSavedMB.toFixed(2)} MB (${totalPct}%) - off every future page load, not just repeat visits.`);
	}

	if (skippedDetails.some((s) => s.reason.startsWith('pixel mismatch'))) {
		console.log('\nWARNING: at least one file had a pixel mismatch and was left untouched. Review the list above.');
	}
}

main().catch((err) => {
	console.error('Optimization failed:', err);
	process.exit(1);
});
