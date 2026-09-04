// firebaseAdmin.js exports the `admin` SDK object itself with `.db` bolted on
// (see module.exports there) - not a { admin, db } object, so we grab both off
// the same import rather than destructuring.
const admin = require('./firebaseAdmin');
const { db } = admin;
const fs = require('fs');
const path = require('path');

// game.json's data.data.attributeTypes is the single source of truth for
// every attribute id's name/min/max in the actual running game - the same
// registry the client reads as taro.game.data.attributeTypes. used for two
// things below: (1) validating anything a player pastes into the modd.io/
// indie.fun import box, since that's the one place in the whole app where
// raw player-supplied JSON gets treated as trusted persisted data, and (2)
// turning cryptic attribute ids (e.g. "KAohfBnN6V") into display names (e.g.
// "Coins") for the discord import log.
let attributeTypesById = {};
try {
	const gameJsonPath = path.join(__dirname, '..', 'src', 'game.json');
	const gameJson = JSON.parse(fs.readFileSync(gameJsonPath, 'utf8'));
	attributeTypesById = (gameJson.data && gameJson.data.attributeTypes) || {};
} catch (err) {
	console.log('playerData: failed to load game.json attribute schema, imports will reject everything and the import log will show raw attribute ids:', err.message);
}

// most attribute maxes in the schema above are editor placeholder defaults
// (e.g. Coins' max is the string "999999999999999999999999") - they exist to
// stop the in-game UI from rendering garbage, not to stop someone from
// pasting {"value": 999999999} into the import box. for attributes where an
// unrealistic value would actually be a competitive/economy advantage, set a
// real ceiling here based on what's actually achievable through normal play.
// anything not listed here just falls back to the schema's own max, which is
// effectively no cap - so add to this list whenever a new ownable/earnable
// stat is added to the game and matters for fairness.
const IMPORT_VALUE_CAPS = {
	KAohfBnN6V: 75000, // Coins
	fKYSjs9Zw4: 100, // Wins
	NbZXJa87MY: 100, // Tacos
	// "*owned?" / "*won?" flags are just 0/1 toggles in the schema already
	// (min:0, max:1), so they don't need an entry here - the schema clamp
	// alone is sufficient for booleans, only numeric currency-like stats
	// need a hand-picked ceiling.
};

// attribute ids that should never come back through an import, because
// they're intentionally session-only and get overwritten every time a
// player joins regardless (see the "player joins" script's stage-based Sun
// reset) - importing a stale Sun value would just get stomped anyway, so we
// drop it here rather than let it sit in Firestore looking meaningful.
const NON_PERSISTENT_ATTRIBUTE_IDS = new Set([
	'dXSTbWLa7y', // Sun
]);

// separate webhook from the join/leave one in game.json (that one's driven
// by the game engine's own script system and can't reach this code - imports
// happen through the account panel's HTTP API, outside any running game
// session).
const DISCORD_IMPORT_WEBHOOK_URL = process.env.DISCORD_IMPORT_WEBHOOK_URL;

async function postDiscordWebhook(content) {
	if (!DISCORD_IMPORT_WEBHOOK_URL) {
		return;
	}
	try {
		await fetch(DISCORD_IMPORT_WEBHOOK_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content }),
		});
	} catch (err) {
		// never let a webhook hiccup fail the actual import
		console.log('discord import webhook failed:', err.message);
	}
}

// builds the style lines for the import log, comparing
// what was already saved against what's about to be written - AFTER
// sanitization/clamping, so the log always reflects the real applied values,
// not whatever the player's raw pasted JSON claimed. only attributes whose
// value actually changed are included. discord caps message length at 2000
// chars, so this stops adding lines (with a "+N more" note) well before that
// becomes a problem on an export with a lot of attributes.
function formatAttributeChanges(existingAttributes, incomingAttributes) {
	const lines = [];
	let omitted = 0;

	for (const attrId in incomingAttributes) {
		const previousValue = existingAttributes[attrId] && existingAttributes[attrId].value;
		const newValue = incomingAttributes[attrId] && incomingAttributes[attrId].value;

		if (previousValue === newValue) {
			continue;
		}

		const name = (attributeTypesById[attrId] && attributeTypesById[attrId].name) || attrId;
		const line = `${name}: ${previousValue === undefined ? '—' : previousValue} => ${newValue}`;

		if (lines.length < 20) {
			lines.push(line);
		} else {
			omitted++;
		}
	}

	if (omitted > 0) {
		lines.push(`+${omitted} more`);
	}

	return lines;
}

async function getPlayerData(uid) {
	const doc = await db.collection('players').doc(uid).get();
	if (!doc.exists) {
		return null;
	}
	return doc.data();
}

async function savePlayerData(uid, data) {
	await db.collection('players').doc(uid).set(data, { merge: true });
}

