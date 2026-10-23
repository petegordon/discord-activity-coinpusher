import type * as RapierNS from "@dimforge/rapier3d-compat";
import { COIN, PRIZE_POINTS, START_PILE, TABLE } from "../game/rules";
import { KIND_COIN, KIND_PRIZE, type Body } from "./frame";
import { PRIZE_SIZES } from "./prizes";

export { PRIZE_SIZES };

type Rapier = typeof RapierNS;
type RigidBody = RapierNS.RigidBody;

let rapier: Promise<Rapier> | null = null;

/** Rapier (WebAssembly) is only needed by the host, so it loads on demand. */
export function loadRapier(): Promise<Rapier> {
  rapier ??= import("@dimforge/rapier3d-compat").then(async (m) => {
    const R = ((m as unknown as { default?: Rapier }).default ?? m) as Rapier;
    await R.init();
    return R;
  });
  return rapier;
}

/** Something fell off the shelf. */
export type Out = { kind: number; x: number; tray: boolean };


const STEP_S = 1 / 120;
const COIN_DENSITY = 8500;
const PRIZE_DENSITY = 350;
/** Below this the body has left the shelf. */
const OUT_Y = -0.05;
/** A new tower arrives this long after the last prize leaves. */
const TOWER_DELAY_S = 1.5;
/** Ignore coins beyond this many on the shelf (a safety cap, not a rule). */
export const MAX_COINS = 280;

/** Small, fast, seedable: so tests and the starting pile are repeatable. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The pusher's front face at simulation time `t` seconds. */
export function pusherAt(t: number): number {
  const mid = (TABLE.pusherMinZ + TABLE.pusherMaxZ) / 2;
  const amp = (TABLE.pusherMaxZ - TABLE.pusherMinZ) / 2;
  return mid + amp * Math.sin((2 * Math.PI * t) / TABLE.pusherPeriodS);
}

function quatFromEuler(x: number, y: number, z: number) {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(x / 2), Math.sin(x / 2), Math.cos(y / 2), Math.sin(y / 2), Math.cos(z / 2), Math.sin(z / 2)];
  return { x: sx * cy * cz + cx * sy * sz, y: cx * sy * cz - sx * cy * sz, z: cx * cy * sz + sx * sy * cz, w: cx * cy * cz - sx * sy * sz };
}

/**
 * The coin shelf, simulated on the host only. Fixed walls and floor, a
 * kinematic pusher sliding under the back wall, coins and a prize tower.
 * Everyone else sees it through frames (frame.ts).
 */
export class DozerSim {
  private world: RapierNS.World;
  private bodies = new Map<number, { body: RigidBody; kind: number }>();
  private nextId = 1;
  private pusher!: RigidBody;
  private acc = 0;
  /** Seconds of pusher travel; stops while the shelf is locked. */
  private pusherT = 0;
  private towerIn: number | null = null;
  private rand: () => number = Math.random;
  private outs: Out[] = [];
  private lastSent = new Map<number, Body>();
  private removed: number[] = [];
  private towerArrived = false;
  /** Stops the pusher (a tilt lock). */
  locked = false;
  /** Total simulated time, seconds. */
  time = 0;

  constructor(private readonly R: Rapier) {
    this.world = this.newWorld();
  }

  static async create(): Promise<DozerSim> {
    return new DozerSim(await loadRapier());
  }

  get pusherZ(): number {
    return pusherAt(this.pusherT);
  }

  get coinCount(): number {
    let n = 0;
    for (const b of this.bodies.values()) if (b.kind === KIND_COIN) n++;
    return n;
  }

  get prizeCount(): number {
    return this.bodies.size - this.coinCount;
  }

