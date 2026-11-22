import { DurableObject } from "cloudflare:workers";
import { KEY_RE, keyHash, verifyPlayerKey } from "../../src/net/identityKey";
import { CLIENT_BROADCASTS, THROTTLED } from "../../src/net/protocol";
import { userInInstance } from "./discordInstance";
import { CLOSE_TOO_MANY, clientAddress, newBucket, take, withinLimit, type Bucket, type RateLimiter } from "./limits";
import { loginIdOf, splitPeers, type Attachment } from "./peers";
import { CLOSE_NO_JOIN, CLOSE_NOT_LINKED, MAX_WAITING, registration, remoteIdOf, remoteOwner, reviewRemotes } from "./remotes";
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
  /** The application's bot token. With it, /api/token checks the player is in the Activity instance (worker/src/discordInstance.ts). */
  DISCORD_BOT_TOKEN?: string;
  /** The House Tandem account service over RPC (wrangler.jsonc `services`). Without it, everyone is a guest. */
  HT?: HouseTandem;
  /** Optional Cloudflare Realtime TURN key, for NAT traversal of the PeerJS transport. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** Rate limits per address (wrangler.jsonc; worker/src/limits.ts). Without them there is no limit. */
  TOKEN_RATE?: RateLimiter;
  ROOM_RATE?: RateLimiter;
}

/**
 * The House Tandem account service (Tandemonium's API Worker, entrypoint
 * HouseTandemGames): sign-in, gameProfile/recordGame for achievements, and
 * recordPlay for time in game (housetandem-web #37). `loginId` is which of the
 * account's logins signed in; records carry it. An older service doesn't
 * return it, and without it picks the account's first login.
 */
export type HouseTandem = GamesService & PlaytimeService & {
  resolveDiscord(profile: { discordId: string; name: string; avatar?: string }): Promise<{ userId: number | string; loginId?: number | null; name: string; avatar?: string }>;
  verifySession(token: string): Promise<{ userId: number | string; loginId?: number | null; name: string; avatar?: string } | null>;
};

const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_MESSAGE_BYTES = 64 * 1024;
/** Players plus their phone remotes. */
const MAX_SOCKETS_PER_ROOM = 48;
/** Set by this Worker (never by the client) for a verified House Tandem account. */
const USER_HEADER = "x-ht-user";
/** Likewise: which of the account's logins signed in, when the account service says. */
const LOGIN_HEADER = "x-ht-login";
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

    if (url.pathname === "/api/token" && req.method === "POST") {
      if (!(await withinLimit(env.TOKEN_RATE, clientAddress(req)))) return json({ error: "too many requests", retry: true }, 429);
      return exchangeToken(req, env);
    }
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
      if (!(await withinLimit(env.ROOM_RATE, clientAddress(req)))) return json({ error: "too many connections" }, 429);
      const role = url.searchParams.get("role") === "remote" ? "remote" : "player";
      let userId: string | undefined;
      let loginId: number | null = null;
      // A remote shows the room its key in its first message (worker/src/remotes.ts); nothing of it is in the address.
      if (role === "player") {
        // The id must be derived from the caller's secret key, so nobody can join as (or kick) someone else.
        if (!(await verifyPlayerKey(id, url.searchParams.get("key")))) return json({ error: "bad key" }, 403);
        // Players in a Discord room need the ticket from /api/token.
        if (DISCORD_ROOM_RE.test(room)) {
          const t = env.DISCORD_CLIENT_SECRET ? await readRoomTicket(env.DISCORD_CLIENT_SECRET, room, id, url.searchParams.get("ticket")) : { ok: false };
          if (!t.ok) return json({ error: t.expired ? "ticket expired" : "bad ticket" }, 403);
          userId = t.userId;
          loginId = t.loginId ?? null;
        }
      }
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "expected websocket" }, 426);
      const headers = new Headers(req.headers);
      headers.delete(USER_HEADER);
      headers.delete(LOGIN_HEADER);
      if (userId) headers.set(USER_HEADER, userId);
      if (userId && loginId !== null) headers.set(LOGIN_HEADER, String(loginId));
      return env.RELAY.get(env.RELAY.idFromName(room)).fetch(new Request(req, { headers }));
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    if (RANGED_RE.test(url.pathname) && (req.method === "GET" || req.method === "HEAD")) return withRanges(req, env.ASSETS);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

/** A signed-in player: the account, and the login that signed in (null when the account service doesn't say). */
type Verified = { userId: string; loginId: number | null };

