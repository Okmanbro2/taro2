// central skin definitions + availability/pricing logic. basically this mirrors badges.js's
// pattern: reads a static JSON data file once at startup and exposes lookup
// functions. assets/data/skins.json IS the client's display copy too (same
// file) - but price/availability/sale status are always resolved here,
// server-side, never trusted from what a client sends, since that's what
// makes buySkin (see playerData.js) safe against a spoofed price

const fs = require('fs');
const path = require('path');

const SKINS_DATA = (() => {
	try {
		const raw = fs.readFileSync(path.join(__dirname, '..', 'assets', 'data', 'skins.json'), 'utf8');
		return JSON.parse(raw);
	} catch (err) {
		console.error('skins.js: failed to load assets/data/skins.json', err);
		return { globalSale: { active: false, discountPercent: 0 }, skins: [] };
	}
})();

const SKINS_BY_ID = SKINS_DATA.skins.reduce((acc, skin) => {
	acc[skin.id] = skin;
	return acc;
}, {});

function getSkinById(skinId) {
	return SKINS_BY_ID[skinId];
}

function getAllSkins() {
	return SKINS_DATA.skins;
}

// true if `date` falls within [from, until] - either bound being null/absent
// means that side is open-ended (no restriction)
function withinWindow(date, from, until) {
	if (from && date < new Date(from)) return false;
	if (until && date > new Date(until)) return false;
	return true;
}

// whether `skin` can be newly PURCHASED right now. Does not affect skins
// already owned - those stay equippable forever regardless of this (see
// equipSkinForUnitType in playerData.js), this only gates new purchases of
// a 'limited' skin outside its availability window.
function isPurchasable(skin, now = new Date()) {
	if (skin.availability === 'limited') {
		return withinWindow(now, skin.availableFrom, skin.availableUntil);
	}
	return true; // 'always'
}

// resolves what a skin actually costs right now - checks the skin's own
// individual sale first (if currently active), then falls back to the
// global sale (unless this skin opts out via excludeFromGlobalSale), then
// the plain listed price. This is the one place price is ever decided -
// buySkin charges exactly this, regardless of what a client's purchase
// request claims the price to be.
function getEffectivePrice(skin, now = new Date()) {
	if (skin.sale && withinWindow(now, skin.sale.start, skin.sale.end)) {
		return skin.sale.price;
	}
	const globalSale = SKINS_DATA.globalSale;
	if (globalSale && globalSale.active && !skin.excludeFromGlobalSale && withinWindow(now, globalSale.start, globalSale.end)) {
		const discount = globalSale.discountPercent || 0;
		return Math.max(0, Math.round(skin.price * (1 - discount / 100)));
	}
	return skin.price;
}

module.exports = { getSkinById, getAllSkins, isPurchasable, getEffectivePrice };