// saves persisted player/unit game-state (attributes, variables, quests - the
// stuff ActionComponent's 'savePlayerData' script action builds via
// entity.getPersistentData()) under players/{uid}.data.player / .data.unit,
// without touching sibling top-level fields like username or coins.
//
// this does not use `savePlayerData(uid, { 'data.player': player })` above -
// that looks like dot-path notation but isn't. Firestore only expands dots
// into nested paths for explicit field paths (update(), or set(..., {
// mergeFields })). When merge:true computes its own mask from a plain
// object's keys, it takes each top-level key literally - db.collection(...)
// .set({ 'data.player': x }, { merge: true }) creates one real field
// literally named "data.player" (dot and all), not a nested `data.player`
// path. Reads that expect persistedData.data.player (see Player.js's
// loadPersistentData) then find persistedData.data is undefined and silently
// skip loading - which is exactly why saved data never came back.
//
// passing real FieldPath objects as `mergeFields` is what actually replaces
// the nested data.player / data.unit maps wholesale on each save, which is
// what we want here since getPersistentData() already returns a complete,
// self-contained snapshot each time - not a partial diff to deep-merge.
async function savePersistedEntityData(uid, { player, unit } = {}) {
	const data = { data: {} };
	const mergeFields = [];

	if (player !== undefined) {
		data.data.player = player;
		mergeFields.push(new admin.firestore.FieldPath('data', 'player'));
	}
	if (unit !== undefined) {
		data.data.unit = unit;
		mergeFields.push(new admin.firestore.FieldPath('data', 'unit'));
	}
	if (mergeFields.length === 0) {
		return;
	}

	await db.collection('players').doc(uid).set(data, { mergeFields });
}

// thrown by claimUsername() when someone else already holds that username -
// server.js catches this specifically to send back a 409 instead of a 500.
class UsernameTakenError extends Error {
	constructor(username) {
		super(`Username "${username}" is already taken.`);
		this.name = 'UsernameTakenError';
	}
}

// atomically gives `username` to `uid`, and releases whatever username `uid`
// previously held (if any). The `usernames` collection is a "claim table" -
// its document IDs (lowercased usernames) are what actually enforce
// uniqueness, since Firestore guarantees two documents can never share an ID.
// Wrapping the read + write in a transaction is what makes this race-proof:
// if two people try to claim the same username at once, Firestore serializes
// the two transactions so only one of them can see the doc as still free.
async function claimUsername(uid, username) {
	const usernameKey = username.toLowerCase();
	const usernameRef = db.collection('usernames').doc(usernameKey);
	const playerRef = db.collection('players').doc(uid);

	await db.runTransaction(async (tx) => {
		// Firestore transactions require ALL reads to happen before ANY writes -
		// that's why both gets are up here, before the tx.set/tx.delete calls below.
		const [usernameDoc, playerDoc] = await Promise.all([tx.get(usernameRef), tx.get(playerRef)]);

		if (usernameDoc.exists && usernameDoc.data().uid !== uid) {
			throw new UsernameTakenError(username);
		}

		// if this player already had a different username, free it up so someone
		// else can take it - otherwise every rename would leak a permanently
		// reserved username behind them
		const oldUsername = playerDoc.exists ? playerDoc.data().username : null;
		if (oldUsername && oldUsername.toLowerCase() !== usernameKey) {
			tx.delete(db.collection('usernames').doc(oldUsername.toLowerCase()));
		}

		tx.set(usernameRef, { uid, username });
		tx.set(playerRef, { username }, { merge: true });
	});
}

// looks up a player's uid from their claimed username (the `usernames`
// collection - see claimUsername above). Used by the admin import helper,
// where an admin targets a player by username rather than a raw Firebase uid.
async function getUidByUsername(username) {
	const doc = await db.collection('usernames').doc(username.toLowerCase()).get();
	return doc.exists ? doc.data().uid : null;
}

// snapshots whatever's currently saved for uid into
// players/{uid}/backups/{timestamp} before a destructive operation (modd
// import, wipe) touches it, so a mistake is always recoverable and nothing
// is ever silently thrown away. Returns the backup doc's id.
async function backupPlayerData(uid, reason) {
	const current = await getPlayerData(uid);
	const backupId = String(Date.now());
	await db
		.collection('players')
		.doc(uid)
		.collection('backups')
		.doc(backupId)
		.set({ reason, snapshotOf: current || null, backedUpAt: Date.now() });
	return backupId;
}