/** A House Tandem web session, checked by the account service. Undefined = guest. */
async function verifyWebSession(env: Env, token: string): Promise<Verified | undefined> {
  if (!env.HT || token.length > 4096) return undefined;
  try {
    const user = await env.HT.verifySession(token);
    return user ? { userId: String(user.userId), loginId: loginIdOf(user.loginId) } : undefined;
  } catch {
    return undefined;
  }
}

type DiscordUser = { id: string; username?: string; global_name?: string | null; avatar?: string | null };

/**
 * Who this access token belongs to, asked of Discord (never taken from the
 * client). Null when Discord doesn't say; throws when it can't be reached.
 */
async function discordUser(accessToken: string): Promise<DiscordUser | null> {
  const res = await fetch("https://discord.com/api/users/@me", { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const me = (await res.json()) as Partial<DiscordUser>;
  return me.id && /^[0-9]{1,20}$/.test(me.id) ? (me as DiscordUser) : null;
}

/** The Discord user's House Tandem account. Undefined if it is unavailable. */
async function houseTandemAccount(env: Env, me: DiscordUser | null): Promise<Verified | undefined> {
  if (!env.HT || !me) return undefined;
  try {
    const avatar = me.avatar
      ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(me.id) >> 22n) % 6n)}.png`;
    const account = await env.HT.resolveDiscord({ discordId: me.id, name: me.global_name || me.username || "Player", avatar });
    const userId = String(account.userId);
    return /^[0-9]{1,20}$/.test(userId) ? { userId, loginId: loginIdOf(account.loginId) } : undefined;
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

  let me: DiscordUser | null = null;
  let unreachable = false;
  if (env.HT || env.DISCORD_BOT_TOKEN) {
    try {
      me = await discordUser(access_token);
    } catch {
      unreachable = true;
    }
  }
  // The ticket is for the instance the client names, so check with Discord that this user is in it
  // (only possible with the bot token; see worker/src/discordInstance.ts).
  const cantCheck = () => json({ error: "could not check the activity", retry: true }, 503);
  if (env.DISCORD_BOT_TOKEN && unreachable) return cantCheck();
  if (env.DISCORD_BOT_TOKEN && !me) return json({ error: "not in this activity" }, 403);
  const verdict = await userInInstance(
    { fetch: (u, init) => fetch(u, init), appId: env.DISCORD_CLIENT_ID, botToken: env.DISCORD_BOT_TOKEN, warn: (...a) => console.warn(...a) },
    instanceId,
    me?.id ?? "",
  );
  if (verdict === "retry") return cantCheck();
  if (verdict === "refused") return json({ error: "not in this activity" }, 403);

  const room = await discordRoom(env.DISCORD_CLIENT_SECRET, instanceId);
  const account = await houseTandemAccount(env, me);
  return json({ access_token, room, ticket: await roomTicket(env.DISCORD_CLIENT_SECRET, room, playerId, account?.userId, account?.loginId), signedIn: !!account });
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

type Sock = { ws: WebSocket; att: Attachment };

/**
 * One instance per room. Relays envelopes between sockets and tells everyone
 * the connection order; the earliest player connection is the host. Phone
 * remotes are relayed like players but are never host, and join only with a
 * key a player here registered (worker/src/remotes.ts). Uses the
 * hibernation API so idle rooms cost nothing.
 *
 * Players signed in with House Tandem carry a verified account id (from the
 * Discord ticket, set by the Worker in USER_HEADER, or from the web session
 * in the socket's first message; kept on the socket). The peers message tells
 * the room which player is which account, so the host can show it and the
 * room can credit achievements.
 */
export class RelayRoom extends DurableObject<Env> {
  /**
   * Achievements for signed-in players. The host's browser runs the shelf, so
   * the room checks what passes through before crediting anything: see the
   * trust model in src/achievements/referee.ts.
   */
  private scorekeeper: Scorekeeper | null = null;
  /** Message allowance per socket (worker/src/limits.ts). In memory: a room that slept starts everyone afresh. */
  private buckets = new WeakMap<WebSocket, Bucket>();

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
  private score(ws: WebSocket, sender: Attachment, hostWs: WebSocket, to: string, msg: Record<string, unknown>, ordered: Sock[]) {
    const sk = this.scorekeeper;
    if (!sk) return;
    const now = Date.now();
    const players = splitPeers(ordered).players;
    sk.seat(
      players[0]?.att.id ?? null,
      new Map(players.filter((s) => s.att.userId).map((s) => [s.att.id, s.att.userId!])),
      new Map(players.filter((s) => s.att.userId && s.att.loginId != null).map((s) => [s.att.id, s.att.loginId!])),
    );
    if (to === "host" && ws !== hostWs && (msg.t === "drop" || msg.t === "shake")) {
      // A remote plays for the player whose key it presented, whatever the host's state says.
      const playerId = sender.role === "remote" ? sender.owner : sender.id;
      if (playerId) sk.request(playerId, msg as { t: string; aim?: unknown }, sender.role === "remote", now);
      return;
    }
    if (to !== "all" || ws !== hostWs) return;
    if (msg.t === "state" && Array.isArray(msg.players)) sk.state(msg.game as never, now);
    else if (msg.t === "frame") {
      const events = (msg.f as { events?: unknown } | undefined)?.events;
      if (Array.isArray(events)) sk.frame(events as never, now);
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const id = url.searchParams.get("id")!;
    const role = url.searchParams.get("role") === "remote" ? "remote" : "player";

    if (role === "remote") {
      // Not part of the room until it has sent a key a player here registered (webSocketMessage).
      this.review();
      if (this.all().filter((s) => s.att.pending).length >= MAX_WAITING) return json({ error: "busy" }, 429);
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server, [id]);
      server.serializeAttachment({ id, joinedAt: Date.now(), role, pending: true } satisfies Attachment);
      return new Response(null, { status: 101, webSocket: client });
    }

    const userId = req.headers.get(USER_HEADER) ?? undefined;
    const loginId = userId ? loginIdOf(req.headers.get(LOGIN_HEADER)) : null;
    const web = !DISCORD_ROOM_RE.test(decodeURIComponent(url.pathname.split("/").pop() ?? ""));
    // A reconnecting player replaces their old socket.
    for (const ws of this.ctx.getWebSockets(id)) ws.close(4000, "replaced");
    if (this.sockets().length >= MAX_SOCKETS_PER_ROOM) return json({ error: "room full" }, 429);

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [id]);
    const joinedAt = Math.max(Date.now(), ...this.sockets().map((s) => s.att.joinedAt + 1));
    server.serializeAttachment({ id, joinedAt, role, ...(web ? { web } : {}), ...(userId ? { userId } : {}), ...(loginId !== null ? { loginId } : {}) } satisfies Attachment);
    this.broadcastPeers();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const now = Date.now();
    let bucket = this.buckets.get(ws);
    if (!bucket) this.buckets.set(ws, (bucket = newBucket(now)));
    const allowance = take(bucket, now);
    if (allowance === "close") {
      ws.close(CLOSE_TOO_MANY, "too many messages");
      this.broadcastPeers(ws);
      return;
    }
    if (allowance === "drop" || typeof data !== "string" || data.length > MAX_MESSAGE_BYTES) return;
    let parsed: { to?: unknown; msg?: { t?: unknown } } | null;
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = null;
    }
    const sender = ws.deserializeAttachment() as Attachment;
    if (!sender) return;
    const forRoom = parsed && typeof parsed === "object" && parsed.to === "server" ? parsed.msg : undefined;
    if (sender.pending) return this.admitRemote(ws, forRoom);
    if (!parsed || typeof parsed !== "object") return;
    const { to, msg } = parsed;
    if (!msg || typeof msg.t !== "string") return;
    // For the relay itself, never relayed.
    if (to === "server") return this.fromClient(ws, sender, msg);
    if (to !== "host" && to !== "all") return;
    if (msg.t === THROTTLED) {
      if (now - (sender.lastAim ?? 0) < AIM_MIN_INTERVAL_MS) return;
      ws.serializeAttachment({ ...sender, lastAim: now } satisfies Attachment);
    }
    this.evictStale();
    const ordered = this.sockets();
    const host = splitPeers(ordered).players[0];
    if (!host) return;
    // A player pairs only the remote whose key they registered.
    if (to === "host" && sender.role !== "remote" && msg.t === "pair" && (!sender.remoteHash || remoteIdOf(sender.remoteHash) !== (msg as { remoteId?: unknown }).remoteId)) return;
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

  /**
   * A remote socket's first message. It joins the room only with a key a
   * player here registered; anything else closes it, and it has been sent nothing.
   */
  private async admitRemote(ws: WebSocket, msg: unknown) {
    const m = msg as { t?: unknown; key?: unknown } | undefined;
    const key = m && m.t === "join" && typeof m.key === "string" && KEY_RE.test(m.key) ? m.key : null;
    const hash = key ? await keyHash(key) : null;
    const att = ws.deserializeAttachment() as Attachment;
    if (!att?.pending) return;
    const found = hash ? remoteOwner(this.sockets(ws), att.id, hash) : null;
    if (!hash || !found || this.sockets(ws).filter((s) => s.att.id !== att.id).length >= MAX_SOCKETS_PER_ROOM) {
      ws.close(CLOSE_NOT_LINKED, "not linked");
      return;
    }
    // The same remote reconnecting replaces its old socket.
    for (const other of this.ctx.getWebSockets(att.id)) if (other !== ws) other.close(4000, "replaced");
    const joinedAt = Math.max(Date.now(), ...this.sockets(ws).map((s) => s.att.joinedAt + 1));
    ws.serializeAttachment({ id: att.id, joinedAt, role: "remote", keyHash: hash, ...found } satisfies Attachment);
    this.broadcastPeers();
  }

  /** A message for the room itself (`to: "server"`), never relayed: see ServerMsg in src/net/protocol.ts. */
  private async fromClient(ws: WebSocket, sender: Attachment, msg: unknown) {
    if (sender.role === "remote" || !msg || typeof msg !== "object") return;
    const m = msg as { t?: unknown; ht?: unknown; remote?: unknown; hash?: unknown; s?: unknown };
    if (m.t === "playtime") {
      // Time in game for the sender's verified account.
      const att = recordPlaytime(this.env.HT, sender, m, Date.now(), (p) => this.ctx.waitUntil(p), (...a) => console.warn(...a));
      if (att) ws.serializeAttachment(att);
      return;
    }
    if (m.t === "remote-key") {
      this.register(ws, sender, m.hash);
      return;
    }
    if (m.t !== "join" || sender.joined) return;
    this.register(ws, { ...sender, joined: true }, m.remote, true);
    // A web player's House Tandem session: until the account service has confirmed it, this socket is a guest.
    if (!sender.web || sender.userId || typeof m.ht !== "string") return;
    const user = await verifyWebSession(this.env, m.ht);
    if (!user) return;
    try {
      const att = ws.deserializeAttachment() as Attachment;
      ws.serializeAttachment({ ...att, userId: user.userId, ...(user.loginId !== null ? { loginId: user.loginId } : {}) } satisfies Attachment);
    } catch {
      return; // the socket closed meanwhile
    }
    this.broadcastPeers();
  }

  /** Keep (or clear) a player's remote key registration, then close any remote it no longer covers. */
  private register(ws: WebSocket, sender: Attachment, hash: unknown, always = false) {
    const kept = registration(this.sockets(ws), sender.id, hash);
    if (kept === undefined && !always) return;
    const { remoteHash: _old, ...rest } = sender;
    ws.serializeAttachment({ ...rest, ...(kept ? { remoteHash: kept } : {}) } satisfies Attachment);
    if (this.review()) this.broadcastPeers();
  }

  /** Apply worker/src/remotes.ts to the sockets here. True when a remote that was in the room was closed. */
  private review(exclude?: WebSocket): boolean {
    const { close, update } = reviewRemotes(this.all(exclude), Date.now());
    for (const u of update) u.sock.ws.serializeAttachment(u.att);
    for (const s of close) s.ws.close(s.att.pending ? CLOSE_NO_JOIN : CLOSE_NOT_LINKED, s.att.pending ? "no join" : "not linked");
    return close.some((s) => !s.att.pending);
  }

  async webSocketClose(ws: WebSocket, code: number) {
    const att = ws.deserializeAttachment() as Attachment | null;
    try {
      ws.close(code === 1005 ? 1000 : code, "closing");
    } catch {
      // already closed
    }
    // A remote that never joined was never announced.
    if (att?.pending) return;
    this.review(ws);
    this.broadcastPeers(ws);
    // Last one out: save what's pending before the room sleeps.
    if (this.sockets(ws).length === 0) this.scorekeeper?.flushAll(Date.now());
  }

  async webSocketError(ws: WebSocket) {
    if ((ws.deserializeAttachment() as Attachment | null)?.pending) return;
    this.review(ws);
    this.broadcastPeers(ws);
  }

  /**
   * A host whose connection died without a close (phone locked, network gone)
   * would otherwise keep swallowing every "host" message until the runtime
   * notices. Clients ping every 5s, so silence means it's gone. Remotes that
   * lost their registration go too.
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
    if (this.review()) evicted = true;
    if (evicted) this.broadcastPeers();
  }

  /** Every open socket, remotes that haven't joined yet included. */
  private all(exclude?: WebSocket): Sock[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== exclude && ws.readyState === WebSocket.OPEN)
      .map((ws) => ({ ws, att: ws.deserializeAttachment() as Attachment }))
      .filter((s) => s.att)
      .sort((a, b) => a.att.joinedAt - b.att.joinedAt || a.att.id.localeCompare(b.att.id));
  }

  /** The sockets in the room: players, and remotes the room has taken. */
  private sockets(exclude?: WebSocket): Sock[] {
    return this.all(exclude).filter((s) => !s.att.pending);
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
