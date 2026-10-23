import type { GameState } from "./game/dozer";
import { COIN_OPTIONS, DEFAULT_COINS } from "./game/rules";
import type { Player } from "./net/protocol";
import type { TransportStatus } from "./net/transport";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { className?: string; text?: string } = {}, ...children: Node[]) {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  node.append(...children);
  return node;
}

export const fmt = (n: number) => n.toLocaleString("en-US");

export type View = {
  players: Player[];
  game: GameState;
  selfId: string;
  hostId: string | null;
  isHost: boolean;
};

export type UIHandlers = {
  start: (coinsEach: number) => void;
  rematch: () => void;
  shake: () => void;
  enableMotion: () => void;
  toggleMute: () => boolean;
  copyInvite: () => Promise<void>;
  /** Open the phone-remote sheet (📱). */
  openRemote: () => void;
  remoteOpenHere: () => void;
  remoteNewLink: () => void;
  remoteUnpair: () => void;
};

/** The pairing sheet's contents. See PHONE-REMOTE.md. */
export type PairView = {
  link: string;
  qrSvg: string;
  why: string;
  /** Show "Open on this phone" (Discord on a phone). */
  canOpenHere: boolean;
  paired: boolean;
  online: boolean;
};

/**
 * What the pad shows:
 * - "play": yours to aim and drop (`motion` says which gestures)
 * - "phone": your paired phone plays; the pad explains
 * - "empty": out of coins
 * - "locked": TILT
 * - "hidden": no game on
 */
export type ZoneState = "play" | "phone" | "empty" | "locked" | "hidden";

export type Tone = "win" | "prize" | "tilt" | "shake" | "plain";

