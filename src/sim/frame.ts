/**
 * What the host's simulation sends everyone, ~15 times a second: where every
 * coin and prize is, packed small. Positions are 0.1 mm steps in 16 bits,
 * rotations are quaternions in 16 bits a component.
 */

export const KIND_COIN = 0;
/** Prizes are KIND_PRIZE + their tier (0 = bottom of the tower). */
export const KIND_PRIZE = 1;

export type Body = {
  id: number;
  kind: number;
  p: [number, number, number];
  /** x, y, z, w */
  q: [number, number, number, number];
};

export type SimEvent =
  /** A coin fell into the tray at `x` and went to lane `lane`. */
  | { k: "won"; x: number; lane: number }
  /** A coin fell into a side gutter. */
  | { k: "lost"; x: number }
  /** A prize fell into the tray. */
  | { k: "prize"; x: number; tier: number; points: number }
  /** A prize fell into a gutter. */
  | { k: "prize-lost"; x: number; tier: number }
  /** A coin left `by`'s chute. */
  | { k: "drop"; by: string }
  /** The shelf was shaken by `by`, all at once. */
  | { k: "shake"; by: string[]; strength: number }
  | { k: "tilt" }
  | { k: "unlock" }
  /** A fresh prize tower arrived. */
  | { k: "tower" };

export type Frame = {
  seq: number;
  /** Host simulation clock, ms. */
  ms: number;
  gameId: string;
  /** The pusher's front face (z). */
  pusher: number;
  /** Tilt meter 0–100. */
  tilt: number;
  /** ms left of a tilt lock, 0 when unlocked. */
  locked: number;
  /** Every body (a keyframe), or only those that moved since the last frame. */
  key: boolean;
  bodies: string;
  /** Ids removed since the last frame. */
  gone: number[];
  events: SimEvent[];
};

const BYTES = 18;
const POS_UNIT = 1e-4;
const Q_UNIT = 32767;

const clamp16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));

export function packBodies(bodies: Body[]): string {
  const buf = new ArrayBuffer(bodies.length * BYTES);
  const v = new DataView(buf);
  bodies.forEach((b, i) => {
    const o = i * BYTES;
    v.setUint16(o, b.id & 0xffff, true);
    v.setUint8(o + 2, b.kind & 0xff);
    for (let k = 0; k < 3; k++) v.setInt16(o + 4 + k * 2, clamp16(b.p[k] / POS_UNIT), true);
    for (let k = 0; k < 4; k++) v.setInt16(o + 10 + k * 2, clamp16(b.q[k] * Q_UNIT), true);
  });
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Malformed input gives no bodies, never an exception. */
export function unpackBodies(data: unknown): Body[] {
  if (typeof data !== "string" || data.length > 200_000) return [];
  let bin: string;
  try {
    bin = atob(data);
  } catch {
    return [];
  }
  const n = Math.floor(bin.length / BYTES);
  const bytes = new Uint8Array(n * BYTES);
  for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
  const v = new DataView(bytes.buffer);
  const out: Body[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * BYTES;
    const q: [number, number, number, number] = [0, 1, 2, 3].map((k) => v.getInt16(o + 10 + k * 2, true) / Q_UNIT) as [number, number, number, number];
    const len = Math.hypot(...q) || 1;
    out.push({
      id: v.getUint16(o, true),
      kind: v.getUint8(o + 2),
      p: [0, 1, 2].map((k) => v.getInt16(o + 4 + k * 2, true) * POS_UNIT) as [number, number, number],
      q: q.map((c) => c / len) as [number, number, number, number],
    });
  }
  return out;
}

/** Light validation of a frame off the wire; returns null if it isn't one. */
export function readFrame(value: unknown): Frame | null {
  if (!value || typeof value !== "object") return null;
  const f = value as Record<string, unknown>;
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  if (!num(f.seq) || !num(f.ms) || !num(f.pusher) || !num(f.tilt) || !num(f.locked) || typeof f.bodies !== "string" || typeof f.gameId !== "string") return null;
  return {
    seq: f.seq as number,
    ms: f.ms as number,
    gameId: f.gameId as string,
    pusher: f.pusher as number,
    tilt: Math.max(0, Math.min(100, f.tilt as number)),
    locked: Math.max(0, f.locked as number),
    key: f.key === true,
    bodies: f.bodies as string,
    gone: Array.isArray(f.gone) ? (f.gone as unknown[]).filter((x): x is number => num(x)).slice(0, 1000) : [],
    events: Array.isArray(f.events) ? (f.events as SimEvent[]).filter((e) => e && typeof e === "object" && typeof e.k === "string").slice(0, 200) : [],
  };
}
