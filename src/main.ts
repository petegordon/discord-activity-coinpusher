import "./style.css";
import { renderSVG } from "uqr";
import { CoinAudio } from "./audio";
import { createGame, type GameState } from "./game/dozer";
import { CoinController } from "./input/controller";
import { newIdentity } from "./net/identityKey";
import { PeerJsTransport } from "./net/peerjs";
import { peerOptions } from "./net/peerOptions";
import type { Player } from "./net/protocol";
import { RelayTransport } from "./net/relay";
import { Room, type Self } from "./net/room";
import type { Transport } from "./net/transport";
import { startDiscord, type DiscordSession } from "./platform/discord";
import { apiBase, debug, inDiscord, transportChoice } from "./platform/env";
import { inviteLink, standaloneRoom, storedName, storeName } from "./platform/identity";
import { remoteLink } from "./remote/link";
import { DozerScene } from "./render/scene";
import type { Frame } from "./sim/frame";
import { UI } from "./ui";

/** Don't re-send a pairing the host hasn't reflected yet more often than this. */
const REPAIR_MS = 3_000;

async function boot() {
  const audio = new CoinAudio();
  const transportKind = transportChoice();
  let roomId = "";
  let room: Room | null = null;
  let controller: CoinController | null = null;
  let discord: DiscordSession | null = null;
  /** Our phone remote's identity, once the 📱 sheet has been opened. */
  let remote: { id: string; key: string; sentAt: number } | null = null;

  const ui = new UI(
    {
      start: (coins) => room?.start(coins),
      rematch: () => room?.rematch(),
      shake: () => shake(),
      enableMotion: async () => {
        const ok = await controller?.requestMotionPermission();
        ui.showEnableMotion(false);
        ui.hint(ok ? "Motion on: hold, roll and flick!" : "Motion isn't available here. Drag and release instead.");
        refresh();
      },
      toggleMute: () => {
        audio.setMuted(!audio.muted);
        audio.unlock();
        return audio.muted;
      },
      copyInvite: () => navigator.clipboard.writeText(inviteLink(roomId, transportKind)),
      openRemote: () => void openRemote(false),
      remoteNewLink: () => void openRemote(true),
      remoteUnpair: () => {
        room?.unpair();
        remote = null;
        ui.hidePair();
      },
      remoteOpenHere: () => {
        if (remote) void discord?.openExternal(remoteLink(roomId, transportKind, remote.key)).catch(() => {});
      },
    },
    audio.muted,
  );
  document.addEventListener("pointerdown", () => audio.unlock(), { capture: true });
  document.addEventListener("keydown", () => audio.unlock(), { capture: true });

  // Keep the cabinet in the space above the pad.
  const footer = document.querySelector<HTMLElement>(".bottom")!;
  new ResizeObserver(() => document.documentElement.style.setProperty("--footer-h", `${footer.offsetHeight}px`)).observe(footer);
  const scene = new DozerScene(document.getElementById("stage")!);

  // ---- identity & room ----
  let self: Self;
  if (inDiscord) {
    try {
      discord = await startDiscord();
      ({ self, roomId } = discord);
    } catch (err) {
      ui.fatal(`Couldn't connect to Discord: ${(err as Error).message}`);
      return;
    }
  } else {
    roomId = standaloneRoom();
    let name = storedName();
    if (!name) {
      name = await ui.askName("");
      storeName(name);
      // iOS "Shake to Undo" keeps offering to undo the name typing even after the field is gone,
      // and pops up on every flick and shake. A reload (same room, name now saved) starts a page
      // with no typing history. Skipped if storage doesn't work, so it can't loop.
      if (storedName() === name) {
        location.reload();
        return;
      }
    }
    self = { ...(await newIdentity()), name };
  }
  ui.removeNamePrompt(); // no-op if already gone
  ui.setRoom(roomId, !inDiscord);
  // Discord lists the Terms and Privacy links on the app's own page; plain links can't leave the Activity frame.
  document.getElementById("legal-links")!.hidden = inDiscord;

  ui.status({ kind: "connecting" });
  const transport: Transport =
    transportKind === "relay"
      ? new RelayTransport(roomId, self.id, self.key, apiBase, { ticket: self.ticket })
      : new PeerJsTransport(roomId, self.id, self.key, await peerOptions());
  room = new Room(transport, self);
  const r = room;

  let players: Player[] = [];
  let game: GameState = createGame();
  let locked = false;

  const me = () => players.find((p) => p.id === self.id);
  const playing = () => game.phase === "playing";
  const myCoins = () => game.coins[self.id] ?? 0;
  /** Our paired phone is connected to the table right now. */
  const remoteOnline = () => !!remote && me()?.remoteId === remote.id && !!me()?.remoteOnline;
  let remoteWasOnline = false;

  function remoteWhy() {
    if (controller?.motion === "blocked" && inDiscord) {
      return "Discord doesn't let Activities read motion sensors. Scan this with your phone's camera to aim, flick and shake with it.";
    }
    if (controller?.motionOff) return "Scan this with your phone's camera to aim, flick and shake with it.";
    return "Scan this with another phone to play with it, handy with this device on a stand.";
  }

  function paintPair() {
    if (!remote || !ui.pairOpen) return;
    const link = remoteLink(roomId, transportKind, remote.key);
    ui.showPair({
      link,
      qrSvg: renderSVG(link, { ecc: "M", border: 1 }),
      why: remoteWhy(),
      canOpenHere: !!discord?.mobile,
      paired: me()?.remoteId === remote.id,
      online: remoteOnline(),
    });
  }

  /** Show the 📱 sheet, pairing a new remote first if we have none (or `fresh` asks for a new link). */
  async function openRemote(fresh: boolean) {
    if (!room) return;
    if (fresh || !remote) {
      const { id, key } = await newIdentity();
      remote = { id, key, sentAt: Date.now() };
      room.pair(id);
    }
    ui.openPair();
    paintPair();
  }

  /** The host may have lost our pairing (e.g. we were dropped and rejoined); quietly re-send it. */
  function keepPaired() {
    const mine = me();
    if (!remote || !mine || mine.remoteId === remote.id || Date.now() - remote.sentAt < REPAIR_MS) return;
    remote.sentAt = Date.now();
    r.pair(remote.id);
  }

  function shake() {
    if (!playing() || locked) return;
    audio.unlock();
    r.shake();
  }

  function refresh() {
    ui.render({ players, game, selfId: self.id, hostId: r.hostId, isHost: r.isHost });
    const phone = remoteOnline();
    controller?.setEnabled(playing() && !locked && !phone);
    ui.showLobbyPhone(!!controller?.motionOff && !phone);
    const color = me()?.color;
    if (!playing()) ui.setZone("hidden");
    else if (locked) ui.setZone("locked", { color });
    else if (phone) ui.setZone("phone", { color, phoneOnline: true });
    else if (myCoins() === 0) ui.setZone("empty", { color });
    else ui.setZone("play", { color, motion: controller?.motion === "active" });
    // No motion here (Discord, desktops): offer the phone. The pad still works by dragging.
    document.getElementById("use-phone")!.hidden = !(playing() && !!controller?.motionOff && !phone);
    ui.showEnableMotion(playing() && !phone && controller?.motion === "needs-permission");
  }

  controller = new CoinController(ui.zone, {
    onAim: (aim) => {
      scene.setAim(self.id, aim);
      r.aim(aim);
    },
    onDrop: (d) => {
      if (!playing() || locked) return;
      if (myCoins() === 0) {
        ui.hint("Out of coins! Shake the shelf to win some back.");
        return;
      }
      audio.drop();
      scene.setAim(self.id, d.aim);
      r.drop(d.aim, d.power, d.spin);
    },
    onShake: () => shake(),
    onHint: (text) => ui.hint(text),
    onHoldChange: (holding) => ui.setHolding(holding),
    onMotionState: () => refresh(),
  });

  function onEvents(f: Frame) {
    const mine = game.order.indexOf(self.id);
    let wonHere = 0;
    for (const e of f.events) {
      switch (e.k) {
        case "drop":
          scene.dropped(e.by);
          if (e.by !== self.id) audio.clink(0.3);
          break;
        case "won":
          scene.burst("coin", e.x);
          audio.won(1);
          if (e.lane === mine) wonHere++;
          break;
        case "lost":
          scene.burst("lost", e.x);
          audio.lost();
          break;
        case "prize":
          scene.burst("prize", e.x);
          audio.prize(e.points);
          ui.callout(`+${e.points}`, "Prize in the tray!", "prize", 2200);
          if ("vibrate" in navigator) navigator.vibrate([60, 40, 120]);
          break;
        case "prize-lost":
          audio.lost();
          ui.hint("A prize fell over the side…");
          break;
        case "shake": {
          scene.shake(e.strength);
          audio.shake(e.strength);
          const names = e.by.map((id) => players.find((p) => p.id === id)?.name ?? "Someone");
          if (e.by.length >= 2) ui.callout("TOGETHER!", `${names.join(" + ")} shook the shelf`, "shake", 1400);
          else if (game.order.length > 1) ui.hint(`${e.by[0] === self.id ? "You" : names[0]} nudged the shelf. Shake together for a big one!`);
          break;
        }
        case "tilt":
          audio.tilt();
          ui.callout("TILT!", "Too much shaking. The shelf is locked.", "tilt", 2500);
          if ("vibrate" in navigator) navigator.vibrate([200, 100, 200]);
          break;
        case "unlock":
          audio.unlocked();
          ui.hint("Shelf unlocked!");
          break;
        case "tower":
          ui.hint("🎁 A new prize tower!");
          break;
      }
    }
    if (wonHere) ui.hint(`+${wonHere} coin${wonHere > 1 ? "s" : ""} back to you`);
  }

  r.on("state", (p, g) => {
    players = p;
    game = g;
    scene.setPlayers(g.order.map((id) => players.find((x) => x.id === id)).filter((x): x is Player => !!x));
    keepPaired();
    const online = remoteOnline();
    if (online !== remoteWasOnline) {
      ui.hint(online ? "📱 Phone connected. Play with it!" : "📱 Phone disconnected");
      if (online && ui.pairOpen) setTimeout(() => ui.hidePair(), 1200);
    }
    remoteWasOnline = online;
    paintPair();
    refresh();
  });

  r.on("frame", (f, delta) => {
    scene.frame(f, delta);
    ui.setTilt(f.tilt, f.locked > 0);
    const nowLocked = f.locked > 0;
    if (nowLocked !== locked) {
      locked = nowLocked;
      refresh();
    }
    if (f.events.length) onEvents(f);
  });

  r.on("aim", (player, aim) => {
    if (player !== self.id || remoteOnline()) scene.setAim(player, aim);
  });

  r.on("role", () => refresh());
  r.on("status", (s) => ui.showRemoteButton(s.kind === "connected"));
  r.on("status", (s) => ui.status(s, transportKind === "peerjs" && s.kind === "failed" ? inviteLink(roomId, "relay") : undefined));

  if (debug) Object.assign(window, { dozer: { room: r, scene, self, controller } });
  (window as { __dozerLoaded?: () => void }).__dozerLoaded?.(); // see public/boot-guard.js
  addEventListener("pagehide", () => r.leave());

  try {
    await r.join();
  } catch {
    // The status banner already explains what went wrong.
  }
}

void boot();
