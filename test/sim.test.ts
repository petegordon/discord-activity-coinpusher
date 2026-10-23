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

  it("a shake moves the prizes forward", () => {
    sim.reset(9);
    const before = sim.all().filter((b) => b.kind !== KIND_COIN);
    sim.shake(3);
    run(sim, 0.4);
    const after = sim.all().filter((b) => b.kind !== KIND_COIN);
    const dz = after.reduce((a, b) => a + b.p[2] - (before.find((x) => x.id === b.id)?.p[2] ?? b.p[2]), 0);
    expect(before.length).toBe(4);
    expect(dz).toBeGreaterThan(0);
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