  private newWorld() {
    const R = this.R;
    const world = new R.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = STEP_S;
    world.lengthUnit = 0.05;
    world.numSolverIterations = 6;
    const fixed = (hx: number, hy: number, hz: number, x: number, y: number, z: number, friction = 0.4) =>
      world.createCollider(R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(friction));
    const W = TABLE.halfWidth;
    // Floor: from far behind the back wall to the front edge, top at y = 0.
    fixed(W + 0.05, 0.05, (TABLE.frontZ + 0.7) / 2, 0, -0.05, (TABLE.frontZ - 0.7) / 2, 0.25);
    // Side walls.
    for (const s of [-1, 1]) fixed(0.02, 0.25, (TABLE.frontZ + 0.7) / 2, s * (W + 0.02), 0.25, (TABLE.frontZ - 0.7) / 2);
    // Back wall: coins riding the pusher are scraped off as it slides back underneath.
    const wallBottom = TABLE.pusherTop + 0.003;
    fixed(W, (0.5 - wallBottom) / 2, 0.02, 0, wallBottom + (0.5 - wallBottom) / 2, TABLE.backZ - 0.02);
    // The pusher: a long slab whose front face sweeps the shelf.
    this.pusher = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, TABLE.pusherTop / 2, TABLE.pusherMinZ - 0.2));
    world.createCollider(R.ColliderDesc.cuboid(W - 0.002, TABLE.pusherTop / 2, 0.2).setFriction(0.5), this.pusher);
    return world;
  }

  private clear() {
    this.world.free();
    this.world = this.newWorld();
    for (const id of this.bodies.keys()) this.removed.push(id);
    this.bodies.clear();
    this.lastSent.clear();
    this.outs = [];
    this.acc = 0;
    this.towerIn = null;
    this.nextId = 0;
  }

  private addCoin(
    p: { x: number; y: number; z: number },
    rot = { x: 0, y: 0, z: 0, w: 1 },
    linvel?: { x: number; y: number; z: number },
    angvel?: { x: number; y: number; z: number },
    id = this.newId(),
  ) {
    const R = this.R;
    const desc = R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setRotation(rot).setCcdEnabled(true).setAngularDamping(0.3);
    if (linvel) desc.setLinvel(linvel.x, linvel.y, linvel.z);
    if (angvel) desc.setAngvel(angvel);
    const body = this.world.createRigidBody(desc);
    this.world.createCollider(R.ColliderDesc.cylinder(COIN.thickness / 2, COIN.radius).setDensity(COIN_DENSITY).setFriction(0.45).setRestitution(0.15), body);
    this.bodies.set(id, { body, kind: KIND_COIN });
    return id;
  }

  private addPrize(tier: number, p: { x: number; y: number; z: number }, rot = { x: 0, y: 0, z: 0, w: 1 }, id = this.newId()) {
    const R = this.R;
    const [hx, hy, hz] = PRIZE_SIZES[tier];
    const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setRotation(rot).setAngularDamping(0.5));
    this.world.createCollider(R.ColliderDesc.cuboid(hx, hy, hz).setDensity(PRIZE_DENSITY).setFriction(0.6).setRestitution(0.05), body);
    this.bodies.set(id, { body, kind: KIND_PRIZE + tier });
    return id;
  }

  private newId() {
    do this.nextId = (this.nextId % 0xfffe) + 1;
    while (this.bodies.has(this.nextId));
    return this.nextId;
  }

  /** A teetering stack of prizes, dropped onto the coins in the front half of the shelf. */
  private addTower(dropFrom = 0.05) {
    const x = (this.rand() - 0.5) * 0.16;
    const z = 0.1 + this.rand() * 0.04;
    let y = dropFrom;
    PRIZE_SIZES.forEach(([, hy], tier) => {
      y += hy;
      // Each box sits a little off the one below: that's what makes it teeter.
      const off = (this.rand() - 0.5) * 0.012;
      this.addPrize(tier, { x: x + off, y, z: z + (this.rand() - 0.3) * 0.01 }, quatFromEuler(0, (this.rand() - 0.5) * 0.5, 0));
      y += hy + 0.001;
    });
    this.towerArrived = true;
  }

  /** A fresh shelf: a pile of coins shuffled into place by the pusher, and a prize tower. */
  reset(seed: number) {
    this.clear();
    this.rand = mulberry32(seed);
    this.time = 0;
    this.pusherT = 0;
    this.locked = false;
    const spacing = COIN.radius * 2 + 0.003;
    const cols = Math.floor((TABLE.halfWidth * 2 - 0.01) / spacing);
    const cells: { x: number; z: number }[] = [];
    for (let z = TABLE.pusherMaxZ + COIN.radius + 0.004; z < TABLE.frontZ - COIN.radius; z += spacing) {
      for (let c = 0; c < cols; c++) cells.push({ x: -TABLE.halfWidth + 0.005 + spacing / 2 + c * spacing, z });
    }
    for (let i = 0; i < START_PILE; i++) {
      const cell = cells[i % cells.length];
      const layer = Math.floor(i / cells.length);
      const jitter = () => (this.rand() - 0.5) * 0.004;
      this.addCoin(
        { x: cell.x + jitter() + (layer % 2) * spacing * 0.5, y: COIN.thickness / 2 + 0.002 + layer * (COIN.thickness + 0.004), z: cell.z + jitter() + (layer % 2) * spacing * 0.3 },
        quatFromEuler((this.rand() - 0.5) * 0.2, this.rand() * 6, (this.rand() - 0.5) * 0.2),
      );
    }
    // Let it settle with the pusher running; anything that falls off now doesn't count.
    this.towerIn = Infinity;
    for (let i = 0; i < 3 / STEP_S; i++) this.fixedStep();
    this.addTower(0.03);
    for (let i = 0; i < 1 / STEP_S; i++) this.fixedStep();
    this.outs = [];
    this.towerIn = null;
  }

  /** Rebuild from the last frame everyone saw (after a host migration). Velocities start at rest. */
  restore(bodies: Body[], time: number) {
    this.clear();
    this.time = time;
    this.pusherT = time;
    for (const b of bodies) {
      const p = { x: b.p[0], y: b.p[1], z: b.p[2] };
      const q = { x: b.q[0], y: b.q[1], z: b.q[2], w: b.q[3] };
      // Keep the ids everyone already has, so their interpolation doesn't jump.
      if (this.bodies.has(b.id) || b.id === 0) continue;
      if (b.kind === KIND_COIN) this.addCoin(p, q, undefined, undefined, b.id);
      else if (b.kind - KIND_PRIZE < PRIZE_SIZES.length) this.addPrize(b.kind - KIND_PRIZE, p, q, b.id);
    }
    this.nextId = Math.max(1, ...this.bodies.keys());
    this.removed = [];
  }

  /**
   * A coin out of a chute at `x`: `aim` turns it (radians, + toward +x),
   * `power` 0..1 sets how far it flies, `spin` −1..1 how it's twisting.
   */
  drop(x: number, aim: number, power: number, spin: number): number | null {
    if (this.coinCount >= MAX_COINS) return null;
    const speed = 0.35 + power * 0.75;
    const vx = Math.sin(aim) * speed;
    const vz = Math.cos(aim) * speed;
    // The spin turns the coin about its direction of travel, so it lands tilted and skids or rolls.
    const s = spin * 25;
    return this.addCoin(
      { x, y: TABLE.chuteY, z: TABLE.backZ + 0.03 },
      quatFromEuler(0.35, aim, 0),
      { x: vx, y: -0.15, z: vz },
      { x: Math.sin(aim) * s, y: 0, z: Math.cos(aim) * s },
    );
  }

  /** Nudge everything on the shelf. `strength` 1 is a single player's shake, 3 a synchronized one. */
  shake(strength: number) {
    for (const { body, kind } of this.bodies.values()) {
      const m = body.mass();
      const prize = kind !== KIND_COIN;
      const forward = (prize ? 0.11 : 0.05) * strength;
      body.applyImpulse(
        { x: m * (this.rand() - 0.5) * 0.04 * strength, y: m * (0.18 + this.rand() * 0.06) * Math.sqrt(strength), z: m * forward * (0.7 + this.rand() * 0.6) },
        true,
      );
      if (prize) body.applyTorqueImpulse({ x: m * 0.0006 * strength, y: 0, z: m * (this.rand() - 0.5) * 0.0006 * strength }, true);
    }
  }

  /** Advance by `dt` seconds of wall time, in fixed steps. */
  step(dt: number) {
    this.acc = Math.min(this.acc + dt, 0.1);
    while (this.acc >= STEP_S) {
      this.acc -= STEP_S;
      this.fixedStep();
    }
  }

  private fixedStep() {
    if (!this.locked) this.pusherT += STEP_S;
    this.time += STEP_S;
    this.pusher.setNextKinematicTranslation({ x: 0, y: TABLE.pusherTop / 2, z: this.pusherZ - 0.2 });
    this.world.step();
    for (const [id, { body, kind }] of this.bodies) {
      if (body.isSleeping()) continue;
      const p = body.translation();
      if (p.y > OUT_Y && Math.abs(p.x) < 1 && p.y < 2 && p.z < 1) continue;
      this.outs.push({ kind, x: p.x, tray: p.y <= OUT_Y && p.z > TABLE.frontZ - 0.02 && Math.abs(p.x) <= TABLE.trayHalfWidth });
      this.world.removeRigidBody(body);
      this.bodies.delete(id);
      this.lastSent.delete(id);
      this.removed.push(id);
    }
    if (this.prizeCount === 0) {
      this.towerIn ??= this.time + TOWER_DELAY_S;
      if (this.time >= this.towerIn) {
        this.towerIn = null;
        this.addTower();
      }
    }
  }

  /** What fell off since the last call. */
  takeOuts(): Out[] {
    const outs = this.outs;
    this.outs = [];
    return outs;
  }

  /** Whether a new prize tower arrived since the last call. */
  takeTower(): boolean {
    const t = this.towerArrived;
    this.towerArrived = false;
    return t;
  }

  /** Every body's pose. */
  all(): Body[] {
    return [...this.bodies].map(([id, b]) => pose(id, b.kind, b.body));
  }

  /**
   * For the next frame: every body (`key`) or only those that moved since
   * they were last sent, plus the ids removed since the last call.
   */
  delta(key: boolean): { bodies: Body[]; gone: number[] } {
    const out: Body[] = [];
    for (const [id, { body, kind }] of this.bodies) {
      const prev = this.lastSent.get(id);
      if (!key && prev && body.isSleeping()) continue;
      const b = pose(id, kind, body);
      if (!key && prev && moved(prev, b) < 2e-4) continue;
      this.lastSent.set(id, b);
      out.push(b);
    }
    const gone = this.removed;
    this.removed = [];
    return { bodies: out, gone };
  }

  free() {
    this.world.free();
    this.bodies.clear();
  }
}

function pose(id: number, kind: number, body: RigidBody): Body {
  const t = body.translation();
  const r = body.rotation();
  return { id, kind, p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w] };
}

function moved(a: Body, b: Body): number {
  const dp = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]);
  const dq = Math.abs(a.q[0] * b.q[0] + a.q[1] * b.q[1] + a.q[2] * b.q[2] + a.q[3] * b.q[3]);
  return Math.max(dp, (1 - dq) * 0.1);
}

export const prizePoints = (tier: number) => PRIZE_POINTS[Math.max(0, Math.min(PRIZE_POINTS.length - 1, tier))];
