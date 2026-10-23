import { beforeAll, describe, expect, it } from "vitest";
import { START_PILE, TABLE } from "../src/game/rules";
import { KIND_COIN, packBodies, unpackBodies } from "../src/sim/frame";
import { DozerSim, loadRapier, pusherAt } from "../src/sim/world";

let sim: DozerSim;
beforeAll(async () => {
  sim = new DozerSim(await loadRapier());
});

const run = (s: DozerSim, seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 60) s.step(1 / 60);
};

describe("DozerSim", () => {
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

