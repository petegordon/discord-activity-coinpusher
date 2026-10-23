import { HostAuthority, type Carry, type Sim } from "../game/host";
import { createGame, type GameState } from "../game/dozer";
import { clampAim } from "../game/rules";
import { readFrame, unpackBodies, type Body, type Frame } from "../sim/frame";
import type { Envelope, Msg, Player, Role } from "./protocol";
import { Emitter, type Transport, type TransportStatus } from "./transport";

/** How long a player who disconnects (or a whole table after a host migration) has to come back before being dropped. */
export const RECONNECT_GRACE_MS = 8_000;
const PRUNE_CHECK_MS = 1_000;
/** Spacing between successive players' attempts to claim host. */
const SUCCESSION_STEP_MS = 1_500;
/** The host runs the shelf this often. */
const TICK_MS = 16;

export type RoomEvents = {
  state: (players: Player[], game: GameState) => void;
  /** A physics frame: the bodies it carried (`delta`) and every body's latest pose after applying it (`all`). */
  frame: (frame: Frame, delta: Body[], all: Map<number, Body>) => void;
  /** `player` is the player id, even when their phone remote sent it. */
  aim: (player: string, aim: number) => void;
  status: (status: TransportStatus) => void;
  role: (isHost: boolean) => void;
};

/**
 * `key` proves ownership of `id` (see identityKey.ts) and is never broadcast.
 * `ticket` admits a player to a Discord room on the relay (worker/src/roomTicket.ts).
 */
export type Self = { id: string; key: string; name: string; avatarUrl?: string; ticket?: string };

/** Loads the physics for a new host. Tests pass their own. */
export type SimFactory = () => Promise<Sim>;

const defaultSim: SimFactory = async () => (await import("../sim/world")).DozerSim.create();

/**
 * Glues a transport to the game. Whoever is host runs a HostAuthority (and
 * the physics) and broadcasts its results; everyone (host included) renders
 * from the same "state" and "frame" messages.
 *
 * With role "remote" this is a phone remote: it never joins as a player or
 * becomes host, and only aims, drops and shakes for the player it's paired with.
 */
export class Room {
  players: Player[] = [];
  game: GameState = createGame();
  hostId: string | null = null;
  /** Every body on the shelf, from the frames so far. */
  bodies = new Map<number, Body>();
  lastFrame: Frame | null = null;
  private authority: HostAuthority | null = null;
  private events = new Emitter<RoomEvents>();
  /** Host only: players we haven't heard from on the transport, and since when. */
  private missingSince = new Map<string, number>();
  private pruneTimer: ReturnType<typeof setInterval> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  /** Sim factory; replaceable by tests before joining. */
  makeSim: SimFactory = defaultSim;

  constructor(
    private readonly transport: Transport,
    readonly self: Self,
    private readonly now: () => number = Date.now,
    readonly role: Role = "player",
  ) {
    transport.on("message", (env) => this.onMessage(env));
    transport.on("host-change", (isHost) => this.onHostChange(isHost));
    transport.on("peers", (ids) => this.onPeers(ids));
    transport.on("status", (s) => this.events.emit("status", s));
    if ("successionDelay" in transport) {
      (transport as { successionDelay: () => number }).successionDelay = () => this.successionDelay();
    }
  }

  get isHost() {
    return this.authority !== null;
  }

  /** Host only: the authority (for tests and the debug hook). */
  get host() {
    return this.authority;
  }

  get transportKind() {
    return this.transport.kind;
  }

  on<K extends keyof RoomEvents>(event: K, cb: RoomEvents[K]) {
    this.events.on(event, cb);
  }

  join() {
    return this.transport.connect();
  }

  leave() {
    clearInterval(this.pruneTimer);
    clearInterval(this.tickTimer);
    this.transport.close();
  }

  start(coinsEach: number) {
    if (this.authority) this.broadcast(this.authority.start(coinsEach));
  }

  rematch() {
    if (this.authority) this.broadcast(this.authority.rematch());
  }

  /** Where our chute points, while aiming. */
  aim(aim: number) {
    this.transport.send({ t: "aim", aim }, "all");
  }

  drop(aim: number, power: number, spin: number) {
    this.request({ t: "drop", aim, power, spin });
  }

  shake() {
    this.request({ t: "shake" });
  }

  /** Make `remoteId` our phone remote (replacing any other). */
  pair(remoteId: string) {
    this.request({ t: "pair", remoteId });
  }

  unpair() {
    this.request({ t: "unpair" });
  }

  /** The player an id belongs to: the player themselves, or the one whose phone remote it is. */
  playerFor(id: string): Player | undefined {
    return this.players.find((p) => p.id === id || p.remoteId === id);
  }

  private request(msg: Msg) {
    if (this.role === "remote") this.transport.send(msg, "host");
    else if (this.authority) this.broadcast(this.authority.handle(this.self.id, msg));
    else this.transport.send(msg, "host");
  }

