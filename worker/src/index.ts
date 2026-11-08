import { DurableObject } from "cloudflare:workers";
import { verifyPlayerKey } from "../../src/net/identityKey";
import { CLIENT_BROADCASTS, THROTTLED } from "../../src/net/protocol";
import { splitPeers, type Attachment } from "./peers";
import { DISCORD_ROOM_RE, discordRoom, readRoomTicket, roomTicket } from "./roomTicket";
import { RANGED_RE, withRanges } from "./ranges";
import { Scorekeeper, type GamesService } from "./scorekeeper";
import { recordPlaytime, type PlaytimeService } from "./playtime";
import { ACHIEVEMENTS } from "../../src/achievements/defs";

export interface Env {
  RELAY: DurableObjectNamespace<RelayRoom>;
  ASSETS: Fetcher;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET?: string;
  /** The House Tandem account service over RPC (wrangler.jsonc `services`). Without it, everyone is a guest. */
  HT?: HouseTandem;
  /** Optional Cloudflare Realtime TURN key, for NAT traversal of the PeerJS transport. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

/**
 * The House Tandem account service (Tandemonium's API Worker, entrypoint
 * HouseTandemGames): sign-in, gameProfile/recordGame for achievements, and
 * recordPlay for time in game (housetandem-web #37).
 */
export type HouseTandem = GamesService & PlaytimeService & {
  resolveDiscord(profile: { discordId: string; name: string; avatar?: string }): Promise<{ userId: number | string; name: string; avatar?: string }>;
  verifySession(token: string): Promise<{ userId: number | string; name: string; avatar?: string } | null>;
};

const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_MESSAGE_BYTES = 64 * 1024;
/** Players plus their phone remotes. */
const MAX_SOCKETS_PER_ROOM = 48;
/** Set by this Worker (never by the client) for a verified House Tandem account. */
const USER_HEADER = "x-ht-user";
/** Clients ping every 5s; a socket silent for this long is treated as dead (half-open TCP). */
const STALE_MS = 16_000;
/** Aims are cosmetic; relay at most one per this interval per socket. */
const AIM_MIN_INTERVAL_MS = 40;
const STUN: RTCIceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

type RTCIceServer = { urls: string | string[]; username?: string; credential?: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/token" && req.method === "POST") return exchangeToken(req, env);
    if (url.pathname === "/api/ice" && req.method === "GET") return iceServers(req, env);
    // The achievement list, for housetandem.com's profile page and anyone else.
    if (url.pathname === "/api/achievements" && req.method === "GET") {
      return new Response(JSON.stringify({ game: "coins", achievements: ACHIEVEMENTS }), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "public, max-age=300" },
      });
    }

    const relay = url.pathname.match(/^\/api\/relay\/([^/]+)$/);
    if (relay) {
      let room = "";
      try {
        room = decodeURIComponent(relay[1]);
      } catch {
        // malformed escape; rejected below
      }
      const id = url.searchParams.get("id") ?? "";
      if (!ROOM_RE.test(room) || !ID_RE.test(id)) return json({ error: "bad room or id" }, 400);
      // The id must be derived from the caller's secret key, so nobody can join as (or kick) someone else.
      if (!(await verifyPlayerKey(id, url.searchParams.get("key")))) return json({ error: "bad key" }, 403);
      // Players in a Discord room need the ticket from /api/token. Remotes don't: the host ignores any remote nobody paired.
      const role = url.searchParams.get("role") === "remote" ? "remote" : "player";
      let userId: string | undefined;
      if (role === "player" && DISCORD_ROOM_RE.test(room)) {
        const t = env.DISCORD_CLIENT_SECRET ? await readRoomTicket(env.DISCORD_CLIENT_SECRET, room, id, url.searchParams.get("ticket")) : { ok: false };
        if (!t.ok) return json({ error: "bad ticket" }, 403);
        userId = t.userId;
      } else if (role === "player" && url.searchParams.get("ht")) {
        userId = await verifyWebSession(env, url.searchParams.get("ht")!);
      }
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "expected websocket" }, 426);
      const headers = new Headers(req.headers);
      headers.delete(USER_HEADER);
      if (userId) headers.set(USER_HEADER, userId);
      return env.RELAY.get(env.RELAY.idFromName(room)).fetch(new Request(req, { headers }));
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    if (RANGED_RE.test(url.pathname) && (req.method === "GET" || req.method === "HEAD")) return withRanges(req, env.ASSETS);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

