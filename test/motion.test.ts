import { describe, expect, it } from "vitest";
import { aimFromRoll, FLICK_PEAK, flickPower, JerkDetector, MotionReader, rollDeg, RollTracker, SHAKE_PEAK, type MotionSample } from "../src/input/motion";

const dt = 1000 / 60;
/** Held flat, screen up: gravity's reaction points out of the screen. */
const FLAT = { gx: 0, gy: 0, gz: 9.8 };

function feed(d: JerkDetector, holding: boolean, from: number, to: number, fn: (t: number) => Partial<MotionSample>) {
  const out = [];
  for (let t = from; t < to; t += dt) {
    const j = d.push({ t, ax: 0, ay: 0, az: 0, ...FLAT, ...fn(t) }, holding);
    if (j) out.push(j);
  }
  return out;
}

const pulse = (at: number, len: number, v: Partial<MotionSample>) => (t: number) => (t >= at && t < at + len ? v : {});

describe("JerkDetector", () => {
  it("ignores holding the phone and sensor noise", () => {
    const d = new JerkDetector();
    expect(feed(d, true, 0, 2000, () => ({ ax: (Math.random() - 0.5) * 3, ay: (Math.random() - 0.5) * 3 }))).toEqual([]);
    expect(feed(d, false, 0, 2000, () => ({ az: (Math.random() - 0.5) * 3 }))).toEqual([]);
  });

  it("calls a sharp jerk in any direction a flick while holding", () => {
    const d = new JerkDetector();
    const got = feed(d, true, 0, 600, pulse(100, 50, { ay: FLICK_PEAK + 5 }));
    expect(got.map((j) => j.kind)).toEqual(["flick"]);
    expect(feed(new JerkDetector(), true, 0, 600, pulse(100, 50, { ax: -(FLICK_PEAK + 2) })).map((j) => j.kind)).toEqual(["flick"]);
  });

  it("calls an upward jerk a shake when not holding, but not a sideways one", () => {
    expect(feed(new JerkDetector(), false, 0, 600, pulse(100, 50, { az: SHAKE_PEAK + 4 })).map((j) => j.kind)).toEqual(["shake"]);
    expect(feed(new JerkDetector(), false, 0, 600, pulse(100, 50, { ax: SHAKE_PEAK + 8 }))).toEqual([]);
  });

  it("finds 'up' from gravity however the phone is held", () => {
    // Upright, screen facing you: up is the top of the screen (+y).
    const upright = { gx: 0, gy: 9.8, gz: 0 };
    const got = feed(new JerkDetector(), false, 0, 600, (t) => ({ ...upright, ...(t >= 100 && t < 150 ? { ay: SHAKE_PEAK + 4 } : {}) }));
    expect(got.map((j) => j.kind)).toEqual(["shake"]);
  });

  it("counts one jerk once, ignoring the hand's recoil", () => {
    const d = new JerkDetector();
    const got = feed(d, true, 0, 800, (t) => (t >= 100 && t < 150 ? { ay: 20 } : t >= 200 && t < 250 ? { ay: -18 } : {}));
    expect(got.length).toBe(1);
  });

  it("maps flick strength to 0..1", () => {
    expect(flickPower(FLICK_PEAK)).toBe(0);
    expect(flickPower(100)).toBe(1);
  });
});

describe("roll and aim", () => {
  it("reads the roll from gravity across the phone, right edge down positive", () => {
    expect(rollDeg(FLAT)).toBeCloseTo(0);
    const r = (20 * Math.PI) / 180;
    // Right edge dipping tips the up vector toward −x.
    expect(rollDeg({ gx: -9.8 * Math.sin(r), gy: 0, gz: 9.8 * Math.cos(r) })).toBeCloseTo(20);
    // Same for an upright phone turned like a steering wheel.
    expect(rollDeg({ gx: -9.8 * Math.sin(r), gy: 9.8 * Math.cos(r), gz: 0 })).toBeCloseTo(20);
    expect(aimFromRoll(90)).toBe(1);
    expect(aimFromRoll(-90)).toBe(-1);
  });

  it("remembers the roll from just before a flick, and how fast it was turning", () => {
    const tr = new RollTracker();
    for (let t = 0; t <= 500; t += dt) tr.push(t, t < 400 ? t / 20 : 60); // turning 50°/s, then snapped to 60
    expect(tr.roll).toBe(60);
    expect(tr.before(150)).toBeLessThan(20);
    expect(tr.rate(150, 120)).toBeCloseTo(50, 0);
  });
});

describe("MotionReader", () => {
  const ev = (g: [number, number, number], a: [number, number, number] | null = [0, 0, 0]) =>
    ({ accelerationIncludingGravity: { x: g[0], y: g[1], z: g[2] }, acceleration: a && { x: a[0], y: a[1], z: a[2] }, rotationRate: null }) as unknown as DeviceMotionEvent;

  it("keeps spec axes, and flips inverted ones (old iOS) using gravity", () => {
    const spec = new MotionReader();
    for (let i = 0; i < 20; i++) spec.read(ev([0, 3, 9]), i * dt);
    expect(spec.sign).toBe(1);
    const flipped = new MotionReader();
    let s;
    for (let i = 0; i < 20; i++) s = flipped.read(ev([0, -3, -9], [1, 0, 0]), i * dt);
    expect(flipped.sign).toBe(-1);
    expect(s!.ax).toBe(-1);
    expect(s!.gz).toBeGreaterThan(8);
  });

  it("estimates linear acceleration when the browser only gives it with gravity", () => {
    const r = new MotionReader();
    for (let i = 0; i < 30; i++) r.read(ev([0, 0, 9.8], null), i * dt);
    const s = r.read(ev([15, 0, 9.8], null), 30 * dt)!;
    expect(s.ax).toBeGreaterThan(10);
  });
});