  /** Send to everyone else and apply locally, in that order. */
  private broadcast(msgs: Msg[]) {
    for (const msg of msgs) {
      this.transport.send(msg, "all");
      this.apply(msg);
    }
  }

  private apply(msg: Msg) {
    if (msg.t === "state") {
      this.players = msg.players;
      this.game = msg.game;
      this.hostId = msg.hostId;
      this.events.emit("state", msg.players, msg.game);
    } else if (msg.t === "frame") {
      const f = readFrame(msg.f);
      if (!f) return;
      // Frames can arrive out of order after a host change; ignore stale ones from the same host.
      if (this.lastFrame && f.gameId === this.lastFrame.gameId && f.seq <= this.lastFrame.seq && f.seq > this.lastFrame.seq - 1000) return;
      const bodies = unpackBodies(f.bodies);
      if (f.key) this.bodies.clear();
      for (const id of f.gone) this.bodies.delete(id);
      for (const b of bodies) this.bodies.set(b.id, b);
      this.lastFrame = f;
      this.events.emit("frame", f, bodies, this.bodies);
    }
  }

  private onMessage(env: Envelope) {
    const { msg } = env;
    if (msg.t === "aim") {
      const player = this.playerFor(env.from);
      if (player) this.events.emit("aim", player.id, clampAim(Number(msg.aim)));
      return;
    }
    if (env.to === "host") {
      if (this.authority) this.broadcast(this.authority.handle(env.from, msg, env.remote === true));
      return;
    }
    // Only the host broadcasts state and frames (transports enforce this too).
    if (!this.authority) this.apply(msg);
  }

  private carry(): Carry | undefined {
    const f = this.lastFrame;
    if (!f || !this.bodies.size || f.gameId !== this.game.gameId) return undefined;
    return { bodies: [...this.bodies.values()], time: f.ms / 1000, tilt: f.tilt, locked: f.locked };
  }

  private onHostChange(isHost: boolean) {
    if (this.role === "remote") {
      // Transports never make a remote the host; just ask whoever is for the state.
      this.transport.send({ t: "remote-hello" }, "host");
      this.events.emit("role", false);
      return;
    }
    clearInterval(this.tickTimer);
    if (isHost) {
      const authority = new HostAuthority({ selfId: this.self.id, now: this.now });
      const previousHost = this.hostId;
      if (this.players.length) {
        authority.restore(this.players, this.game);
        if (previousHost && previousHost !== this.self.id) authority.leave(previousHost);
        // Everyone else gets the grace period to find the new host.
        const t = this.now();
        for (const p of authority.players) if (p.id !== this.self.id) this.missingSince.set(p.id, t);
      }
      this.authority = authority;
      const carry = this.carry();
      void this.makeSim().then((sim) => {
        if (this.authority === authority) authority.attachSim(sim, carry);
      });
      clearInterval(this.pruneTimer);
      this.pruneTimer = setInterval(() => this.prune(), PRUNE_CHECK_MS);
      this.tickTimer = setInterval(() => this.authority === authority && this.broadcast(authority.tick()), TICK_MS);
      this.broadcast(authority.join(this.self.id, { name: this.self.name, avatarUrl: this.self.avatarUrl }));
    } else {
      this.authority = null;
      this.missingSince.clear();
      clearInterval(this.pruneTimer);
      this.transport.send({ t: "hello", player: { name: this.self.name, avatarUrl: this.self.avatarUrl } }, "host");
    }
    this.events.emit("role", isHost);
  }

  /** Host only: who is connected right now (players and remotes). Absent players are dropped after the grace period. */
  private onPeers(ids: string[]) {
    if (!this.authority) return;
    const present = new Set(ids);
    this.broadcast(this.authority.remotesOnline(present));
    const t = this.now();
    for (const p of this.authority.players) {
      if (p.id === this.self.id || present.has(p.id)) this.missingSince.delete(p.id);
      else if (!this.missingSince.has(p.id)) this.missingSince.set(p.id, t);
    }
  }

  /** Exposed for tests; runs every second on the host. */
  prune() {
    if (!this.authority) return;
    const t = this.now();
    const gone = [...this.missingSince].filter(([, since]) => t - since >= RECONNECT_GRACE_MS).map(([id]) => id);
    if (!gone.length) return;
    for (const id of gone) this.missingSince.delete(id);
    const keep = new Set(this.authority.players.map((p) => p.id).filter((id) => !gone.includes(id)));
    this.broadcast(this.authority.prune(keep));
  }

  /** PeerJS migration: claim host in join order, skipping the host that left. */
  private successionDelay(): number {
    const order = this.players
      .filter((p) => p.id !== this.hostId)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => p.id);
    const rank = order.indexOf(this.self.id);
    return (rank === -1 ? order.length : rank) * SUCCESSION_STEP_MS;
  }
}
