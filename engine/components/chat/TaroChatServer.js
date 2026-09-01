/**
 * The server-side chat component. Handles all server-side
 * chat methods and events.
 */
var TaroChatServer = {
	/**
	 * Creates a new room with the specified room name and options.
	 * @param roomName The display name of the room.
	 * @param options An object containing options key/values.
	 * @param {String=} roomId If specified, becomes the new room's ID.
	 * @return {String} The new room's ID.
	 */
	createRoom: function (roomName, options, roomId) {
		var self = taro.chat;
		var newRoomId = roomId || taro.newIdHex();

		self._rooms[roomId] = {
			id: newRoomId,
			name: roomName,
			options: options,
			users: [],
		};

		// Inform all users that the room was created
		taro.network.send('taroChatRoomCreated', roomId);

		return roomId;
	},

	/**
	 * Removes an existing room with the specified id.
	 * @param roomId
	 * @return {Boolean}
	 */
	removeRoom: function (roomId) {
		var self = taro.chat;

		if (self._rooms[roomId]) {
			// Inform all users that the room was removed
			taro.network.send('taroChatRoomRemoved', roomId);

			delete self._rooms[roomId];
			return true;
		} else {
			return false;
		}
	},

	/**
	 * Sends a message to a room.
	 * @param {String} roomId The ID of the room to send the message to.
	 * @param {String} message The text body of the message to send.
	 * @param {String=} to The id of the user to send the message to.
	 * @param {String} from The id of the user that sent the message.
	 */
	sendToRoom: function (roomId, message, to, from, additionalOpts = {}) {
		console.log('[CHAT DEBUG] sendToRoom called. roomId:', roomId, 'message:', message, 'from:', from, 'global.isDev:', global.isDev);

		if (!to && !from) {
			taro.devLog('sending chatt message inside sendChatRoom', message);
		}

		taro.devLog(`chat - sendToRoom: ${message}`);

		var self = taro.chat;
		var sender = taro.game.getPlayerByClientId(from);
		var gameData = taro.game.data && taro.game.data.defaultData;
		var msg = {
			roomId: roomId,
			text: message,
			from: from,
			to: to,
			bmToAll: additionalOpts?.isBroadcastMessageToAllGames,
		};

		// send the system message (from the action 'sendChatMessage')
		if (sender == undefined) {
			console.log('[CHAT DEBUG] sender is undefined for clientId', from, '- sending as system message');
			taro.network.send('taroChatMsg', msg, to);
			return;
		} else if (sender && sender._stats) {
			console.log('[CHAT DEBUG] sender found. banChat:', sender._stats.banChat, 'userId:', sender._stats.userId);
			// prevent sending messages from banned/unverified users
			if (!global.isDev && (sender._stats.banChat || !sender._stats.userId)) {
				console.log('[CHAT DEBUG] DROPPED: sender is banned or missing userId, and global.isDev is falsy');
				return;
			} else if (this.isSpamming(from, message)) {
				// mute spammers
				sender._stats.banChat = true;
				(msg.text = 'You have been muted for spamming.'), taro.network.send('taroChatMsg', msg);
				taro.workerComponent?.banChat({
					gameId: gameData._id,
					userId: sender._stats.userId,
				});
				return;
			} else if (/(https?:\/\/[^\s]+)/g.test(message)) {
				return;
			}

			taro.game.lastChatMessageSentByPlayer = message;
			taro.queueTrigger('playerSendsChatMessage', {
				playerId: sender.id(),
			});
		}

		// do not show command messages that start with '/'. e.g. /ban user
		if (message != undefined && message[0] == '/') {
			return;
		}

		if (self._rooms[roomId]) {
			var room = self._rooms[roomId];

			if (message !== undefined) {
				if (to) {
					// Send message to individual user
					if (room.users.indexOf(to) > -1) {
						taro.network.send('taroChatMsg', msg, to);
					} else {
						console.log('[CHAT DEBUG] DROPPED: target user not in room:', to);
					}
				} else {
					// Send this message to all users in the room
					console.log('[CHAT DEBUG] BROADCASTING to all users in room:', roomId, msg);
					taro.network.send('taroChatMsg', msg);
				}
			} else {
				console.log('[CHAT DEBUG] DROPPED: blank message');
			}
		} else {
			console.log('[CHAT DEBUG] DROPPED: room does not exist in sendToRoom:', roomId);
		}
	},

	// added by Jaeyun to prevent spammers
	isSpamming: function (from, message) {

		// if from is undefined, it means the message is from the server
		if (from == undefined) {
			return false;
		}
		now = new Date();

		// if this is the user's first message. init
		if (this.lastMessageSentAt[from] == undefined) {
			this.lastMessageSentAt[from] = now;
			this.sentMessages[from] = [];
			return false;
		}

		// console.log("anti spam", now - this.lastMessageSentAt[from]);

		// prevent user from sending messages every second
		// 1500
		this.lastMessageSentAt[from] = now;

		this.sentMessages[from].push({
			time: new Date(),
			message: message,
		});
		var returnValue = false;
		if (this.sentMessages[from].length > 4) {
			var timeElapsed = 0;
			var charCount = 0;
			timeElapsed = now - this.sentMessages[from][0].time;
			for (i in this.sentMessages[from]) {
				charCount += this.sentMessages[from][i].message.length;
			}

			// sending 4 or more separate messages in 2 seconds
			if (timeElapsed <= 2000) {
				returnValue = true;
			}

			// sending more than 80 characters in 4 seconds
			if (timeElapsed <= 4000 && charCount > 80) {
				returnValue = true;
			}

			// maintain last 4 message in array
			this.sentMessages[from].shift();
		}
		return returnValue;
	},

	_onMessageFromClient: function (msg, clientId) {
		var self = taro.chat;
		var room;

		console.log('[CHAT DEBUG] _onMessageFromClient received:', JSON.stringify(msg), 'from clientId:', clientId);

		// prevent non-string or non-unicode (e.g. emoji) from being broadcasted as it can disconnect all connected clients
		if (typeof msg.text != 'string' || self.regexUnicode.test(msg.text) == true) {
			console.log('[CHAT DEBUG] DROPPED: msg.text is not a string, or failed regexUnicode test');
			return;
		}

		// msg.text = self.validator.blacklist(msg.text, self.regex);
		// msg.text = self.validator.whitelist(msg.text, self.regex)
		// msg.text = self.sanitizer.sanitize(msg.text);
		// msg.text = self.validator.escape(msg.text);
		// msg.text = self.filter.clean(msg.text);

		// no filter on standalone
		//
		if (process.env.ENV != 'standalone') {
			msg.text = self.filter.cleanHacked(msg.text); // https://github.com/web-mech/badwords/issues/93
		}
		//

		if (msg == undefined || msg.text == undefined) return;

		// Emit the event and if it wasn't cancelled (by returning true) then
		// process this ourselves
		if (!self.emit('messageFromClient', [msg, clientId])) {
			var player = taro.game.getPlayerByClientId(clientId);
			console.log('[CHAT DEBUG] player lookup by clientId:', player ? player._stats.name : 'NOT FOUND');
			if (player) {
				var playerName = player._stats && self.xssFilters.inHTMLData(player._stats.name);
				taro.devLog(`Message from client: (${playerName}): ${msg.text}`);

				player.lastMessageSent = msg.text;
				taro.queueTrigger('playerSendsMessage', {
					playerId: player.id(),
				});
			}

			if ((msg.roomId && typeof msg.roomId == 'string') || typeof msg.roomId == 'number') {
				room = self._rooms[msg.roomId];
				if (room) {
					console.log('[CHAT DEBUG] room found:', msg.roomId, 'room.users:', JSON.stringify(room.users), 'is clientId in room?', room.users.indexOf(clientId) > -1);
					if (room.users.indexOf(clientId) > -1) {
						var text = msg.text;
						if (text) {
							console.log('[CHAT DEBUG] calling sendToRoom now');
							self.sendToRoom(msg.roomId, msg.text, msg.to, clientId);
						} else {
							console.log('[CHAT DEBUG] DROPPED: message text was empty');
						}
					} else {
						// The user is not in the room specified
						console.log('[CHAT DEBUG] DROPPED: clientId is NOT in room.users for this room', clientId);
					}
				} else {
					// Room id specified does not exist
					console.log('[CHAT DEBUG] DROPPED: room does not exist:', msg.roomId, 'known rooms:', Object.keys(self._rooms));
				}
			} else {
				// No room id in the message
				console.log('[CHAT DEBUG] DROPPED: no roomId in message', JSON.stringify(msg));
			}
		} else {
			console.log('[CHAT DEBUG] DROPPED: messageFromClient event was cancelled by a listener');
		}
	},

	_onJoinRoomRequestFromClient: function (roomId, clientId) {
		var self = taro.chat;

		console.log('[CHAT DEBUG] _onJoinRoomRequestFromClient: clientId', clientId, 'wants to join room', roomId);

		// Emit the event and if it wasn't cancelled (by returning true) then
		// process this ourselves
		if (!self.emit('clientJoinRoomRequest', [roomId, clientId])) {
			var room = self._rooms[roomId];

			if (room) {
				// Check that the user isn't already part of the room user list
				if (room.users.indexOf(clientId) === -1) {
					// Add the user to the room
					room.users.push(clientId);
					console.log('[CHAT DEBUG] clientId', clientId, 'JOINED room', roomId, '- room.users now:', JSON.stringify(room.users));
					taro.network.send('taroChatJoinRoom', { roomId: roomId, joined: true }, clientId);
				} else {
					console.log('[CHAT DEBUG] clientId', clientId, 'already in room', roomId);
				}
			} else {
				console.log('[CHAT DEBUG] DROPPED join request: room does not exist:', roomId, 'known rooms:', Object.keys(self._rooms));
			}
		} else {
			console.log('[CHAT DEBUG] DROPPED join request: clientJoinRoomRequest event was cancelled');
		}
	},

	_onLeaveRoomRequestFromClient: function (roomId, clientId) {
		// Emit the event and if it wasn't cancelled (by returning true) then
		// process this ourselves
		if (!self.emit('clientLeaveRoomRequest', [roomId, clientId])) {
			console.log(`Client wants to leave room: (${clientId})`, roomId);
		}
	},

	_onClientWantsRoomList: function (data, clientId) {
		// Emit the event and if it wasn't cancelled (by returning true) then
		// process this ourselves
		if (!self.emit('clientRoomListRequest', [data, clientId])) {
			console.log(`Client wants the room list: (${clientId})`, data);
		}
	},

	_onClientWantsRoomUserList: function (roomId, clientId) {
		// Emit the event and if it wasn't cancelled (by returning true) then
		// process this ourselves
		if (!self.emit('clientRoomUserListRequest', [roomId, clientId])) {
			console.log(`Client wants the room user list: (${clientId})`, roomId);
		}
	},
};

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
	module.exports = TaroChatServer;
}
