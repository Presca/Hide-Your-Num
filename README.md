# Hide Your Num

A browser first-person game for up to 20 players: everyone wears a three-digit number on their
forehead. Look at someone's face, read their number and type it to eliminate them, before they read
yours. Inspired by [Figure Me Out](https://store.steampowered.com/app/5313470/Figure_Me_Out/).

- **Read before you're read.** You can only see a number that is in range, in front of you, not
  behind cover or smoke, and whose owner is facing you. Turning your back hides your number.
- **Type it.** Digits go straight in; three digits submit. A wrong code locks your keys for a moment,
  so guessing is expensive.
- **Gadgets.** <kbd>Q</kbd> smoke hides every number inside the cloud, <kbd>E</kbd> flash blinds
  whoever is in front of you, <kbd>F</kbd> shuffle gives you a new number on the spot.
- **Rounds.** Four minutes, most eliminations wins, then a new arena layout. Three-second respawn.
- **Modes.** Quick play drops you into the fullest open room, Join room uses a 4-letter code you can
  share as a link (`?room=KQ7X`), Practice runs the same rules in your tab against bots.

Desktop with keyboard and mouse. WASD to move, Space to jump, Tab for the scoreboard.

## What runs where

| Piece | Hosted on | Cost |
| --- | --- | --- |
| The game (`index.html`, `src/`, `shared/`) | GitHub Pages | Free |
| Match server (`worker/`) | Cloudflare Workers + Durable Objects | Free tier |

The match server is the referee. It owns the numbers, runs the simulation at 20 Hz and only sends a
player's number to the clients that can see their face right now, so reading the network traffic
does not let you read through walls. Practice mode needs no server at all.

## Setup

### 1. GitHub Pages
Repo → **Settings → Pages** → Source: *Deploy from a branch* → `main`, `/ (root)` → Save.
The game is live at `https://<you>.github.io/Hide-Your-Num/` with Practice working immediately.

### 2. Match server
You need a free Cloudflare account and Node.js.

```bash
cd worker
npm install
npx wrangler login
npx wrangler deploy        # prints https://hide-your-num.<you>.workers.dev
```

`worker/wrangler.toml` lists the websites allowed to connect (`ALLOWED_ORIGINS`). It already
contains `https://presca.github.io` and localhost; add your own domain if you use one.

### 3. Point the game at it
Put the Worker URL in `config.js` and push:

```js
window.HYN_CONFIG = { workerUrl: 'https://hide-your-num.<you>.workers.dev' };
```

## Local development

```bash
python3 -m http.server 8080          # the game at http://localhost:8080
cd worker && npm install && npm run dev   # the match server at http://localhost:8787
```

Set `workerUrl: 'http://localhost:8787'` in `config.js` while developing. Open two browser windows
to play against yourself.

## Layout

```
index.html, style.css, config.js   the page
src/main.js                        menu, match loop, message handling
src/world.js                       three.js arena, players, smoke, effects
src/controls.js                    pointer-lock FPS controls (same collision as the server)
src/hud.js                         typed digits, own number, timer, feed, scoreboard, sounds
src/net.js                         WebSocket transport and the in-tab practice transport
shared/match.js                    the rules: visibility, reading, kills, gadgets, rounds
shared/map.js                      seeded arena generation, collision, line of sight
shared/bots.js                     practice opponents
shared/constants.js                every tunable (range, cones, cooldowns, round length)
worker/src/index.js                Cloudflare Worker: Match and Lobby Durable Objects
```

Tuning lives in `shared/constants.js`. Both the server and the practice mode read it, so a change
there changes the game everywhere after a redeploy.

## Limits worth knowing

- Movement is client-predicted and server-checked for speed and walls, not fully server-simulated.
  Good enough for friends, not tournament-proof.
- One Durable Object per room keeps up to 20 sockets; rooms vanish when the last player leaves.
- Three.js is loaded from jsDelivr (pinned to 0.170.0). Google Fonts are optional; the game falls
  back to system fonts if they are blocked.
