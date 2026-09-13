/**
 * The engine's box2d component class.
 */

var PhysicsComponent = TaroEventingClass.extend({
	classId: 'PhysicsComponent',
	componentId: 'physics',

	init: async function (entity, options, callback) {
		// Check that the engine has not already started
		// as this will mess everything up if it has
		if (taro._state != 0) {
			console.log('Cannot add box2d physics component to the taro instance once the engine has started!', 'error');
		}

		this._entity = entity;
		this._options = options;
		this._actionQueue = [];
		this.physicsTickDuration = 0;
		this.avgPhysicsTickDuration = 0;
		this.totalBodiesCreated = 0;
		this.lastSecondAt = Date.now();
		this.metaData = {};
		this.tryRecordLeak = (p) => p;
		this.walls = [];
		this.nullPtr = undefined;
		this.getPointer = undefined;
		this.engine = dists.defaultEngine;
		this._scaleRatio = 30;

		this.bodies = new Map();

		if (taro.game && taro.game.data && taro.game.data.defaultData) {
			if (taro.isServer) {
				this.engine = taro.game.data.defaultData.physicsEngine;
			} else if (taro.isClient) {
				this.engine = taro.game.data.defaultData.clientPhysicsEngine;
			}
		}

		this.engine = this.engine.toUpperCase();

		console.log('Physics engine: ', this.engine);

		if (this.engine) {
			try {
				await dists[this.engine].init(this);
				callback();
			} catch (err) {
				console.log(err, 'error: ');
			}
		} else {
			if (taro.isClient) {
				// alert('no physics engine selected');
			}
		}
	},

	log: function (msg) {
		console.log('PhysicsComponent:', msg);
	},

	/**
	 * Gets / sets if the world should allow sleep or not.
	 * @param {Boolean} val
	 * @return {*}
	 */
	sleep: function (val) {
		if (val !== undefined) {
			this._sleep = val;
			return this._entity;
		}

		return this._sleep;
	},

	/**
	 * Gets / sets the current engine to box2d tilesize ratio, tilesize ratio is used while defining
	 * anchors for joints (see revolute joint for planckjs engine).
	 * @param val
	 * @return {*}
	 */
	tilesizeRatio: function (val) {
		if (val !== undefined) {
			this._tilesizeRatio = val;
			return this._entity;
		}

		return this._tilesizeRatio;
	},

	/**
	 * Gets the current Box2d world object.
	 * @return {b2World}
	 */
	world: function () {
		return this._world;
	},

	/**
	 * Creates a Box2d body and attaches it to an taro entity
	 * based on the supplied body definition.
	 * @param {TaroEntity} entity
	 * @param {Object} body
	 * @return {b2Body}
	 */
	createBody: function (entity, body, isLossTolerant) {
		this.totalBodiesCreated++;
		return dists[this.engine].createBody(this, entity, body, isLossTolerant);
	},

	destroyBody: function (entity) {
		dists[this.engine].destroyBody(this, entity);
	},

	hasBody(entity) {
		return this.bodies.has(entity?.id());
	},

	getEntitiesInRegion: function (region) {
		return dists[this.engine].getEntitiesInRegion(this, region);
	},

	/**
	 * Produces static box2d bodies from passed map data.
	 * @param {TaroTileMap2d} mapLayer
	 * @param {Function=} callback Returns true or false depending
	 * on if the passed map data should be included as part of the
	 * box2d static object data. This allows you to control what
	 * parts of the map data are to be considered for box2d static
	 * objects and which parts are to be ignored. If not passed then
	 * any tile with any map data is considered part of the static
	 * object data.
	 */
	staticsFromMap: function (mapLayer, callback) {
		if (mapLayer == undefined) {
			taro.server.unpublish('PhysicsComponent#51');
		}

		if (mapLayer.map) {
			var tileWidth = taro.scaleMapDetails.tileWidth || mapLayer.tileWidth();
			var tileHeight = taro.scaleMapDetails.tileHeight || mapLayer.tileHeight();
			var posX;
			var posY;
			var rectArray;
			var rectCount;
			var rect;

			// Get the array of rectangle bounds based on
			// the map's data
			rectArray = mapLayer.scanRects(callback);
			rectCount = rectArray.length;

			while (rectCount--) {
				rect = rectArray[rectCount];

				posX = tileWidth * (rect.width / 2);
				posY = tileHeight * (rect.height / 2);

				var defaultData = {
					translate: {
						x: rect.x * tileWidth + posX,
						y: rect.y * tileHeight + posY,
					},
				};

				var wall = new TaroEntityPhysics(defaultData)
					.width(rect.width * tileWidth)
					.height(rect.height * tileHeight)
					.drawBounds(false)
					.drawBoundsData(false)
					.category('wall');

				this.walls.push(wall);

				// walls must be created immediately, because there isn't actionQueue for walls
				taro.physics.createBody(wall, {
					type: 'static',
					linearDamping: 0,
					angularDamping: 0,
					allowSleep: true,
					fixtures: [
						{
							friction: 0.1,
							restitution: 0,
							shape: {
								type: 'rectangle',
							},
							filter: {
								filterCategoryBits: 0x0001, // i am
								filterMaskBits: 0x0002 /*| 0x0004*/ | 0x0008 | 0x0010 | 0x0020, // i collide with everything except with each other (walls)
							},
							taroId: wall.id(),
						},
					],
				});
				if (taro.isServer) {
					taro.server.totalWallsCreated++;
				}
			}
		} else {
			PhysicsComponent.prototype.log(
				'Cannot extract box2d static bodies from map data because passed map does not have a .map property!',
				'error'
			);
		}
	},

	destroyWalls: function () {
		this.walls.forEach((wall) => {
			this.destroyBody(wall);
			wall.destroy();
		});
		this.walls = [];
	},

	/**
	 * Creates a contact listener with the specified callbacks. When
	 * contacts begin and end inside the box2d simulation the specified
	 * callbacks are fired.
	 * @param {Function} beginContactCallback The method to call when the contact listener detects contact has started.
	 * @param {Function} endContactCallback The method to call when the contact listener detects contact has ended.
	 * @param {Function} preSolve
	 * @param {Function} postSolve
	 */
	contactListener: function (beginContactCallback, endContactCallback, preSolve, postSolve) {
		dists[this.engine].contactListener(this, beginContactCallback, endContactCallback, preSolve, postSolve);
	},

	/**
	 * If enabled, sets the physics world into network debug mode which
	 * will stop the world from generating collisions but still allow us
	 * to see shape outlines as they are attached to bodies. Useful when
	 * your physics system is server-side but seeing client-side shape
	 * data is useful for debugging collisions.
	 * @param {Boolean} val
	 */
	networkDebugMode: function (val) {
		if (val !== undefined) {
			this._networkDebugMode = val;

			if (val === true) {
				// We are enabled so disable all physics contacts
				this.contactListener(
					// Begin contact
					function (contact) {},
					// End contact
					function (contact) {},
					// Pre-solve
					function (contact) {
						// Cancel the contact
						contact.SetEnabled(false);
					},
					// Post-solve
					function (contact) {}
				);
			} else {
				// Re-enable contacts
				this.contactListener();
			}

			return this._entity;
		}

		return this._networkDebugMode;
	},

	/**
	 * Creates a debug entity that outputs the bounds of each box2d
	 * body during standard engine ticks.
	 * @param {TaroEntity} mountScene
	 */
	enableDebug: function (mountScene) {
		if (this.engine == 'PLANCK') return; // planck doesn't support debugdraw
		if (mountScene) {
			// Define the debug drawing instance
			var debugDraw = new this.b2DebugDraw();
			this._box2dDebug = true;

			debugDraw.SetSprite(taro._ctx);
			debugDraw.SetDrawScale(this._scaleRatio);
			debugDraw.SetFillAlpha(0.3);
			debugDraw.SetLineThickness(1.0);
			debugDraw.SetFlags(
				this.b2DebugDraw.e_controllerBit |
					this.b2DebugDraw.e_jointBit |
					this.b2DebugDraw.e_pairBit |
					this.b2DebugDraw.e_shapeBit
				// | this.b2DebugDraw.e_aabbBit
				// | this.b2DebugDraw.e_centerOfMassBit
			);

			// Set the debug draw for the world
			this._world.SetDebugDraw(debugDraw);
		} else {
			PhysicsComponent.prototype.log(
				'Cannot enable box2d debug drawing because the passed argument is not an object on the scenegraph.',
				'error'
			);
		}
	},

	// *
	//  * Instantly move a body to an absolute position subverting the physics simulation
	//  * @param body

	// moveBody: function(body, x, y)
	// {
	// 	body.SetTransform(b2Vec2(x,y),body.GetAngle())
	// },

	/**
	 * Gets / sets the callback method that will be called after
	 * every physics world step.
	 * @param method
	 * @return {*}
	 */
	updateCallback: function (method) {
		if (method !== undefined) {
			this._updateCallback = method;
			return this._entity;
		}

		return this._updateCallback;
	},

	start: function (continuousPhysics) {
		var self = this;

		if (!this._active) {
			this._active = true;

			this.setContinuousPhysics(!!continuousPhysics);
			this.createWorld();

			if (!this._networkDebugMode) {
				this._entity.addBehaviour('box2dStep', this._behaviour);
			}

			if (taro.isServer || (taro.isClient && taro.physics)) {
				self.contactListener(this._beginContactCallback, this._endContactCallback);
			}
		}
	},

	stop: function () {
		if (this._active) {
			this._active = false;
			this._entity.removeBehaviour('box2dStep');
			if (taro.isClient) {
				clearInterval(this._intervalTimer);
			}
		}
	},

	queueAction: function (action) {
		// PhysicsComponent.prototype.log("queueAction: "+action.type);
		this._actionQueue.push(action);
	},

	update: function (timeElapsedSinceLastStep) {
		if (timeElapsedSinceLastStep > 100) {
			return;
		}
		var self = this;
		var tempBod;
		var entity;
		let now = Date.now();

		if (self && self._active && self._world) {
			var queueSize = 0;
			if (!self._world.isLocked()) {
				while (self._actionQueue.length > 0) {
					var action = self._actionQueue.shift();
					queueSize++;
					if (queueSize > 1000) {
						taro.devLog(
							`PhysicsComponent.js _behaviour queue looped over 1000 times. Currently processing action: ${action.type}`
						);
					}

					// console.log(action.type, "entity:", action.entity != null, (action.entity != null)?action.entity._category + " " + action.entity._stats.name:"null", " entityA:",  action.entityA != null, (action.entityA != null)?action.entityA._category + " " +action.entityA._stats.name:"null", " entityB:",  action.entityB != null, (action.entityB != null)?action.entityB._category + " " +action.entityB._stats.name:"null")
					switch (action.type) {
						case 'createBody':
							self.createBody(action.entity, action.def);

							// Apply initial velocity after the body exists and before the next
							// physics step, avoiding a race with the entity action queue.
							if (
								action.def.initialVelocity &&
								action.entity &&
								action.entity.hasPhysicsBody()
							) {
								const initialVelocity = action.def.initialVelocity;
								switch (initialVelocity.deployMethod) {
									case 'applyForce':
										action.entity.applyForceLT(initialVelocity.x, initialVelocity.y);
										break;
									case 'applyImpulse':
										action.entity.applyImpulseLT(initialVelocity.x, initialVelocity.y);
										break;
									case 'setVelocity':
									default:
										action.entity.setLinearVelocityLT(initialVelocity.x, initialVelocity.y);
							}
							}

							// emit events for updating visibility mask
							if (taro.isClient && action.entity._category === 'unit' && action.def.type === 'static') {
								taro.client.emit('update-static-units');
							}
							break;

						case 'destroyBody':
							self.destroyBody(action.entity);
							break;
					}
				}
			}

			let timeStart = now;

			// Loop the physics objects and move the entities they are assigned to
			var tempBod =
				this.engine === 'BOX2DWASM' ? self.recordLeak(self._world.getBodyList()) : self._world.getBodyList();

			// iterate through every physics body
			while (
				tempBod &&
				typeof tempBod.getNext === 'function' &&
				(!self.getPointer || self.getPointer(tempBod) !== self.getPointer(self.nullPtr))
			) {
				// Check if the body is awake && not static
				entity = self.getPointer !== undefined ? self.metaData[self.getPointer(tempBod)]._entity : tempBod._entity;
				//FIXME: when the 3d physics is ready, remove this
				if (entity && entity.tmpDefaultDepth) {
					entity.queueStreamData({ temp_translation_y: entity.tmpDefaultDepth });
				}
				if (tempBod.m_type !== 'static' && tempBod.isAwake() && (!tempBod.GetType || tempBod.GetType() !== 0)) {
					if (entity && !entity._stats.isHidden) {
						// apply movement if it's either human-controlled unit, or ai unit that's currently moving
						if (
							entity.hasPhysicsBody() &&
							entity._stats.controls &&
							entity.vector &&
							(entity.vector.x != 0 || entity.vector.y != 0)
						) {
							switch (
								entity._stats.controls.movementMethod // velocity-based movement
							) {
								case 'velocity':
									entity.setLinearVelocity(entity.vector.x, entity.vector.y);
									break;
								case 'force':
									entity.applyForce(entity.vector.x, entity.vector.y);
									break;
								case 'impulse':
									entity.applyImpulse(entity.vector.x, entity.vector.y);
									break;
							}
						}

						var mxfp = dists[taro.physics.engine].getBodyPosition(tempBod, self);
						var x = mxfp.x * taro.physics._scaleRatio;
						var y = mxfp.y * taro.physics._scaleRatio;
						// make projectile auto-rotate toward its path. ideal for arrows or rockets that should point toward its direction
						// if (entity._category == 'projectile' &&
						// 	entity._stats.currentBody && !entity._stats.currentBody.fixedRotation &&
						// 	tempBod.m_linearVelocity.y != 0 && tempBod.m_linearVelocity.x != 0
						// ) {
						// 	var angle = Math.atan2(tempBod.m_linearVelocity.y, tempBod.m_linearVelocity.x) + Math.PI / 2;
						// } else {

						var angle = this.engine === 'BOX2DWASM' ? self.recordLeak(tempBod.getAngle()) : tempBod.getAngle();
						// }

						var tileWidth = taro.scaleMapDetails.tileWidth;
						var tileHeight = taro.scaleMapDetails.tileHeight;

						var skipBoundaryCheck = entity._stats && entity._stats.confinedWithinMapBoundaries === false;
						var padding = tileWidth / 2;

						// keep entities within the boundaries
						if (
							(entity._category === 'unit' || entity._category === 'item' || entity._category === 'projectile') &&
							!skipBoundaryCheck &&
							(x < padding ||
								x > taro.map.data.width * tileWidth - padding ||
								y < padding ||
								y > taro.map.data.height * tileHeight - padding)
						) {
							// fire 'touchesWall' trigger when unit goes out of bounds for the first time
							if (!entity.isOutOfBounds) {
								if (entity._category === 'unit' || entity._category === 'item' || entity._category === 'projectile') {
									entity.script.trigger('entityTouchesWall');
								}

								if (entity._category === 'unit') {
									// console.log("unitTouchesWall", entity.id());
									taro.script.trigger('unitTouchesWall', { unitId: entity.id() });
								} else if (entity._category === 'item') {
									taro.script.trigger('itemTouchesWall', { itemId: entity.id() });
								} else if (entity._category === 'projectile') {
									taro.script.trigger('projectileTouchesWall', { projectileId: entity.id() });
								}

								entity.isOutOfBounds = true;
							}

							x = Math.max(Math.min(x, taro.map.data.width * tileWidth - padding), padding);
							y = Math.max(Math.min(y, taro.map.data.height * tileHeight - padding), padding);
						} else {
							if (entity.isOutOfBounds) {
								entity.isOutOfBounds = false;
							}
						}

						// entity just has teleported

						if (entity.teleportDestination != undefined) {
							entity.nextKeyFrame[1] = entity.teleportDestination;
							x = entity.teleportDestination[0];
							y = entity.teleportDestination[1];
							angle = entity.teleportDestination[2];
							entity.teleportDestination = undefined;
						} else {
							if (taro.isServer) {
								entity.translateTo(x, y, 0);
								entity.rotateTo(0, 0, angle);

								// if (entity._category == 'unit') {
								// 	console.log (taro._currentTime, parseFloat(x - entity.lastX).toFixed(2), "/", timeElapsedSinceLastStep, "speed", parseFloat((x - entity.lastX)/timeElapsedSinceLastStep).toFixed(2),
								// 				x, entity.lastX, taro._currentTime, taro._currentTime - timeElapsedSinceLastStep)
								// }

								// entity.lastX = x;

								// if client-authoritative csp mode is enabled, and the client msg was received within 100ms,
								// then use the client's msg to update this unit's position
								if (taro.game.data.defaultData.clientPhysicsEngine && entity._stats.controls?.cspMode == 2) {
									let clientStreamReceivedAt = entity.clientStreamedKeyFrame[0];
									let player = entity.getOwner();

									// player stopped sending msg. probably browsing something else. set as inactive.
									if (player && now - clientStreamReceivedAt > 1000 && player.isTabActive) {
										player.isTabActive = false;
									}

									// client msg was received within 200ms,
									// also ignore client msg if client just recently became active again (<2s)
									// as the client's position isn't as reliable. for the next 3s, the client's position will be dictated by the server stream
									if (now - clientStreamReceivedAt < 200 && now - player.tabBecameActiveAt > 1000) {
										let clientStreamedPosition = entity.clientStreamedKeyFrame[1];

										let xDiff = clientStreamedPosition[0] - x;
										let yDiff = clientStreamedPosition[1] - y;

										// if difference is less than 100, then rubberband, otherwise instantly teleport
										if (Math.abs(xDiff) < 100 && Math.abs(yDiff) < 100) {
											x += xDiff / 6;
											y += yDiff / 6;
										} else {
											x = clientStreamedPosition[0];
											y = clientStreamedPosition[1];
										}

										angle = clientStreamedPosition[2];
										// if (!isNaN(clientStreamedPosition[3]) && !isNaN(clientStreamedPosition[4])) {
										// 	// console.log(clientStreamedPosition[3], clientStreamedPosition[4]);
										// 	entity.setLinearVelocity(clientStreamedPosition[3] / 2, clientStreamedPosition[4] / 2);
										// }
									}
								}
							} else if (taro.isClient) {
								// client-side prediction is enabled (cspMode either 1 or 2)
								// my unit's position and projectiles that are NOT server-streamed.
								// this does NOT run for items
								if (
									(entity == taro.client.selectedUnit && entity._stats.controls?.cspMode) ||
									(entity._category == 'projectile' && entity._stats.streamMode !== 1) ||
									(entity._category == 'unit' && entity._stats.streamMode !== 1)
								) {
									// if client-authoritative mode is enabled, and tab became active within the last 3 seconds let server dictate my unit's position
									let myUnit = taro.client.selectedUnit;

									// If cspMode is client-authoritative and the client had inactive tab, then the unit's position should be dictated by the server
									if (entity == myUnit) {
										if (
											entity._stats.controls?.cspMode == 2 &&
											now - taro.client.tabBecameActiveAt < 1000 // it hasn't passed 2 sec since the tab became active
										) {
											x = myUnit.serverStreamedPosition.x;
											y = myUnit.serverStreamedPosition.y;
										} else if (
											// Server-authoritative CSP reconciliation
											entity._stats.controls?.cspMode == 1 &&
											!entity.isTeleporting &&
											entity.reconRemaining &&
											!isNaN(entity.reconRemaining.x) &&
											!isNaN(entity.reconRemaining.y)
										) {
											// if the current reconcilie distance is greater than my unit's body dimention,
											// instantly move unit (teleport) to the last streamed position. Otherwise, gradually reconcile
											if (
												Math.abs(entity.reconRemaining.x) > entity._stats.currentBody.width * 1.5 ||
												Math.abs(entity.reconRemaining.y) > entity._stats.currentBody.height * 1.5
											) {
												x = myUnit.serverStreamedPosition.x;
												y = myUnit.serverStreamedPosition.y;

												// x += xRemaining;
												// y += yRemaining;
												entity.reconRemaining = undefined;
											} else {
												entity.reconRemaining.x /= 5;
												entity.reconRemaining.y /= 5;

												x += entity.reconRemaining.x;
												y += entity.reconRemaining.y;
											}
										}
									}

									entity.prevKeyFrame = entity.nextKeyFrame;
									entity.nextKeyFrame = [taro._currentTime + taro.client.renderBuffer, [x, y, angle]];
								} else {
									// update server-streamed entities' body position
									// for items, client-side physics body is updated by setting entity.nextKeyFrame in item._behaviour()
									x = entity.nextKeyFrame[1][0];
									y = entity.nextKeyFrame[1][1];
									angle = entity.nextKeyFrame[1][2];
								}

								if (
									entity.prevKeyFrame &&
									entity.nextKeyFrame &&
									entity.prevKeyFrame[1] &&
									entity.nextKeyFrame[1] &&
									(parseFloat(entity.prevKeyFrame[1][0]).toFixed(1) !=
										parseFloat(entity.nextKeyFrame[1][0]).toFixed(1) ||
										parseFloat(entity.prevKeyFrame[1][1]).toFixed(1) !=
											parseFloat(entity.nextKeyFrame[1][1]).toFixed(1) ||
										parseFloat(entity.prevKeyFrame[1][2]).toFixed(2) !=
											parseFloat(entity.nextKeyFrame[1][2]).toFixed(2))
								) {
									// console.log("is moving", entity.prevKeyFrame[1][0], entity.nextKeyFrame[1][0], entity.prevKeyFrame[1][1], entity.nextKeyFrame[1][1], entity.prevKeyFrame[1][2], entity.nextKeyFrame[1][2])
									entity.isTransforming(true);
								}
							}

							// keep track of units' position history for CSP reconciliation
							if (
								entity._category == 'unit' &&
								((taro.isClient && entity == taro.client.selectedUnit) ||
									(taro.isServer && entity._stats.controls?.cspMode == 2))
							) {
								entity.posHistory.push([taro._currentTime, [x, y, angle]]);
								if (entity.posHistory.length > taro._physicsTickRate) {
									entity.posHistory.shift();
								}
							}
						}

						if (!isNaN(x) && !isNaN(y)) {
							entity.translateToLT(x, y);
							entity.rotateToLT(angle);
						}

						if (tempBod.asleep) {
							// The tempBod was asleep last frame, fire an awake event
							tempBod.asleep = false;
							taro.physics.emit('afterAwake', entity);
						}
					} else {
						if (!tempBod.asleep) {
							// The tempBod was awake last frame, fire an asleep event
							tempBod.asleep = true;
							taro.physics.emit('afterAsleep', entity);
						}
					}
				}

				tempBod = this.engine === 'BOX2DWASM' ? self.recordLeak(tempBod.getNext()) : tempBod.getNext();
			}

			// Call the world step; frame-rate, velocity iterations, position iterations
			self._world.step(timeElapsedSinceLastStep / 1000, 8, 3);

			if (self.debugDrawer && self.debugDrawer.begin) {
				self.debugDrawer.begin();
				self._world.DebugDraw();
				self.debugDrawer.end();
			}

			if (self.ctx) {
				self.ctx.clear();
				self._world.DebugDraw();
			}

			taro._physicsFrames++;
			// Clear forces because we have ended our physics simulation frame
			self._world.clearForces();

			// get stats for dev panel
			var timeEnd = Date.now();
			self.physicsTickDuration += timeEnd - timeStart;
			if (self.engine === 'BOX2DWASM') {
				self.freeLeaked();
			}
			if (timeEnd - self.lastSecondAt > 1000) {
				self.lastSecondAt = timeEnd;
				self.avgPhysicsTickDuration = self.physicsTickDuration / taro._fpsRate;
				self.physicsTickDuration = 0;
			}

			if (typeof self._updateCallback === 'function') {
				self._updateCallback();
			}
		}
	},

	destroy: function () {
		// Stop processing box2d steps
		this._entity.removeBehaviour('box2dStep');
		if (taro.isClient) {
			clearInterval(this._intervalTimer);
		}
		// Destroy all box2d world bodies
	},

	gravitic: function (entity, toggle) {
		const body = this.bodies.get(entity?.id());

		if (!body || toggle === undefined) {
			return;
		}

		if (taro.physics.engine === 'BOX2DWASM') {
			body.SetGravityScale(!toggle ? 0 : 1);
		} else {
			body.m_nonGravitic = !toggle;
			body.m_gravityScale = !toggle ? 0 : 1;
			body.setAwake(true);
		}
	},

	applyForce: function (entity, x, y) {
		const body = this.bodies.get(entity?.id());

		if (!body || isNaN(x) || isNaN(y) || !isFinite(x) || !isFinite(y)) {
			return;
		}

		const force = new taro.physics.b2Vec2(x, y);
		body.applyForce(force, body.getWorldCenter());

		if (taro.physics.engine === 'BOX2DWASM') {
			taro.physics.destroyB2dObj(force);
		}
	},

	applyImpulse: function (entity, x, y) {
		const body = this.bodies.get(entity?.id());

		if (!body || isNaN(x) || isNaN(y) || !isFinite(x) || !isFinite(y)) {
			return;
		}

		const impulse = new taro.physics.b2Vec2(x, y);
		body.applyLinearImpulse(impulse, body.getWorldCenter());

		if (taro.physics.engine === 'BOX2DWASM') {
			taro.physics.destroyB2dObj(impulse);
		}
	},

	applyTorque: function (entity, torque) {
		const body = this.bodies.get(entity?.id());

		if (!body || isNaN(torque) || !isFinite(torque)) {
			return;
		}

		body.applyTorque(torque);
	},

	translateTo: function (entity, x, y) {
		const body = this.bodies.get(entity?.id());

		if (!body || isNaN(x) || isNaN(y) || !isFinite(x) || !isFinite(y)) {
			return;
		}

		body.setPosition({ x, y });
		body.setAwake(true);
	},

	rotateTo: function (entity, angle) {
		const body = this.bodies.get(entity?.id());

		if (!body || isNaN(angle) || !isFinite(angle)) {
			return;
		}

		body.setAngle(angle);
		body.setAwake(true);
	},

	setLinearVelocity: function (entity, x, y) {
		const body = this.bodies.get(entity?.id());

		if (!body || isNaN(x) || isNaN(y) || !isFinite(x) || !isFinite(y)) {
			return;
		}

		if (taro.physics.engine === 'BOX2DWASM') {
			const velocity = new taro.physics.b2Vec2(x, y);
			body.setLinearVelocity(velocity);
			taro.physics.destroyB2dObj(velocity);
		} else {
			body.setLinearVelocity(new TaroPoint3d(x, y, 0));
		}
	},

	getLinearVelocity: function (entity) {
		const body = this.bodies.get(entity?.id());

		if (!body) {
			return { x: 0, y: 0 };
		}

		const velocity = body.getLinearVelocity();
		return {
			x: velocity.x,
			y: velocity.y,
		};
	},

	getPosition: function (entity) {
		const body = this.bodies.get(entity?.id());

		if (!body) {
			return { x: 0, y: 0 };
		}

		const position = body.getPosition();
		return {
			x: position.x,
			y: position.y,
		};
	},

	isLocked: function () {
		return !!this._world?.isLocked();
	},

	getBodyCount: function () {
		return this._world?.m_bodyCount || this._world?.GetBodyCount?.() || 0;
	},

	getContactCount: function () {
		return this._world?.m_contactCount || this._world?.GetContactCount?.() || 0;
	},

	getScaleRatio: function () {
		return this._scaleRatio;
	},

	_triggerContactEvent: function (entityA, entityB) {
		var triggeredBy = {};

		if (!['unit', 'projectile', 'item'].includes(entityA._category)) {
			return;
		}
		switch (entityA._category) {
			case 'unit':
				triggeredBy.unitId = entityA.id();
				taro.game.lastTouchingUnitId = entityA.id();
				break;
			case 'item':
				triggeredBy.itemId = entityA.id();
				break;
			case 'projectile':
				triggeredBy.projectileId = entityA.id();
				break;
		}

		switch (entityB._category) {
			case 'unit':
				taro.game.lastTouchedUnitId = entityB.id();
				taro.script.trigger(`${entityA._category}TouchesUnit`, triggeredBy); // handle unitA touching unitB
				triggeredBy.unitId = entityB.id();
				entityA.script.trigger('entityTouchesUnit', triggeredBy);
				break;

			case 'item':
				triggeredBy.itemId = triggeredBy.itemId || entityB.id();
				taro.script.trigger(`${entityA._category}TouchesItem`, triggeredBy);
				triggeredBy.itemId = entityB.id();
				taro.game.lastTouchedItemId = entityB.id();
				entityA.script.trigger('entityTouchesItem', triggeredBy);
				break;
			case 'projectile':
				triggeredBy.projectileId = triggeredBy.projectileId || entityB.id();
				triggeredBy.collidingEntity = entityA.id();

				// built-in damaging system. it's important that this runs prior to trigger events
				// this projectile may be destroyed before inflicting damage
				if (entityA._category == 'unit') {
					entityA.inflictDamage(entityB._stats.damageData);
				}
				taro.script.trigger(`${entityA._category}TouchesProjectile`, triggeredBy);
				triggeredBy.projectileId = entityB.id();
				entityA.script.trigger('entityTouchesProjectile', triggeredBy);
				break;

			case 'region':
				var region = taro.script.param.getValue({
					function: 'getVariable',
					variableName: entityB._stats.id,
				});
				triggeredBy.region = region;
				entityA.script.trigger('entityEntersRegion', triggeredBy);
				taro.script.trigger(`${entityA._category}EntersRegion`, triggeredBy);
				break;

			case 'sensor':
				triggeredBy.sensorId = entityB.id();
				var sensoringUnit = entityB.getOwnerUnit();

				if (sensoringUnit && sensoringUnit.script) {
					sensoringUnit.script.trigger(`${entityA._category}EntersSensor`, triggeredBy);

					if (entityA._category == 'unit' && sensoringUnit.ai) {
						sensoringUnit.ai.registerSensorDetection(entityA);
					}
				}

				break;

			case undefined:
			case 'wall':
				taro.script.trigger(`${entityA._category}TouchesWall`, triggeredBy);
				entityA.script.trigger('entityTouchesWall');
				break;
		}
	},

	_triggerLeaveEvent: function (entityA, entityB) {
		var triggeredBy = {};

		if (!['unit', 'projectile', 'item'].includes(entityA._category)) {
			return;
		}

		switch (entityA._category) {
			case 'unit':
				triggeredBy.unitId = entityA.id();
				break;
			case 'item':
				triggeredBy.itemId = entityA.id();
				break;
			case 'projectile':
				triggeredBy.projectileId = entityA.id();
				break;
		}

		switch (entityB._category) {
			case 'region':
				var region = taro.script.param.getValue({
					function: 'getVariable',
					variableName: entityB._stats.id,
				});
				triggeredBy.region = region;
				entityA.script.trigger('entityLeavesRegion', triggeredBy);
				taro.script.trigger(`${entityA._category}LeavesRegion`, triggeredBy);
				break;

			case 'sensor':
				triggeredBy.sensorId = entityB.id();
				var sensoringUnit = entityB.getOwnerUnit();
				if (sensoringUnit && sensoringUnit.script) {
					sensoringUnit.script.trigger(`${entityA._category}LeavesSensor`, triggeredBy);
				}
				break;

			case undefined:
		}
	},

	// Listen for when contact's begin
	_beginContactCallback: function (contact) {
		if (taro.physics.engine === 'BOX2DWASM') {
			const nowContact = taro.physics.recordLeak(taro.physics.wrapPointer(contact, taro.physics.b2Contact));
			const fixtureA = taro.physics.recordLeak(nowContact.GetFixtureA());
			const bodyA = taro.physics.recordLeak(fixtureA.GetBody());
			const fixtureB = taro.physics.recordLeak(nowContact.GetFixtureB());
			const bodyB = taro.physics.recordLeak(fixtureB.GetBody());
			var entityA = taro.physics.metaData[taro.physics.getPointer(bodyA)]._entity;
			var entityB = taro.physics.metaData[taro.physics.getPointer(bodyB)]._entity;
			if (!entityA || !entityB) return;

			taro.physics.freeFromCache(contact);
			taro.physics._triggerContactEvent(entityA, entityB);
			taro.physics._triggerContactEvent(entityB, entityA);
		} else {
			var entityA = contact.m_fixtureA.m_body._entity;
			var entityB = contact.m_fixtureB.m_body._entity;

			if (!entityA || !entityB) return;

			taro.physics._triggerContactEvent(entityA, entityB);
			taro.physics._triggerContactEvent(entityB, entityA);
		}
	},

	_endContactCallback: function (contact) {
		if (taro.physics.engine === 'BOX2DWASM') {
			const nowContact = taro.physics.recordLeak(taro.physics.wrapPointer(contact, taro.physics.b2Contact));
			const fixtureA = taro.physics.recordLeak(nowContact.GetFixtureA());
			const bodyA = taro.physics.recordLeak(fixtureA.GetBody());
			const fixtureB = taro.physics.recordLeak(nowContact.GetFixtureB());
			const bodyB = taro.physics.recordLeak(fixtureB.GetBody());
			var entityA = taro.physics.metaData[taro.physics.getPointer(bodyA)]._entity;
			var entityB = taro.physics.metaData[taro.physics.getPointer(bodyB)]._entity;

			if (!entityA || !entityB) return;
			taro.physics.freeFromCache(contact);
			taro.physics._triggerLeaveEvent(entityA, entityB);
			taro.physics._triggerLeaveEvent(entityB, entityA);
		} else {
			var entityA = contact.m_fixtureA.m_body._entity;
			var entityB = contact.m_fixtureB.m_body._entity;

			if (!entityA || !entityB) return;

			taro.physics._triggerLeaveEvent(entityA, entityB);
			taro.physics._triggerLeaveEvent(entityB, entityA);
		}
	},
});

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
	module.exports = PhysicsComponent;
}
