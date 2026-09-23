The Taro Engine was abandoned in late 2024 as MODD.IO transitioned into becoming INDIE.FUN. Thanks to the engine being public, I fixed a lot of bugs and made it fit a single game.json.

## What I personally added

- An achievement/badge system
- Optimizations to the engine's core
- Separate account system
- And more ...
### NOTE! This will <u>NOT</u> work with your game. I personally tuned the engine to fit Plants vs. Zombies: Roam 2. If you want to try and make a standalone game yourself, I used Pineapplebrain's taro2 fork!
## Running the game

Make sure you have [Node 16](https://nodejs.org) or later.
First, setup the repo

```
git clone https://github.com/moddio/moddio2.git
cd moddio2
npm install
npm run tsc
```

Then, to start the server run:

```
npm run server
```

You can now play the game at http://localhost:8080

## How do I create a new game from scratch?

Moddio games are created & edited using Moddio Game Editor available at [https://www.modd.io](https://www.modd.io).
To learn how to use the game editor, visit [https://learn.modd.io](https://learn.modd.io).

After creating your game, you can export the `game.json` file for use in your local installation. To do this, navigate to `Menu` in the Moddio Game Editor and click `Export Game`.

<img src="./assets/images/gamejson2.png" width="600" alt="How to get game json in game's in-game editor">

Next, rename the downloaded Game JSON file to `game.json` and move it into the `src` directory.

To load your game file, simply start the server by running:

```bash
npm run server
```

You will be presented with a dropdown menu, where you can use the arrow keys to select your game file. Alternatively, you can pre-select your game file by running:

```bash
npm run server --game=game.json
```
