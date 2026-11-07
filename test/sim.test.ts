import { beforeAll, describe, expect, it } from "vitest";
import { chuteX, COIN, START_PILE, TABLE } from "../src/game/rules";
import { KIND_COIN, packBodies, unpackBodies } from "../src/sim/frame";
import { DozerSim, loadRapier, pusherAt, TAILS_UP_SHARE } from "../src/sim/world";

let sim: DozerSim;
beforeAll(async () => {
  sim = new DozerSim(await loadRapier());
});

const run = (s: DozerSim, seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 60) s.step(1 / 60);
};

// Real Rapier physics: a few of these run many simulated seconds, close to the 5 s default on a busy machine.
describe("DozerSim", { timeout: 20_000 }, () => {
  it("starts with a settled pile, a four-prize tower, and nothing counted", () => {
    const t0 = performance.now();
    sim.reset(42);
    const ms = performance.now() - t0;
    console.log(`reset: ${ms.toFixed(0)} ms, coins ${sim.coinCount}, prizes ${sim.prizeCount}`);
    expect(sim.coinCount).toBeGreaterThan(START_PILE * 0.7);
    expect(sim.prizeCount).toBe(4);
    expect(sim.takeOuts()).toEqual([]);
    for (const b of sim.all()) {
      expect(b.p[1]).toBeGreaterThan(-0.01);
      expect(b.p[1]).toBeLessThan(0.3);
      expect(Math.abs(b.p[0])).toBeLessThan(TABLE.halfWidth);
    }
  });

  it("starts with stacks of coins standing near the front edge", () => {
    for (const seed of [42, 7, 9]) {
      sim.reset(seed);
      const coins = sim.all().filter((b) => b.kind === KIND_COIN);
      // A coin sitting squarely on another one, as in a stack (the loose pile is never this neat).
      const stacked = coins.filter(
        (a) => a.p[2] > 0.12 && coins.some((b) => b !== a && Math.hypot(a.p[0] - b.p[0], a.p[2] - b.p[2]) < 0.004 && Math.abs(a.p[1] - b.p[1] - 0.0085) < 0.002),
      );
      console.log(`seed ${seed}: ${stacked.length} coins sitting in stacks near the edge`);
      expect(stacked.length).toBeGreaterThanOrEqual(6);
    }
  });

  it("starts with roughly 40% of the pile star side (tails) up, the rest controller (heads) up", () => {
    expect(TAILS_UP_SHARE).toBe(0.4);
    for (const seed of [42, 7, 9]) {
      sim.reset(seed);
      // Lying roughly flat; the coin's own up axis (y) rotated by its quaternion, pointing down = tails up.
      const flat = sim.all().filter((b) => b.kind === KIND_COIN).map(({ q: [x, , z] }) => 1 - 2 * (x * x + z * z)).filter((upY) => Math.abs(upY) > 0.7);
      const tails = flat.filter((upY) => upY < 0).length / flat.length;
      console.log(`seed ${seed}: ${(tails * 100).toFixed(0)}% tails up of ${flat.length} flat coins`);
      expect(tails).toBeGreaterThanOrEqual(0.35);
      expect(tails).toBeLessThanOrEqual(0.45);
    }
  });

  it("never lets a coin sink into the felt", () => {
    for (const seed of [42, 7, 9]) {
      sim.reset(seed);
      run(sim, 3);
      let lowest = Infinity;
      for (const { kind, p, q: [x, , z] } of sim.all()) {
        if (kind !== KIND_COIN || Math.abs(p[0]) > TABLE.halfWidth || p[2] > TABLE.frontZ) continue;
        // The coin's lowest point: half its thickness along its axis, plus its radius across the tilt.
        const upY = Math.abs(1 - 2 * (x * x + z * z));
        lowest = Math.min(lowest, p[1] - (COIN.thickness / 2) * upY - COIN.radius * Math.sqrt(Math.max(0, 1 - upY * upY)));
      }
      console.log(`seed ${seed}: lowest coin point ${(lowest * 1000).toFixed(2)} mm`);
      // Rapier lets resting contacts settle up to ~1 mm in under the pile's weight; a sinking coin goes much deeper.
      expect(lowest).toBeGreaterThan(-0.002);
    }
  });

  it("is the same pile for the same seed", async () => {
    const other = new DozerSim(await loadRapier());
    other.reset(42);
    sim.reset(42);
    expect(other.all().slice(0, 10)).toEqual(sim.all().slice(0, 10));
    other.free();
  });

  it("drops coins from the chute onto the shelf, and the pusher shoves coins off the front", () => {
    sim.reset(7);
    const t0 = performance.now();
    let outs = 0;
    let tray = 0;
    for (let i = 0; i < 40; i++) {
      sim.drop(((i % 5) - 2) * 0.1, ((i % 3) - 1) * 0.3, (i % 4) / 3, 0.5);
      run(sim, 0.5);
      const o = sim.takeOuts();
      outs += o.length;
      tray += o.filter((x) => x.tray).length;
    }
    const perSec = (performance.now() - t0) / 20;
    console.log(`40 drops over 20 s: ${outs} fell (${tray} into the tray), ${perSec.toFixed(1)} ms of CPU per simulated second, coins now ${sim.coinCount}`);
    expect(outs).toBeGreaterThan(5);
    expect(tray).toBeGreaterThan(0);
  });

  it("from every chute, a full left or right aim lands on the shelf, not straight in a gutter", () => {
    // Every chute position a table of 2, 3 or 4 uses.
    const xs = [...new Set([2, 3, 4].flatMap((n) => Array.from({ length: n }, (_, i) => chuteX(i, n).toFixed(4))))].map(Number);
    let landed = 0;
    const lost: string[] = [];
    sim.reset(11);
    sim.locked = true; // the pusher still, so only the throw decides
    for (const x of xs) {
      for (const side of [-1, 1]) {
        for (const power of [0, 0.5, 1]) {
          const id = sim.drop(x, side * TABLE.maxAim, power, 0);
          run(sim, 1.2);
          const coin = sim.all().find((b) => b.id === id);
          if (coin && Math.abs(coin.p[0]) < TABLE.halfWidth && coin.p[2] < TABLE.frontZ) landed++;
          else lost.push(`x ${x} aim ${side > 0 ? "right" : "left"} power ${power}`);
        }
      }
    }
    sim.locked = false;
    sim.takeOuts();
    console.log(`full-aim drops from ${xs.length} chute positions: ${landed} landed on the shelf, ${lost.length} went straight off ${lost.join("; ")}`);
    expect(lost).toEqual([]);
  }, 60_000);

  it("a shake rocks the prizes but doesn't sweep the coins off", () => {
    let moved = 0;
    let coinsOff = 0;
    for (const seed of [9, 10, 11, 12]) {
      sim.reset(seed);
      run(sim, 1);
      sim.takeOuts();
      const before = sim.all().filter((b) => b.kind !== KIND_COIN);
      expect(before.length).toBe(4);
      sim.shake(3);
      run(sim, 2);
      coinsOff += sim.takeOuts().filter((o) => o.kind === KIND_COIN).length;
      for (const b of sim.all().filter((x) => x.kind !== KIND_COIN)) {
        const was = before.find((x) => x.id === b.id);
        if (was) moved += Math.hypot(b.p[0] - was.p[0], b.p[2] - was.p[2]);
      }
    }
    expect(moved / 16).toBeGreaterThan(0.002); // each prize shifts a few mm on average
    expect(coinsOff / 4).toBeLessThan(2); // a strong shake knocks off a coin or so, not a wave
  });

  it("stops the pusher while locked", () => {
    sim.reset(3);
    sim.locked = true;
    const z = sim.pusherZ;
    run(sim, 1);
    expect(sim.pusherZ).toBe(z);
    sim.locked = false;
    run(sim, 0.3);
    expect(sim.pusherZ).not.toBe(z);
  });

  it("sends only what moved, then everything on a keyframe", () => {
    sim.reset(5);
    const first = sim.delta(true);
    expect(first.bodies.length).toBe(sim.coinCount + sim.prizeCount);
    run(sim, 0.07);
    const next = sim.delta(false);
    expect(next.bodies.length).toBeLessThan(first.bodies.length);
  });

  it("restores from a frame with the same ids", async () => {
    sim.reset(11);
    run(sim, 0.5);
    const bodies = unpackBodies(packBodies(sim.all()));
    const other = new DozerSim(await loadRapier());
    other.restore(bodies, 10);
    expect(other.all().map((b) => b.id).sort()).toEqual(bodies.map((b) => b.id).sort());
    run(other, 1);
    expect(other.coinCount).toBeGreaterThan(50);
    other.free();
  });
});

describe("pusherAt", () => {
  it("sweeps between its limits", () => {
    const zs = Array.from({ length: 100 }, (_, i) => pusherAt((i / 100) * TABLE.pusherPeriodS));
    expect(Math.min(...zs)).toBeCloseTo(TABLE.pusherMinZ, 2);
    expect(Math.max(...zs)).toBeCloseTo(TABLE.pusherMaxZ, 2);
  });
});

