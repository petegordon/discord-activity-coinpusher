# Phone Remote

Use a phone's browser to play your seat at a machine running somewhere motion can't reach: a Discord Activity, a desktop browser, or a device without motion sensors.

This is the dice game's [Shaker Remote](https://github.com/petegordon/discord-activity-dice/blob/main/SHAKER-REMOTE.md) and roulette's Spinner Remote with the gestures swapped. The design and security model are the same, and the dice document has the full reasoning.

## Why

Discord runs Activities in a cross-origin iframe that isn't delegated the `accelerometer` and `gyroscope` Permissions Policy features. So `devicemotion` never fires there, and a frame can't turn it back on. A phone's own browser tab is a top-level page, so motion works there.

## At the table

- **📱** (top right), **Play with your phone** in the lobby, or the button under the pad opens a sheet. The sheet has:
  - a QR code, made locally with `uqr`
  - the full link and **Copy link**
  - **Open on this phone**, in Discord on a phone (`openExternalLink`)
- Once the phone connects, everyone sees a 📱 badge on your name and the sheet closes. The pad then says **PLAY WITH YOUR PHONE**.
- **New link** revokes the old one. **Unpair** stops using the phone.

## On the phone (`/remote`)

- Tap **Tap to connect**. This also asks for motion permission on iPhone, from inside the tap.
- **Hold the pad and roll your wrist** to aim your chute. A needle on the phone shows where it points, and your chute turns on the big screen.
- **Flick** to drop a coin.
- **Let go and jerk the phone up** to shake the shelf. There's also a **SHAKE** button.
- The phone shows your coins, the team score and the tilt meter. It plays the sounds for your coins coming back, prizes and TILT.
- It keeps the screen awake while connected.

## Identity, pairing, and what a remote may do

- The table makes a random key, and the remote's id is derived from it (`src/net/identityKey.ts`). The key travels in the link's `#` fragment, which browsers never send to servers. The remote then moves it to `sessionStorage` and out of the address bar.
- The host binds the remote id to the player (`pair` / `unpair`). A remote belongs to one player at a time.
- A remote can only do four things:
  - ask for the state (`remote-hello`)
  - `aim` (cosmetic, shown as its player's)
  - `drop`
  - `shake`

  The last two count for its player. It can't join as a player or become host. Both transports mark remote connections, so the sender can't claim to be one.
- Anyone with the link can play your coins, so the sheet warns not to show the code on a stream.

## Tests

`scripts/e2e-remote.mjs` (relay and PeerJS) checks four things:
1. A remote that connects before anyone is at the table never becomes host.
2. Bob pairs a phone from the lobby. The phone's synthetic motion does three things, all credited to Bob:
   - rolling 30° turns his chute, as seen on Alice's screen
   - a flick drops his coin
   - an upward jerk shakes the shelf
3. The host leaves. Bob takes over, the shelf carries over intact, and his phone keeps dropping.
4. **New link** makes the old phone link stop working.
