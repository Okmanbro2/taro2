// One-time backfill: grants Gems for badges players already earned BEFORE
// Gems existed as a currency. Every badge in badges.json has always declared
// a Gems reward, but the server never paid it out until Gems got a real
// `gems` field on the player doc - this script settles up existing accounts
// so they get what those badges always should have given them.
//
// SAFE TO RE-RUN: each badge entry gets marked `gemsPaid: true` once its
// reward has been accounted for (either through this script, or through the
// normal award path in badges.js's checkAndAwardBadges - see that file).
// This script only ever adds up badges that are missing that marker, so
// running it again later - e.g. after a new badge like zm-badge gets wired
// up in BADGE_DEFS - will correctly backfill just the newly-added badge for
// everyone who already has it, without re-paying anything already settled.
//
// USAGE (run from the repo root):
//   node server/scripts/backfillGems.js              -> dry run, no writes
//   node server/scripts/backfillGems.js --apply       -> actually writes
//
// Always run the dry run first and read through the output before --apply.
// This touches real player currency data across every account in Firestore.

const admin = require('../firebaseAdmin');
const { db } = admin;
const { BADGE_DEFS } = require('../badges');

const APPLY = process.argv.includes('--apply');

async function main() {
	console.log(APPLY ? '=== APPLYING gem backfill (writes will happen) ===' : '=== DRY RUN (no writes - pass --apply to actually write) ===');

	const snapshot = await db.collection('players').get();
	console.log(`Scanning ${snapshot.size} player documents...\n`);

	let playersAffected = 0;
	let totalGemsGranted = 0;
	let batch = db.batch();
	let batchCount = 0;

	for (const doc of snapshot.docs) {
		const data = doc.data();
		const badges = data.badges || {};
		const existingGems = data.gems || 0;

		let owedGems = 0;
		const badgeIdsToMark = [];

		for (const [badgeId, badgeEntry] of Object.entries(badges)) {
			if (!badgeEntry || badgeEntry.gemsPaid === true) continue; // already settled
			const def = BADGE_DEFS[badgeId];
			if (!def) continue; // badge not in BADGE_DEFS (e.g. zm-badge, not wired up yet) - skip, can't verify or pay it
			owedGems += def.rewardGems || 0;
			badgeIdsToMark.push(badgeId);
		}

		if (owedGems === 0 && badgeIdsToMark.length === 0) continue; // nothing to do for this player

		playersAffected++;
		totalGemsGranted += owedGems;

		console.log(
			`${data.username || doc.id}: +${owedGems} gems (badges: ${badgeIdsToMark.join(', ') || 'none new'}), ` +
				`${existingGems} -> ${existingGems + owedGems}`
		);

		if (APPLY) {
			const updatedBadges = { ...badges };
			for (const badgeId of badgeIdsToMark) {
				updatedBadges[badgeId] = { ...updatedBadges[badgeId], gemsPaid: true };
			}
			batch.set(doc.ref, { gems: existingGems + owedGems, badges: updatedBadges }, { merge: true });
			batchCount++;

			// Firestore batches cap at 500 writes - flush and start a new one if we're close
			if (batchCount >= 450) {
				await batch.commit();
				batch = db.batch();
				batchCount = 0;
			}
		}
	}

	if (APPLY && batchCount > 0) {
		await batch.commit();
	}

	console.log(`\n${playersAffected} player(s) affected, ${totalGemsGranted} total gems ${APPLY ? 'granted' : 'would be granted'}.`);
	if (!APPLY) {
		console.log('This was a dry run - nothing was written. Re-run with --apply once this looks right.');
	}
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error('backfillGems failed:', err);
		process.exit(1);
	});
