// chat profanity filter, built on the 'obscenity' npm package
// (https://www.npmjs.com/package/obscenity) - a maintained, actively updated
// profanity dataset, rather than a hand-typed word list either of us would
// have to keep up to date ourselves right

const {
	RegExpMatcher,
	TextCensor,
	englishDataset,
	englishRecommendedTransformers,
	skipNonAlphabeticTransformer,
	asteriskCensorStrategy,
} = require('obscenity');

const matcher = new RegExpMatcher({
	...englishDataset.build(),
	blacklistMatcherTransformers: [...englishRecommendedTransformers.blacklistMatcherTransformers, skipNonAlphabeticTransformer()],
	whitelistMatcherTransformers: englishRecommendedTransformers.whitelistMatcherTransformers,
});

const censor = new TextCensor().setStrategy(asteriskCensorStrategy());

module.exports = {
	// Replaces any matched profanity with asterisks; returns the text
	// unchanged if nothing matched. Safe to call on every chat message.
	clean: function (text) {
		if (typeof text !== 'string' || text.length === 0) {
			return text;
		}
		const matches = matcher.getAllMatches(text);
		return matches.length ? censor.applyTo(text, matches) : text;
	},

	// true/false check, in case something just needs to know whether a
	// message contains profanity without needing the censored text back
	hasProfanity: function (text) {
		if (typeof text !== 'string' || text.length === 0) {
			return false;
		}
		return matcher.hasMatch(text);
	},
};