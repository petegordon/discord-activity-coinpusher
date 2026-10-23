# Carnival Dozer: Plan & Specification

A multiplayer **carnival coin pusher** with a 3D cabinet. It runs **as a Discord Activity** and **as a standalone web app** at **https://coinpusher.housetandem.com**. Everyone plays together on one shelf:
- **Hold the pad and roll your wrist** to aim your chute.
- **Flick** to drop a coin. The twist as you flick spins the coin.
- **Let go and jerk the phone up** to shake the shelf.

Shakes that land **together** topple the prize tower, but every shake fills a shared **tilt alarm**.

It's a sibling of [discord-activity-dice](https://github.com/petegordon/discord-activity-dice) and [discord-activity-roulette](https://github.com/petegordon/discord-activity-roulette). It reuses their networking, Discord, Worker and phone-remote infrastructure, and the dice [PLAN.md](https://github.com/petegordon/discord-activity-dice/blob/main/PLAN.md) documents those parts in depth. This file covers what's different.

**Stack:**
- Three.js for rendering
- Rapier physics (WebAssembly, run by the host only)
- DeviceMotion API for aim, flick and shake
- PeerJS / WebRTC for peer-to-peer sync
- Cloudflare Workers with static assets and a Durable Object, for hosting, the Discord OAuth token exchange and the WebSocket relay
- Vite + TypeScript

**Play coins only.** No real money, nothing to buy, no real prizes (see the [Terms](public/terms.html)).

---

## 1. Game design

Pete's concept (2026-10-22): *the classic arcade cascading coin shelf. Players flick their controllers forward to launch coins down the chute, using gyro roll (twisting the wrist) to aim the chute angle and control the spin of the coin as it lands. Players time synchronized "shelf shakes" (a sharp upward jerk of both controllers) to nudge a teetering tower of prizes over the edge while managing a shared tilt-alarm meter.*

| Decision (Pete, 2026-10-22) | Choice |
|---|---|
| Who plays against whom | **Co-op table**: one shared shelf, one team score. |
| When you drop | **Any time, from your own chute.** Chutes are spread along the back wall in join order. Each player has a coin budget. |
| What ends a game | **Coins run out.** Each player starts with 30 by default (the host picks 20, 30 or 50). Coins pushed into the tray come back to the hand of the player whose chute is nearest where they fell. The game ends once nobody has a coin and none has come back for 8 s. |
| Tilt alarm full | **The shelf locks for 5 s**: TILT! sounds, the pusher stops, drops and shakes are refused, and the meter drains. |

### 1.1 Rules and numbers I chose (Pete hasn't tuned these)
All in `src/game/rules.ts`.
- **Shakes.** Each shaking player adds **30** to the tilt meter, and the meter drains **12 per second**.
  - Shakes from different players within **300 ms** combine into one **strong** shake (3×).
  - A lone shake, with others at the table, is a **gentle** nudge (1×).
  - Playing alone, every shake is strong, since there's nobody to sync with.
- **Prize tower.** Four stacked gift boxes worth **10, 20, 30 and 50** points, bottom to top, set slightly off-centre so they teeter.
  - A prize that falls into the tray scores for the team. A prize that falls into a gutter is lost.
  - A new tower arrives 1.5 s after the last prize leaves the shelf.
- **Gutters.** Coins that fall off the front within the centre 70% land in the win tray. Outside that, the side gutters keep them, as in the arcade. Without gutters, every coin would eventually come back and the game would never end.
- **Drops.** At most one drop per player every **350 ms**.
- **Starting pile.** 190 coins are shuffled into place by the pusher before play starts.

Measured in the simulation (`test/sim.test.ts` and a 30 s diagnostic):
- Once the shelf is full, roughly as many coins fall off as are dropped. About a third of them go into the gutters.
- **Without shakes, the tower never fell in 30 s. With a synchronized shake every 4 s, it fell in 8–24 s.**

So shaking is what wins prizes, and the tilt meter stops it being free.

### 1.2 State
- `GameState` (`src/game/dozer.ts`) holds what's counted: phase (`lobby | playing | over`), players in join order, coins in hand, the team score, prizes, and coins won, lost and dropped.
- Pure reducers handle the changes. They run only on the host.
- The coins and prizes on the shelf live in the host's physics and reach everyone as frames (§2.2).

