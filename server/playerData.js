// firebaseAdmin.js exports the `admin` SDK object itself with `.db` bolted on
// (see module.exports there) - not a { admin, db } object, so we grab both off
// the same import rather than destructuring.
const admin = require('./firebaseAdmin');
const { db } = admin;

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

// Thrown by claimUsername() when someone else already holds that username -
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
function transformModdPlayerExport(moddExport) {
	if (!moddExport || typeof moddExport !== 'object' || !moddExport.player) {
		throw new Error("That doesn't look like a modd.io/indie.fun save export - expected a top-level \"player\" key.");
	}
	return {
		attributes: moddExport.player.attributes || {},
		variables: moddExport.player.variables || {},
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

	return { backupId };
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
