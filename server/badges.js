// Central badge definitions + the logic that decides whether a player has
// newly earned any of them. Mirrors assets/data/badges.json (the client's
// display copy) but adds the actual "how do you earn this" check and any
// reward payout, which is intentionally server-only.
//
// SCOPE NOTE: only the 5 badges that are checkable against data we already
// persist are wired up here (win-badge, win2-badge, win3-badge, coin-badge,
// dave-badge). zm-badge and zm-win-badge are deferred until Zombie Mode has
// its own tracked flags - add them to BADGE_DEFS the same way once that
// exists. Gems is a top-level `gems` field on the player's Firestore doc
// (see playerData.js), not an in-game attribute - same pattern as `badges`
// itself, since it's an account-level currency rather than something the
// live game simulation needs to read.

const fs = require('fs');
const path = require('path');

// same display copy
const BADGE_DISPLAY_BY_ID = (() => {
	try {
		const raw = fs.readFileSync(
			path.join(__dirname, '..', 'assets', 'data', 'badges.json'),
			'utf8'
		);
		const parsed = JSON.parse(raw);
		return (parsed.badges || []).reduce((acc, badge) => {
			acc[badge.id] = badge;
			return acc;
		}, {});
	} catch (err) {
		console.error('badges.js: failed to load assets/data/badges.json', err);
		return {};
	}
})();

function getBadgeDisplayInfo(badgeId) {
	return BADGE_DISPLAY_BY_ID[badgeId];
}

// attribute ids
const ATTR = {
	WINS: 'fKYSjs9Zw4',
	COINS: 'KAohfBnN6V',
};

// every "<plant>Owned?" boolean player attribute in the game
const OWNED_FLAG_IDS = [
	'uqtQLGEAGX', // gatlingOwned
	'6FrKxX6Ygo', // twinOwned
	'fsrhxCzzqD', // catOwned
	'JBknp1V5aL', // melonOwned
	'C44OGCREy5', // cobOwned
	'aauepP1xHO', // gloomOwned
	'tBPNYeOFAS', // laserOwned
	'8gkUs7TVc5', // superChompOwned
	'Owx5FrfwnP', // electroOwned
	'TbyWpHp58y', // fireOwned?
	'7OE6e1Qlat', // goldmagnetOwned
	'avftaCtZLb', // magnetOwned
	'zO3WiVUa11', // imitaterOwned
	'87egOJ5hse', // spikerockOwned
	'1exjfklDVt', // podOwned?
	'dtsojqdxHt', // peanutOwned?
	'DmNvoAw11g', // reedOwned?
	'SavKmfObPs', // explodnutOwned?
];

function attrValue(attributes, attrId) {
	return attributes && attributes[attrId] && attributes[attrId].value;
}

// each badge's `check` receives the player's live attribute map (the same
// shape as playerDoc.data.player.attributes) and returns true once earned.
// `rewardCoins`, if present, is added to the player's Coins attribute
// exactly once, the moment the badge is granted.
const BADGE_DEFS = {
	'win-badge': {
		check: (attrs) => (attrValue(attrs, ATTR.WINS) || 0) >= 1,
		rewardGems: 25,
	},
	'win2-badge': {
		check: (attrs) => (attrValue(attrs, ATTR.WINS) || 0) >= 20,
		rewardCoins: 5000,
		rewardGems: 75,
	},
	'win3-badge': {
		check: (attrs) => (attrValue(attrs, ATTR.WINS) || 0) >= 100,
		rewardCoins: 10000,
		rewardGems: 500,
	},
	'dave-badge': {
		check: (attrs) => OWNED_FLAG_IDS.some((id) => !!attrValue(attrs, id)),
		rewardGems: 30,
	},
	'coin-badge': {
		check: (attrs) => (attrValue(attrs, ATTR.COINS) || 0) >= 100000,
		rewardGems: 100,
	},
	// zm-badge (50 Gems) / zm-win-badge (100 Gems) per badges.json
};

// returns { badges: <updated badges map>, newlyAwarded: [ids], coinsEarned, gemsEarned }
// - never mutates the input. Call this every time you have a fresh
// attributes snapshot for a player (see savePersistedEntityData below).
function checkAndAwardBadges(existingBadges, attributes) {
	const badges = Object.assign({}, existingBadges);
	const newlyAwarded = [];
	let coinsEarned = 0;
	let gemsEarned = 0;

	for (const [badgeId, def] of Object.entries(BADGE_DEFS)) {
		if (badges[badgeId]) continue; // already have it, never re-grant
		if (def.check(attributes)) {
			// gemsPaid marks that this badge's Gems reward (if any) has already
			// been accounted for - checked by the one-time backfill script
			// (server/scripts/backfillGems.js) so it never double-pays a badge
			// that was earned normally after Gems already existed.
			badges[badgeId] = { obtainedAt: Date.now(), gemsPaid: true };
			newlyAwarded.push(badgeId);
			coinsEarned += def.rewardCoins || 0;
			gemsEarned += def.rewardGems || 0;
		}
	}

	return { badges, newlyAwarded, coinsEarned, gemsEarned };
}

module.exports = { BADGE_DEFS, checkAndAwardBadges, getBadgeDisplayInfo };