// converts a raw modd.io/indie.fun "Platform Data" export (the JSON a player
// gets from that game's "View Save Data" button on their own account page)
// into the { attributes, variables } shape this engine already reads/writes
// under players/{uid}.data.player - see getPersistentData/loadPersistentData
// in engine/core/TaroEntity.js. Only the `.player` block is migrated - the
// `.unit` block (health, speed, inventory) is intentionally dropped, since
// that's session state that isn't meant to be persisted long-term anyway.
//
// IMPORTANT: this is the one place in the app where a player's own raw JSON
// gets treated as trusted persisted data, so it can't just be passed
// through. Two separate problems get fixed here, not one:
//
// 1. obviously, someone could just hand-edit "value" to whatever they want.
// 2. less obviously: loadPersistentData() in TaroEntity.js applies whatever
//    "min"/"max" the saved data claims BEFORE clamping "value" to that same
//    min/max - so a pasted {"min":0,"max":999999999,"value":999999999}
//    would sail straight through that clamp too, since the clamp is being
//    checked against attacker-supplied bounds. rebuilding min/max here from
//    the game's own trusted schema (instead of copying whatever the pasted
//    JSON claims) closes that off regardless of what the export contains.
function transformModdPlayerExport(moddExport) {
	if (!moddExport || typeof moddExport !== 'object' || !moddExport.player) {
		throw new Error("That doesn't look like a modd.io/indie.fun save export - expected a top-level \"player\" key.");
	}

	const incomingAttributes = moddExport.player.attributes || {};
	const attributes = {};
	const skipped = [];

	for (const attrId in incomingAttributes) {
		const schema = attributeTypesById[attrId];

		if (!schema) {
			// not a real attribute in this game - either a typo, a leftover
			// from an older version of the game, or someone hand-crafting
			// JSON. either way, there's nothing to validate it against, so
			// it's dropped rather than trusted.
			skipped.push({ attrId, reason: 'unknown attribute' });
			continue;
		}

		if (NON_PERSISTENT_ATTRIBUTE_IDS.has(attrId)) {
			continue; // silently dropped, not a rejection - this is expected
		}

		const rawValue = incomingAttributes[attrId] && incomingAttributes[attrId].value;
		const numericValue = typeof rawValue === 'number' ? rawValue : parseFloat(rawValue);

		if (!Number.isFinite(numericValue)) {
			skipped.push({ attrId, reason: 'non-numeric value' });
			continue;
		}

		// schema min/max always win - never the pasted data's own min/max.
		// schema max is sometimes a string (e.g. Coins' "999999999999999999999999")
		// since the editor stores it as free text, so this always runs it
		// through Number() rather than trusting its type.
		const schemaMin = Number(schema.min) || 0;
		const schemaMax = Number(schema.max);
		const cap = IMPORT_VALUE_CAPS[attrId];
		const effectiveMax = cap !== undefined ? Math.min(cap, schemaMax) : schemaMax;

		const clampedValue = Math.max(schemaMin, Math.min(numericValue, effectiveMax));

		attributes[attrId] = {
			name: schema.name,
			min: schemaMin,
			max: schemaMax,
			regenerateSpeed: schema.regenerateSpeed || 0,
			value: clampedValue,
		};

		if (clampedValue !== numericValue) {
			skipped.push({ attrId, reason: `value ${numericValue} clamped to ${clampedValue}` });
		}
	}

	return {
		attributes,
		variables: moddExport.player.variables || {},
		skipped,
	};
}

// imports a modd.io/indie.fun export into uid's Firestore player data.
// per-key (attribute id / variable name), the modd.io value wins over
// whatever's already saved - but only after backupPlayerData() snapshots the
// pre-import state, so nothing is ever unrecoverably lost. Blocked from
// running a second time on the same account unless `force` is set (used by
// the admin import helper to redo an import for someone who ran into
// trouble - see /api/admin-import-modd-data in server.js).
async function importModdData(uid, moddExport, { force = false } = {}) {
	const current = await getPlayerData(uid);
	if (current && current.moddImportedAt && !force) {
		const err = new Error('This account has already imported its modd.io/indie.fun data.');
		err.code = 'ALREADY_IMPORTED';
		throw err;
	}

	const incoming = transformModdPlayerExport(moddExport);
	const existingPlayer = (current && current.data && current.data.player) || {};

	const mergedPlayer = {
		attributes: { ...(existingPlayer.attributes || {}), ...incoming.attributes },
		variables: { ...(existingPlayer.variables || {}), ...incoming.variables },
		quests: existingPlayer.quests,
	};

	const backupId = await backupPlayerData(uid, force ? 'admin-modd-import' : 'modd-import');
	await savePersistedEntityData(uid, { player: mergedPlayer });
	await db.collection('players').doc(uid).set({ moddImportedAt: Date.now() }, { merge: true });

	const changeLines = formatAttributeChanges(existingPlayer.attributes || {}, incoming.attributes);
	const username = (current && current.username) || uid;
	if (changeLines.length > 0) {
		const suffix = force ? ' (admin-triggered)' : '';
		await postDiscordWebhook(`**${username}** imported data to their account${suffix}. Changed values:\n${changeLines.join('\n')}`);
	} else {
		await postDiscordWebhook(`**${username}** imported data to their account, but no attribute values changed.`);
	}

	return { backupId, skipped: incoming.skipped };
}

// resets uid's saved progress to a blank slate - backs the old data up first
// (same safety net as importModdData) and clears moddImportedAt, so the
// account is free to run the modd.io import again afterward if the player
// wants to.
async function wipePlayerData(uid) {
	const backupId = await backupPlayerData(uid, 'wipe');
	await savePersistedEntityData(uid, { player: { attributes: {}, variables: {}, quests: undefined } });
	await db
		.collection('players')
		.doc(uid)
		.set({ moddImportedAt: admin.firestore.FieldValue.delete() }, { merge: true });
	return { backupId };
}

module.exports = {
	getPlayerData,
	savePlayerData,
	savePersistedEntityData,
	claimUsername,
	UsernameTakenError,
	getUidByUsername,
	backupPlayerData,
	importModdData,
	wipePlayerData,
};
