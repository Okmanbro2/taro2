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

module.exports = { getPlayerData, savePlayerData };
