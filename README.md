# Carnival Dozer

A multiplayer 3D carnival coin pusher for the web and Discord. Everyone plays one shelf as a team:
- **Hold, roll your wrist to aim your chute, and flick your phone** to drop a coin.
- **Jerk it up** to shake the shelf.

Shake **together** to topple the prize tower, but watch the **TILT** alarm. Play coins only: no real money, no real prizes.

| | |
|---|---|
| **Play in a browser** | https://coinpusher.housetandem.com |
| **In Discord** | Coming once the Discord application is set up (see below) |

Built with:
- Three.js
- Rapier physics (run by the host's browser)
- the DeviceMotion API
- PeerJS (WebRTC)
- a Cloudflare Worker with a Durable Object relay

It's the sibling of [7, 11, Doubles](https://github.com/petegordon/discord-activity-dice) and [Roulette](https://github.com/petegordon/discord-activity-roulette) and shares their networking and Discord plumbing. See [PLAN.md](PLAN.md) for the design.

## How to play

1. Open the site. It creates a room and puts its code in the URL. Use **Copy invite** to share it.
2. The first player in the room is the host. The host picks how many coins everyone gets (20, 30 or 50) and presses **Start**.
3. **Drop coins.** Hold the pad and roll your wrist to aim your chute, then flick the phone to drop a coin. How hard you flick sets how far it flies, and how you're twisting as you flick spins it. On iPhone, tap **Enable motion** first.
4. **Win them back.** Coins the pusher shoves into the gold tray come back to whoever's chute is nearest. Coins over the sides are lost.
5. **Shake.** Let go of the pad and jerk the phone up to shake the shelf. Shakes from two or more players at the same moment make one big shake. That's how the prize tower falls: 10, 20, 30 and 50 points.
6. **Don't tilt.** Every shake fills the TILT meter. Fill it and the shelf locks for 5 seconds.
7. The game ends when everyone is out of coins and none come back. The team score is the total of the prizes won.

**No motion sensors?** In Discord or on a desktop, you can:
- drag sideways on the pad to aim, and let go to drop (swipe up to throw further)
- press **SHAKE** to shake
- use the keyboard: ←/→ aim, Space drops, S shakes

Or use **📱 Play with your phone** ([PHONE-REMOTE.md](PHONE-REMOTE.md)): scan the QR code and your phone becomes your coin hand.

## Development

```bash
npm install
npm test              # unit tests (Vitest), including the physics
npm run typecheck     # app + worker
npm run build         # type-check + Vite build to dist/
npm run preview       # build, then serve app + Worker + Durable Object at http://127.0.0.1:8787
```

`npm run dev` starts Vite with hot reload and proxies `/api` to `wrangler dev` on :8787.

DeviceMotion, WebCrypto and WebRTC need **HTTPS**, so test on phones with the deployed site (or an HTTPS tunnel).

### End-to-end tests

With `npm run preview` running:

```bash
node scripts/e2e.mjs http://127.0.0.1:8787 relay 2        # or: peerjs 3
node scripts/e2e-remote.mjs http://127.0.0.1:8787 relay   # or: peerjs
node scripts/e2e-deploy.mjs http://127.0.0.1:8787
```

- `e2e.mjs` has headless players play a whole 20-coin game. They drop, do a synchronized shake, and shake until TILT locks the shelf. It then checks that everyone agrees on the count, and that coins add up (in hand = start − dropped + won back).
- `e2e-remote.mjs` pairs a phone that aims, drops and shakes with synthetic motion. It also covers a host leaving mid-game (the shelf carries over) and **New link** revoking the old phone.
- `e2e-deploy.mjs` checks that a page caught mid-deploy reloads itself (`public/boot-guard.js`).

Screenshots go to `scripts/out/`. Add these to a table URL:
- `&nomotion` for the no-motion layout
- `&t=relay` for the relay transport
- `&debug` to expose `window.dozer`

## Deploying to Cloudflare

The Worker serves the static build, `/api/*` and the relay on the custom domain **coinpusher.housetandem.com**. Wrangler creates the DNS record on deploy, since the `housetandem.com` zone is on the same Cloudflare account.

```bash
npm run deploy
npx wrangler secret put DISCORD_CLIENT_SECRET   # once the Discord app exists
```

## Discord Activity setup

The same steps as the dice app ([its README](https://github.com/petegordon/discord-activity-dice#discord-activity-setup)), with this app's domain:

1. Create an application at https://discord.com/developers/applications and enable **Activities**.
2. **URL Mappings:** `/` → `coinpusher.housetandem.com` (and `/peerjs` → `0.peerjs.com` only if forcing `t=peerjs`).
3. **OAuth2 → Redirects:** exactly one, e.g. `https://127.0.0.1`.
4. Put the application ID in `wrangler.jsonc` (`vars.DISCORD_CLIENT_ID`) and `.env.production` (`VITE_DISCORD_CLIENT_ID`). Set the secret with `npx wrangler secret put DISCORD_CLIENT_SECRET`, then run `npm run deploy`.
5. **Terms of Service URL:** https://coinpusher.housetandem.com/terms · **Privacy Policy URL:** https://coinpusher.housetandem.com/privacy
6. **Installation:** Guild Install with `applications.commands`. Under **Supported Platforms**, tick iOS and Android.

## Project layout

```
src/
  main.ts                 boot: identity, transport, wiring
  ui.ts, style.css        DOM overlay: lobby, players, score + tilt HUD, pad, shake button, callouts
  audio.ts                synthesised clinks, tray cascade, prize fanfare, shelf thump, tilt alarm
  game/                   rules and numbers, the pure game reducer (dozer.ts), host authority (shakes, tilt, frames)
  sim/                    Rapier shelf (host only), the packed frame format, prize sizes
  input/                  roll-to-aim, flick and shake detection, pointer and keyboard fallback
  net/                    protocol, transports (PeerJS, relay), room coordination and the host's physics loop
  platform/               environment, identity/rooms, Discord SDK, motion detection
  remote/                 the 📱 phone remote page (remote.html, served at /remote)
  render/scene.ts         Three.js cabinet, coins (instanced), prizes, chutes; blends between frames
worker/src/               Worker: assets, /api/token, /api/ice, RelayRoom Durable Object, Discord room tickets
test/                     Vitest unit tests
scripts/                  Playwright end-to-end tests
```
