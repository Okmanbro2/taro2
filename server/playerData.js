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

// Atomically gives `username` to `uid`, and releases whatever username `uid`
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

module.exports = { getPlayerData, savePlayerData, savePersistedEntityData, claimUsername, UsernameTakenError };
