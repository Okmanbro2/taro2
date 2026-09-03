const { db } = require('./firebaseAdmin');

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

// Thrown by claimUsername() when someone else already holds that username -
// server.js catches this specifically to send back a 409 instead of a 500.
class UsernameTakenError extends Error {
	constructor(username) {
		super(`Username "${username}" is already taken.`);
		this.name = 'UsernameTakenError';
	}
}

// unique
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

module.exports = { getPlayerData, savePlayerData, claimUsername, UsernameTakenError };