export class UI {
  readonly zone = $("zone");
  private hintTimer: ReturnType<typeof setTimeout> | undefined;
  private calloutTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    handlers: UIHandlers,
    muted: boolean,
  ) {
    const coins = $<HTMLSelectElement>("coins-each");
    for (const n of COIN_OPTIONS) coins.append(new Option(String(n), String(n), n === DEFAULT_COINS, n === DEFAULT_COINS));
    $("start").addEventListener("click", () => handlers.start(Number(coins.value)));
    $("rematch").addEventListener("click", () => handlers.rematch());
    $("shake-btn").addEventListener("click", () => handlers.shake());
    $("enable-motion").addEventListener("click", () => handlers.enableMotion());
    const mute = $("mute");
    const paintMute = (m: boolean) => {
      mute.textContent = m ? "🔇" : "🔊";
      mute.setAttribute("aria-label", m ? "Unmute sounds" : "Mute sounds");
    };
    paintMute(muted);
    mute.addEventListener("click", () => paintMute(handlers.toggleMute()));
    $("copy-invite").addEventListener("click", async () => {
      const btn = $("copy-invite");
      try {
        await handlers.copyInvite();
        btn.textContent = "Copied!";
      } catch {
        btn.textContent = "Copy failed";
      }
      setTimeout(() => (btn.textContent = "Copy invite"), 1600);
    });
    $("remote-btn").addEventListener("click", () => handlers.openRemote());
    $("use-phone").addEventListener("click", () => handlers.openRemote());
    $("lobby-phone").addEventListener("click", () => handlers.openRemote());
    $("pair-open").addEventListener("click", () => handlers.remoteOpenHere());
    $("pair-new").addEventListener("click", () => handlers.remoteNewLink());
    $("pair-unpair").addEventListener("click", () => handlers.remoteUnpair());
    $("pair-close").addEventListener("click", () => this.hidePair());
    $("pair").addEventListener("click", (e) => e.target === $("pair") && this.hidePair());
    $("pair-copy").addEventListener("click", () => this.copyPairLink());
  }

  askName(initial: string): Promise<string> {
    const layer = $("name-prompt");
    const input = $<HTMLInputElement>("name-input");
    input.value = initial;
    layer.hidden = false;
    setTimeout(() => input.focus(), 50);
    return new Promise((resolve) => {
      $("name-form").addEventListener(
        "submit",
        (e) => {
          e.preventDefault();
          const name = input.value.trim() || "Player";
          this.removeNamePrompt();
          resolve(name);
        },
        { once: true },
      );
    });
  }

  /**
   * Take the name field out of the page for good. iOS "Shake to Undo" offers
   * to undo typing in any text field still in the document, which pops up
   * when a player flicks or shakes their phone.
   */
  removeNamePrompt() {
    const input = document.getElementById("name-input");
    if (input === document.activeElement) (input as HTMLInputElement).blur();
    document.getElementById("name-prompt")?.remove();
  }

  setRoom(code: string, showInvite: boolean) {
    $("room-code").textContent = code.length > 8 ? code.slice(0, 6) + "…" : code;
    $("copy-invite").hidden = !showInvite;
  }

  render(v: View) {
    const { game, players, selfId } = v;
    const byId = new Map(players.map((p) => [p.id, p]));
    const playing = game.phase === "playing";

    $("players").replaceChildren(
      ...game.order
        .map((id) => byId.get(id))
        .filter((p): p is Player => !!p)
        .map((p) => {
          const coins = game.coins[p.id] ?? 0;
          const li = el("li", { className: "player" + (playing && coins === 0 ? " out" : "") });
          li.style.setProperty("--pc", p.color);
          li.append(avatar(p), el("span", { className: "name", text: p.id === selfId ? `${p.name} (you)` : p.name }));
          if (p.remoteId) {
            const badge = el("span", { className: "remote-badge" + (p.remoteOnline ? " online" : ""), text: "📱" });
            badge.title = p.remoteOnline ? "Playing with their phone" : "Phone remote offline";
            li.append(badge);
          }
          if (game.phase !== "lobby") li.append(el("span", { className: "score", text: String(coins) }), el("span", { className: "coin-icon small", text: "" }));
          return li;
        }),
    );

    $("hud").hidden = !playing;
    if (playing) {
      $("score").textContent = fmt(game.score);
      $("score-sub").textContent = `${game.prizes} prize${game.prizes === 1 ? "" : "s"} · ${game.coinsWon} coins back`;
    }
    $("my-coins").textContent = String(game.coins[selfId] ?? 0);

    $("lobby").hidden = game.phase !== "lobby";
    if (game.phase === "lobby") {
      $("lobby-players").replaceChildren(...players.map((p) => playerRow(p, p.id === v.hostId ? "host" : p.id === selfId ? "you" : "")));
      $("host-controls").hidden = !v.isHost;
      $("lobby-wait").hidden = v.isHost;
    }

    const over = game.phase === "over";
    $("game-over").hidden = !over;
    if (over) {
      $("final-score").textContent = `${fmt(game.score)} points!`;
      const best = bestScore(game.score);
      $("final-sub").textContent = best.isNew && game.score > 0 ? "A new best for this device!" : `Best on this device: ${fmt(best.best)}`;
      $("final-stats").replaceChildren(
        statRow("🎁 Prizes won", fmt(game.prizes)),
        statRow("🪙 Coins dropped", fmt(game.dropped)),
        statRow("✨ Coins back in the tray", fmt(game.coinsWon)),
        statRow("🕳️ Lost over the sides", fmt(game.coinsLost)),
      );
      $("rematch").hidden = !v.isHost;
      $("rematch-wait").hidden = v.isHost;
    }
  }

  setTilt(tilt: number, locked: boolean) {
    const fill = $("tilt-fill");
    fill.style.width = `${Math.max(0, Math.min(100, tilt))}%`;
    fill.classList.toggle("hot", tilt > 65);
    $("hud").classList.toggle("locked", locked);
  }

  setZone(state: ZoneState, opts: { color?: string; motion?: boolean; phoneOnline?: boolean; why?: string } = {}) {
    const zone = this.zone;
    zone.hidden = state === "hidden";
    zone.className = `zone ${state}`;
    if (opts.color) zone.style.setProperty("--pc", opts.color);
    $("shake-btn").hidden = state !== "play" && state !== "empty";
    const title = zone.querySelector(".zone-title")!;
    const sub = zone.querySelector(".zone-sub")!;
    if (state === "play") {
      title.textContent = opts.motion ? "HOLD · ROLL · FLICK" : "DRAG TO AIM · RELEASE";
      sub.textContent = opts.motion
        ? "Hold here, roll your wrist to aim, flick to drop. Let go and jerk up to shake."
        : "Drag sideways to aim, let go to drop (swipe up to throw further). Keys: ← → Space S";
    } else if (state === "phone") {
      title.textContent = opts.phoneOnline ? "PLAY WITH YOUR PHONE" : "YOUR CHUTE";
      sub.textContent = opts.phoneOnline ? "Roll it to aim, flick to drop, jerk it up to shake" : (opts.why ?? "");
    } else if (state === "empty") {
      title.textContent = "OUT OF COINS";
      sub.textContent = "Coins pushed into the tray in front of your chute come back to you. Keep shaking!";
    } else if (state === "locked") {
      title.textContent = "TILT!";
      sub.textContent = "The shelf is locked. Hands off for a moment…";
    }
  }

  setHolding(holding: boolean) {
    this.zone.classList.toggle("holding", holding);
  }

  showEnableMotion(show: boolean) {
    $("enable-motion").hidden = !show;
  }

  showRemoteButton(show: boolean) {
    $("remote-btn").hidden = !show;
  }

  /** Offer pairing up front in the lobby where there's no motion. */
  showLobbyPhone(show: boolean) {
    $("lobby-phone").hidden = !show;
  }

  get pairOpen() {
    return !$("pair").hidden;
  }

  showPair(v: PairView) {
    $("pair-why").textContent = v.why;
    // uqr renders a plain <svg> of rects from our own link; nothing user-supplied.
    $("pair-qr").innerHTML = v.qrSvg;
    $("pair-link").textContent = v.link;
    $("pair-open").hidden = !v.canOpenHere;
    $("pair-unpair").hidden = !v.paired;
    const status = $("pair-status");
    status.textContent = v.online ? "✅ Phone connected. Play with it!" : "Waiting for your phone… Scan the code with its camera.";
    status.classList.toggle("ok", v.online);
    $("pair").hidden = false;
  }

  openPair() {
    $("pair").hidden = false;
  }

  hidePair() {
    $("pair").hidden = true;
  }

  /** The clipboard is blocked in the Discord iframe; fall back to selecting the link for a manual copy. */
  private async copyPairLink() {
    const link = $("pair-link");
    const btn = $("pair-copy");
    try {
      await navigator.clipboard.writeText(link.textContent ?? "");
      btn.textContent = "Copied!";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(link);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      btn.textContent = "Selected — copy it";
    }
    setTimeout(() => (btn.textContent = "Copy link"), 2000);
  }

  hint(text: string, ms = 2400) {
    const h = $("hint");
    h.textContent = text;
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => (h.textContent = ""), ms);
  }

  callout(main: string, sub: string, tone: Tone, ms = 1800) {
    const c = $("callout");
    c.querySelector(".callout-main")!.textContent = main;
    c.querySelector(".callout-sub")!.textContent = sub;
    c.className = `callout ${tone}`;
    void c.offsetWidth; // restart the animation
    c.classList.add("show");
    clearTimeout(this.calloutTimer);
    this.calloutTimer = setTimeout(() => c.classList.remove("show"), ms);
  }

  status(s: TransportStatus | null, relayLink?: string) {
    const box = $("status");
    box.className = "status";
    box.replaceChildren();
    if (!s || s.kind === "connected") {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    if (s.kind === "connecting") box.textContent = "Connecting to the machine…";
    else if (s.kind === "reconnecting") box.textContent = "Connection lost — reconnecting…";
    else {
      box.classList.add("error");
      box.append(s.reason);
      if (relayLink) {
        const a = el("a", { text: "Use the relay instead" });
        a.href = relayLink;
        box.append(" ", a);
      }
    }
  }

  fatal(message: string) {
    this.status({ kind: "failed", reason: message });
    this.setZone("hidden");
  }
}

