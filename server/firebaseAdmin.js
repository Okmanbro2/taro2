const admin = require('firebase-admin');

if (!admin.apps.length) {
	admin.initializeApp({
		credential: admin.credential.cert({
			projectId: process.env.FIREBASE_PROJECT_ID,
			clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
			// Render stores this as a literal "\n"-escaped single line —
			// convert it back into real newlines here, since that's what
			// the actual PEM key format requires to parse correctly
			privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
		}),
	});
}

module.exports = admin;
db.settings({ ignoreUndefinedProperties: true });
// module.exports = admin;
module.exports.db = db;
