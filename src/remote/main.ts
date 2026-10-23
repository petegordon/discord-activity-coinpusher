import "./remote.css";
import { CoinAudio } from "../audio";
import { createGame, type GameState } from "../game/dozer";
import { CoinController } from "../input/controller";
import { playerIdFromKey } from "../net/identityKey";
import { PeerJsTransport } from "../net/peerjs";
import { peerOptions } from "../net/peerOptions";
import type { Player } from "../net/protocol";
import { RelayTransport } from "../net/relay";
import { Room } from "../net/room";
import type { TransportStatus } from "../net/transport";
import { apiBase, debug } from "../platform/env";
import { fmt } from "../ui";
import { parseRemoteLink } from "./link";

/**
 * The phone remote: a phone browser tab that aims, drops and shakes for a
 * seat at a machine running elsewhere (Discord, a desktop). See PHONE-REMOTE.md.
 */

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function message(title: string, text: string, retry = false) {
  $("r-msg-title").textContent = title;
  $("r-msg-text").textContent = text;
  $("r-retry").hidden = !retry;
  $("r-message").hidden = false;
}

/** The key arrives in the link's fragment; keep it for refreshes, then take it out of the address bar. */
function remoteKey(room: string, fromLink: string | null): string | null {
  const storageKey = `dozer.remote.${room}`;
  try {
    if (fromLink) sessionStorage.setItem(storageKey, fromLink);
    else fromLink = sessionStorage.getItem(storageKey);
  } catch {
    // storage unavailable; a refresh will need the link again
  }
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  return fromLink;
}