/** A House Tandem web session, checked by the account service. Undefined = guest. */
async function verifyWebSession(env: Env, token: string): Promise<string | undefined> {
  if (!env.HT || token.length > 4096) return undefined;
  try {
    const user = await env.HT.verifySession(token);
    return user ? String(user.userId) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Who this access token belongs to (verified with Discord, not taken from the
 * client), and their House Tandem account. Undefined if either is unavailable.
 */
async function houseTandemAccount(env: Env, accessToken: string): Promise<string | undefined> {
  if (!env.HT) return undefined;
  try {
    const res = await fetch("https://discord.com/api/users/@me", { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return undefined;
    const me = (await res.json()) as { id?: string; username?: string; global_name?: string | null; avatar?: string | null };
    if (!me.id || !/^[0-9]{1,20}$/.test(me.id)) return undefined;
    const avatar = me.avatar
      ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(me.id) >> 22n) % 6n)}.png`;
    const account = await env.HT.resolveDiscord({ discordId: me.id, name: me.global_name || me.username || "Player", avatar });
    const userId = String(account.userId);
    return /^[0-9]{1,20}$/.test(userId) ? userId : undefined;
  } catch {
    return undefined;
  }
}

/** Discord Embedded App SDK: swap the authorize() code for an access token. */
async function exchangeToken(req: Request, env: Env): Promise<Response> {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) return json({ error: "Discord is not configured" }, 503);
  let body: { code?: unknown; instanceId?: unknown; playerId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  const { code, instanceId, playerId } = body;
  if (typeof code !== "string" || code.length > 512) return json({ error: "missing code" }, 400);

  const res = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
    }),
  });
  if (!res.ok) {
    // Discord's OAuth error code (e.g. invalid_grant, invalid_client) isn't sensitive and makes setup problems diagnosable.
    const detail = ((await res.json().catch(() => ({}))) as { error?: unknown }).error;
    return json({ error: "token exchange failed", discord: typeof detail === "string" ? detail : res.status }, 502);
  }
  const { access_token } = (await res.json()) as { access_token?: string };
  if (!access_token) return json({ error: "token exchange failed" }, 502);
  // Older clients don't send these and keep using the raw instance id as their room.
  if (typeof instanceId !== "string" || instanceId.length > 256 || typeof playerId !== "string" || !ID_RE.test(playerId)) {
    return json({ access_token });
  }
  const room = await discordRoom(env.DISCORD_CLIENT_SECRET, instanceId);
  const userId = await houseTandemAccount(env, access_token);
  return json({ access_token, room, ticket: await roomTicket(env.DISCORD_CLIENT_SECRET, room, playerId, userId), signedIn: !!userId });
}

/**
 * Only our own pages get TURN credentials (they cost money per GB relayed):
 * same-origin requests, or the Discord Activity proxy.
 */
function fromOurPages(req: Request): boolean {
  const site = req.headers.get("Sec-Fetch-Site");
  if (site === "same-origin") return true;
  const origin = req.headers.get("Origin") ?? "";
  return /^https:\/\/[0-9]+\.discordsays\.com$/.test(origin) || origin === new URL(req.url).origin;
}

/** STUN always; short-lived TURN credentials too when a TURN key is configured. */
async function iceServers(req: Request, env: Env): Promise<Response> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN || !fromOurPages(req)) return json({ iceServers: STUN });
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: 6 * 60 * 60 }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { iceServers: RTCIceServer | RTCIceServer[] };
    const turn = Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
    return json({ iceServers: [...STUN, ...turn] });
  } catch {
    return json({ iceServers: STUN });
  }
}

/**
 * One instance per room. Relays envelopes between sockets and tells everyone
 * the connection order; the earliest player connection is the host. Phone
 * remotes are relayed like players but are never host. Uses the
 * hibernation API so idle rooms cost nothing.
 *
 * Players signed in with House Tandem carry a verified account id (set by the
 * Worker in USER_HEADER, kept on the socket). The peers message tells the room
 * which player is which account, so the host can show it and, later, the room
 * can credit achievements.
 */
export class RelayRoom extends DurableObject<Env> {
  /**
   * Achievements for signed-in players. The host's browser runs the shelf, so
   * the room checks what passes through before crediting anything: see the
   * trust model in src/achievements/referee.ts.
   */
  private scorekeeper: Scorekeeper | null = null;
  /** Phone remote id → the player it plays for, from the host's last state. */
  private remoteOwner = new Map<string, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    if (env.HT) {
      this.scorekeeper = new Scorekeeper({
        ht: env.HT,
        toast: (playerId, ids) => this.toast(playerId, ids),
        wait: (p) => ctx.waitUntil(p),
        log: (...a) => console.warn(...a),
      });
    }
  }

  /** Everyone at the table hears about it; the game shows the player's own as theirs. */
  private toast(playerId: string, ids: string[]) {
    const out = JSON.stringify({ type: "env", env: { from: "server", to: "all", msg: { t: "achievement", playerId, ids } } });
    for (const s of this.sockets()) s.ws.send(out);
  }

  /** Feed the scorekeeper what this message shows (it never changes what's relayed). */
  private score(ws: WebSocket, sender: Attachment, hostWs: WebSocket, to: string, msg: Record<string, unknown>, ordered: { ws: WebSocket; att: Attachment }[]) {
    const sk = this.scorekeeper;
    if (!sk) return;
    const now = Date.now();
    const players = splitPeers(ordered).players;
    sk.seat(players[0]?.att.id ?? null, new Map(players.filter((s) => s.att.userId).map((s) => [s.att.id, s.att.userId!])));
    if (to === "host" && ws !== hostWs && (msg.t === "drop" || msg.t === "shake")) {
      const playerId = sender.role === "remote" ? this.remoteOwner.get(sender.id) : sender.id;
      if (playerId) sk.request(playerId, msg as { t: string; aim?: unknown }, sender.role === "remote", now);
      return;
    }
    if (to !== "all" || ws !== hostWs) return;
    if (msg.t === "state" && Array.isArray(msg.players)) {
      this.remoteOwner = new Map(
        (msg.players as { id?: unknown; remoteId?: unknown }[])
          .filter((p) => typeof p?.id === "string" && typeof p?.remoteId === "string")
          .map((p) => [p.remoteId as string, p.id as string]),
      );
      sk.state(msg.game as never, now);
    } else if (msg.t === "frame") {
      const events = (msg.f as { events?: unknown } | undefined)?.events;
      if (Array.isArray(events)) sk.frame(events as never, now);
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const id = url.searchParams.get("id")!;
    const role = url.searchParams.get("role") === "remote" ? "remote" : "player";
    const userId = role === "player" ? (req.headers.get(USER_HEADER) ?? undefined) : undefined;
    // A reconnecting player replaces their old socket.
    for (const ws of this.ctx.getWebSockets(id)) ws.close(4000, "replaced");
    if (this.sockets().length >= MAX_SOCKETS_PER_ROOM) return json({ error: "room full" }, 429);

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [id]);
    const joinedAt = Math.max(Date.now(), ...this.sockets().map((s) => s.att.joinedAt + 1));
    server.serializeAttachment({ id, joinedAt, role, ...(userId ? { userId } : {}) } satisfies Attachment);
    this.broadcastPeers();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (typeof data !== "string" || data.length > MAX_MESSAGE_BYTES) return;
    let parsed: { to?: unknown; msg?: { t?: unknown } };
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const { to, msg } = parsed;
    if (!msg || typeof msg.t !== "string") return;
    const sender = ws.deserializeAttachment() as Attachment;
    // For the relay itself, never relayed: time in game for the sender's verified account.
    if (to === "server") {
      if (msg.t === "playtime") {
        const att = recordPlaytime(this.env.HT, sender, msg as { s?: unknown }, Date.now(), (p) => this.ctx.waitUntil(p), (...a) => console.warn(...a));
        if (att) ws.serializeAttachment(att);
      }
      return;
    }
    if (to !== "host" && to !== "all") return;
    if (msg.t === THROTTLED) {
      const now = Date.now();
      if (now - (sender.lastAim ?? 0) < AIM_MIN_INTERVAL_MS) return;
      ws.serializeAttachment({ ...sender, lastAim: now } satisfies Attachment);
    }
    this.evictStale();
    const ordered = this.sockets();
    const host = splitPeers(ordered).players[0];
    if (!host) return;
    const out = JSON.stringify({ type: "env", env: { from: sender.id, to, msg, ...(sender.role === "remote" ? { remote: true } : {}) } });
    try {
      this.score(ws, sender, host.ws, to, msg as Record<string, unknown>, ordered);
    } catch (e) {
      console.warn("scorekeeper", e);
    }

    if (to === "host") {
      if (host.ws !== ws) host.ws.send(out);
      return;
    }
    if (host.ws !== ws && !CLIENT_BROADCASTS.has(msg.t)) return;
    for (const s of ordered) if (s.ws !== ws) s.ws.send(out);
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, "closing");
    } catch {
      // already closed
    }
    this.broadcastPeers(ws);
    // Last one out: save what's pending before the room sleeps.
    if (this.sockets(ws).length === 0) this.scorekeeper?.flushAll(Date.now());
  }

  async webSocketError(ws: WebSocket) {
    this.broadcastPeers(ws);
  }

  /**
   * A host whose connection died without a close (phone locked, network gone)
   * would otherwise keep swallowing every "host" message until the runtime
   * notices. Clients ping every 5s, so silence means it's gone.
   */
  private evictStale() {
    const now = Date.now();
    let evicted = false;
    for (const { ws, att } of this.sockets()) {
      const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? att.joinedAt;
      if (now - Math.max(lastPing, att.joinedAt) > STALE_MS) {
        ws.close(4001, "stale");
        evicted = true;
      }
    }
    if (evicted) this.broadcastPeers();
  }

  private sockets(exclude?: WebSocket) {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== exclude && ws.readyState === WebSocket.OPEN)
      .map((ws) => ({ ws, att: ws.deserializeAttachment() as Attachment }))
      .filter((s) => s.att)
      .sort((a, b) => a.att.joinedAt - b.att.joinedAt || a.att.id.localeCompare(b.att.id));
  }

  /**
   * `ids`: players in connection order, so ids[0] is host. `remotes`: phone remotes.
   * `accounts`: player id → verified House Tandem account id, for signed-in players.
   */
  private broadcastPeers(exclude?: WebSocket) {
    const sockets = this.sockets(exclude);
    const { players, remotes } = splitPeers(sockets);
    const accounts = Object.fromEntries(players.filter((s) => s.att.userId).map((s) => [s.att.id, s.att.userId!]));
    const out = JSON.stringify({ type: "peers", ids: players.map((s) => s.att.id), remotes: remotes.map((s) => s.att.id), accounts });
    for (const s of sockets) s.ws.send(out);
  }
}