const BEST_KEY = "dozer.best";
let bestCache: { score: number; result: { best: number; isNew: boolean } } | null = null;

/** The best team score on this device, updated with `score`. Stable across re-renders of the same result. */
function bestScore(score: number): { best: number; isNew: boolean } {
  if (bestCache?.score === score) return bestCache.result;
  let best = 0;
  try {
    best = Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    // storage unavailable
  }
  const isNew = score > best;
  if (isNew) {
    try {
      localStorage.setItem(BEST_KEY, String(score));
    } catch {
      // storage unavailable
    }
  }
  const result = { best: Math.max(best, score), isNew };
  bestCache = { score, result };
  return result;
}

function avatar(p: Player): HTMLElement {
  if (p.avatarUrl) {
    const img = el("img", { className: "avatar" });
    img.alt = "";
    img.src = p.avatarUrl;
    img.referrerPolicy = "no-referrer";
    img.onerror = () => img.replaceWith(initialBadge(p));
    return img;
  }
  return initialBadge(p);
}

function initialBadge(p: Player): HTMLElement {
  const span = el("span", { className: "avatar", text: (p.name.trim()[0] ?? "?").toUpperCase() });
  span.style.setProperty("--pc", p.color);
  return span;
}

function playerRow(p: Player, tag: string): HTMLElement {
  const li = el("li");
  li.style.setProperty("--pc", p.color);
  li.append(el("span", { className: "swatch" }), el("span", { className: "grow", text: p.name }), el("span", { className: "muted", text: tag }));
  return li;
}

function statRow(label: string, value: string): HTMLElement {
  const li = el("li");
  li.append(el("span", { className: "grow", text: label }), el("span", { className: "score", text: value }));
  return li;
}
