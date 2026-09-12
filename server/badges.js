// award badges

// attribute ids pulled from game.json's attributeTypes
const ATTR = {
	WINS: 'fKYSjs9Zw4',
	COINS: 'KAohfBnN6V',
};

// plant owned ids
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
// shape as playerDoc.data.player.attributes) and returns true once earned
// `rewardCoins`, if present, is added to the player's Coins attribute
// exactly once, the moment the badge is granted
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

// returns { badges: <updated badges map>, newlyAwarded: [ids], coinsEarned }
// - never mutates the input, call this every time you have a fresh
// attributes snapshot for a player (see savePersistedEntityData below)
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

module.exports = { BADGE_DEFS, checkAndAwardBadges };
