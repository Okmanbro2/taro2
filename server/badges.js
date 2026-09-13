// Central badge definitions + the logic that decides whether a player has
// newly earned any of them. Mirrors assets/data/badges.json (the client's
// display copy) but adds the actual "how do you earn this" check and any
// reward payout, which is intentionally server-only.
//
// SCOPE NOTE: only the 5 badges that are checkable against data we already
// persist are wired up here (win-badge, win2-badge, win3-badge, coin-badge,
// dave-badge). zm-badge and zm-win-badge are deferred until Zombie Mode has
// its own tracked flags - add them to BADGE_DEFS the same way once that
// exists. Gems isn't implemented as a currency yet, so no badge here awards
// Gems; only the two badges whose rewards include Coins (win2/win3) apply a
// reward, and only the Coins portion.

const fs = require('fs');
const path = require('path');

// Same display copy (name/description/icon/reward) the client shows in the
// badges modal, read once at startup so the live achievement-toast push has
// everything it needs without the client having to fetch/guess it.
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

// Attribute ids pulled from game.json's attributeTypes (see playerData.js's
// own comment on why these are hardcoded rather than looked up by name).
const ATTR = {
	WINS: 'fKYSjs9Zw4',
	COINS: 'KAohfBnN6V',
};

// Every "<plant>Owned?" boolean player attribute in the game - these get set
// to 1 the moment a player buys that plant/upgrade from one of Crazy Dave's
// shops. dave-badge just needs ANY of them to be 1, so no new purchase-
// tracking flag is needed - we reuse what's already being saved.
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

// Each badge's `check` receives the player's live attribute map (the same
// shape as playerDoc.data.player.attributes) and returns true once earned.
// `rewardCoins`, if present, is added to the player's Coins attribute
// exactly once, the moment the badge is granted.
const BADGE_DEFS = {
	'win-badge': {
		check: (attrs) => (attrValue(attrs, ATTR.WINS) || 0) >= 1,
	},
	'win2-badge': {
		check: (attrs) => (attrValue(attrs, ATTR.WINS) || 0) >= 20,
		rewardCoins: 5000,
	},
	'win3-badge': {
		check: (attrs) => (attrValue(attrs, ATTR.WINS) || 0) >= 100,
		rewardCoins: 10000,
	},
	'dave-badge': {
		check: (attrs) => OWNED_FLAG_IDS.some((id) => !!attrValue(attrs, id)),
	},
	'coin-badge': {
		check: (attrs) => (attrValue(attrs, ATTR.COINS) || 0) >= 100000,
	},
};

// Returns { badges: <updated badges map>, newlyAwarded: [ids], coinsEarned }
// - never mutates the input. Call this every time you have a fresh
// attributes snapshot for a player (see savePersistedEntityData below).
function checkAndAwardBadges(existingBadges, attributes) {
	const badges = Object.assign({}, existingBadges);
	const newlyAwarded = [];
	let coinsEarned = 0;

	for (const [badgeId, def] of Object.entries(BADGE_DEFS)) {
		if (badges[badgeId]) continue; // already have it, never re-grant
		if (def.check(attributes)) {
			badges[badgeId] = { obtainedAt: Date.now() };
			newlyAwarded.push(badgeId);
			coinsEarned += def.rewardCoins || 0;
		}
	}

	return { badges, newlyAwarded, coinsEarned };
}

module.exports = { BADGE_DEFS, checkAndAwardBadges, getBadgeDisplayInfo };