## 2. Physics and sync

### 2.1 The host simulates (`src/sim/world.ts`)
Coins stack, slide and shove each other, so there's no shortcut like roulette's precomputed ball path. The current host runs a real rigid-body simulation (Rapier, 120 Hz fixed step). It contains:
- fixed walls and floor
- a kinematic pusher sliding under the back wall, which scrapes off coins riding on it
- cylinder coins and box prizes

Rapier (~1.7 MB gzipped) loads on demand, only on whichever device is host. A phone host costs about 80 ms of CPU per simulated second in Node, so it's fine.

### 2.2 Everyone else renders frames (`src/sim/frame.ts`, `src/render/scene.ts`)
About 15 times a second, the host broadcasts a `frame`:
- the pusher's position, the tilt meter and the lock time left
- every body that moved since the last frame, packed as 18 bytes each (16-bit 0.1 mm positions and 16-bit quaternions, base64)
- the ids that fell off
- events: drops, coins won or lost, prizes, shakes, tilt, unlock, a new tower

Every 30th frame, and whenever someone joins, the frame is a **keyframe** with every body. Clients draw about 110 ms in the past and blend between the two frames either side, so motion is smooth despite network jitter. The host renders from its own frames the same way.

### 2.3 Host migration
Every client keeps the latest pose of every body from the frames. When the host leaves, the next host loads Rapier and rebuilds the shelf from those poses (velocities start at rest). It keeps the same ids, so nobody's view jumps. It carries the tilt meter and any lock over too. `scripts/e2e-remote.mjs` checks this: 194 bodies before the host left, 194 after.

## 3. Input (`src/input/`)
- **Aim** comes from gravity across the phone's short axis (`rollDeg`). It works the same whether you hold the phone flat and pointing forward, or upright like a steering wheel. A **35° roll** turns the chute fully (±30°).
- **Flick (drop)**: any jerk of **≥13 m/s²** while holding the pad. Its strength sets how far the coin flies.
  - The coin goes where you were aiming **120 ms before** the flick, because the flick itself tips the phone.
  - The roll *rate* just before the flick sets the coin's **spin** (±300°/s is full), so it lands tilted and skids or rolls.
- **Shake**: with the pad released, a jerk of **≥12 m/s²** where at least 60% points **up**, using the gravity estimate to find "up".
- **Without motion** (desktops, Discord):
  - Drag sideways on the pad to aim, and let go to drop. Swipe up to throw further.
  - **SHAKE** button.
  - Keys: ←/→ aim, Space drops, S shakes.
  - Or pair a phone (§4).

## 4. Phone remote
Discord doesn't let Activities read motion sensors, so any phone can play for a seat. See [PHONE-REMOTE.md](PHONE-REMOTE.md). A remote can only ask for the state, aim, drop and shake for the player it's paired with.

## 5. Networking & platform
Unchanged from the roulette game, apart from the messages:
- `aim` is the only message a non-host may broadcast. It's cosmetic and rate-limited by both transports.
- `drop` and `shake` go to the host.
- `frame` comes from the host.

The host-authoritative star, host migration, the PeerJS and relay transports, Discord room tickets, and stale-host eviction are the same code.

## 6. Configuration

| Name | Where | Value |
|---|---|---|
| `VITE_DISCORD_CLIENT_ID` | `.env.production` | **Empty until the Discord app is created** |
| `DISCORD_CLIENT_ID` | `wrangler.jsonc` vars | Same |
| `DISCORD_CLIENT_SECRET` | `wrangler secret put` | From the Developer Portal |
| `VITE_PUBLIC_ORIGIN` | `.env.production` | `https://coinpusher.housetandem.com` (where phones open the remote from inside Discord) |

## 7. Ideas not in v1 (need a design decision first)
- Different prizes, bonus pockets or power-up coins; levels or a prize "collection".
- A practice / calibrate page like roulette's, if the flick or shake thresholds need tuning per person.
- Haptic feedback on iPhone (web pages can't vibrate there).