function boot() {
  const params = parseRemoteLink(location.href);
  const key = params ? remoteKey(params.room, params.key) : null;
  $("r-retry").addEventListener("click", () => location.reload());
  if (!params || !key) {
    $("r-start").hidden = true;
    message("Scan the code at the machine", "Open the game, tap 📱, and scan the code with this phone's camera.");
    return;
  }

  const zone = $("zone");
  const audio = new CoinAudio();
  const paintMute = () => ($("r-mute").textContent = audio.muted ? "🔇" : "🔊");
  paintMute();
  $("r-mute").addEventListener("click", () => {
    audio.setMuted(!audio.muted);
    audio.unlock();
    paintMute();
  });
  document.addEventListener("pointerdown", () => audio.unlock(), { capture: true });
  let room: Room | null = null;
  let selfId = "";
  let players: Player[] = [];
  let game: GameState = createGame();
  let gotState = false;
  let locked = false;
  let tilt = 0;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;

  const hint = (text: string) => {
    $("r-hint").textContent = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => ($("r-hint").textContent = ""), 2400);
  };
  const me = () => players.find((p) => p.remoteId === selfId);
  const myCoins = () => {
    const m = me();
    return m ? (game.coins[m.id] ?? 0) : 0;
  };

  // The chute's aim, drawn on the phone so you can see where it points.
  const needle = $("r-needle");
  const paintAim = (aimRad: number) => (needle.style.transform = `rotate(${(aimRad * 180) / Math.PI}deg)`);

  // Declared first: the controller reports its motion state (and so renders) while it's being constructed.
  let controller: CoinController | null = null;
  controller = new CoinController(
    zone,
    {
      onAim: (aim) => {
        room?.aim(aim);
        paintAim(aim);
      },
      onDrop: (d) => {
        if (myCoins() === 0) {
          hint("Out of coins! Jerk the phone up to shake.");
          return;
        }
        audio.drop();
        paintAim(d.aim);
        room?.drop(d.aim, d.power, d.spin);
      },
      onShake: () => {
        if (game.phase !== "playing" || locked) return;
        room?.shake();
        hint("Shake!");
      },
      onHint: hint,
      onHoldChange: (holding) => zone.classList.toggle("holding", holding),
      onMotionState: () => render(),
    },
    null,
  );

  function renderMe(p: Player | undefined) {
    const box = $("r-me");
    box.replaceChildren();
    if (!p) return;
    box.style.setProperty("--pc", p.color);
    let av: HTMLElement;
    if (p.avatarUrl) {
      const img = document.createElement("img");
      img.src = p.avatarUrl;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      av = img;
    } else {
      av = document.createElement("span");
      av.textContent = (p.name.trim()[0] ?? "?").toUpperCase();
    }
    av.className = "avatar";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = p.name;
    box.append(av, name);
  }

  function render() {
    const mine = me();
    renderMe(mine);
    if (gotState && !mine) {
      message("This link isn't active", "Tap 📱 at the machine and scan the new code. This page will pick it up if the link comes back.");
    } else {
      $("r-message").hidden = true;
    }
    const playing = game.phase === "playing";
    controller?.setEnabled(!!mine && playing && !locked);
    if (mine) zone.style.setProperty("--pc", mine.color);
    $("r-coins").textContent = String(myCoins());
    $("r-score").textContent = playing || game.phase === "over" ? `Team ${fmt(game.score)}` : "";
    $<HTMLElement>("r-tilt-fill").style.width = `${tilt}%`;
    $("r-tilt").classList.toggle("locked", locked);
    $("r-shake").hidden = !playing;

    const title = zone.querySelector(".zone-title")!;
    const sub = zone.querySelector(".zone-sub")!;
    const motion = controller?.motion === "active";
    zone.className = "r-pad" + (playing && !locked ? " mine" : " waiting") + (zone.classList.contains("holding") ? " holding" : "");
    if (!gotState) {
      title.textContent = "Connecting…";
      sub.textContent = "";
    } else if (game.phase === "lobby") {
      title.textContent = "Waiting for the game";
      sub.textContent = "The host starts it at the machine";
    } else if (game.phase === "over") {
      title.textContent = `🎪 ${fmt(game.score)} points`;
      sub.textContent = "Play again from the machine";
    } else if (locked) {
      title.textContent = "TILT!";
      sub.textContent = "Hands off for a moment…";
    } else if (myCoins() === 0) {
      title.textContent = "OUT OF COINS";
      sub.textContent = "Jerk the phone up to shake coins your way";
    } else {
      title.textContent = motion ? "HOLD · ROLL · FLICK" : "DRAG · RELEASE";
      sub.textContent = motion ? "Hold, roll your wrist to aim, flick to drop. Let go and jerk up to shake." : "Drag sideways to aim, let go to drop";
    }
  }

  function status(s: TransportStatus) {
    const conn = $("r-conn");
    conn.classList.toggle("ok", s.kind === "connected");
    conn.textContent = s.kind === "connected" ? "Connected" : s.kind === "failed" ? "Offline" : s.kind === "reconnecting" ? "Reconnecting…" : "Connecting…";
    if (s.kind === "failed") message("Couldn't reach the machine", `${s.reason} Make sure the game is still open.`, true);
  }

  /** Keep the screen on while connected. The browser drops the lock whenever the page is hidden. */
  async function keepAwake() {
    try {
      await navigator.wakeLock?.request("screen");
    } catch {
      // not supported, or the page isn't visible
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && room) void keepAwake();
  });
  $("r-shake").addEventListener("click", () => {
    if (game.phase === "playing" && !locked) room?.shake();
  });

  async function connect() {
    selfId = await playerIdFromKey(key!);
    const transport =
      params!.transport === "relay"
        ? new RelayTransport(params!.room, selfId, key!, apiBase, { role: "remote" })
        : new PeerJsTransport(params!.room, selfId, key!, await peerOptions(), "remote");
    const r = new Room(transport, { id: selfId, key: key!, name: "remote" }, Date.now, "remote");
    room = r;
    r.on("status", status);
    r.on("state", (p, g) => {
      players = p;
      game = g;
      gotState = true;
      render();
    });
    r.on("frame", (f) => {
      tilt = f.tilt;
      const was = locked;
      locked = f.locked > 0;
      const mine = me();
      const lane = mine ? game.order.indexOf(mine.id) : -1;
      for (const e of f.events) {
        if (e.k === "won" && e.lane === lane) {
          audio.won(1);
          hint("+1 coin");
        } else if (e.k === "prize") {
          audio.prize(e.points);
          hint(`🎁 +${e.points}!`);
          if ("vibrate" in navigator) navigator.vibrate([60, 40, 120]);
        } else if (e.k === "shake" && mine && e.by.includes(mine.id)) {
          audio.shake(e.strength);
          if (e.by.length >= 2) hint("TOGETHER!");
        } else if (e.k === "tilt") {
          audio.tilt();
          if ("vibrate" in navigator) navigator.vibrate([200, 100, 200]);
        }
      }
      if (was !== locked || f.events.length) render();
      else {
        $<HTMLElement>("r-tilt-fill").style.width = `${tilt}%`;
      }
    });
    if (debug) Object.assign(window, { dozer: { room: r, self: { id: selfId }, controller } });
    addEventListener("pagehide", () => r.leave());
    try {
      await r.join();
    } catch {
      // status() already explained
    }
  }

  (window as { __dozerLoaded?: () => void }).__dozerLoaded?.(); // see public/boot-guard.js
  $("r-connect").addEventListener("click", () => {
    // iOS only grants motion from inside a tap, so ask before anything async.
    if (controller?.motion === "needs-permission") void controller.requestMotionPermission();
    $("r-start").hidden = true;
    audio.unlock();
    void keepAwake();
    render();
    void connect();
  });
  render();
}

boot();
