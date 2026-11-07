// Close-up "logo" shot inside Carnival Dozer: one of the game's coins (controller heads, star tails)
// standing in front of the striped pusher. Usage:
//   node scripts/logo-3d.mjs out.png '{"fov":15,...}' [baseUrl]   (baseUrl defaults to https://coins.housetandem.com)
// The coin pile settles differently every run, so take a few shots and pick one.
// The shipped logo (public/brand/carnival-dozer-3d-*.png) used:
//   '{"light":false,"env":0.4,"metal":0.6,"rough":0.32,"gold":"#f2b53a","bump":3,"exp":0.92,"tiltY":-0.3,"tiltZ":-0.06,"hz":0.05,"tiltX":-0.2,"laneW":0.036,"fov":15,"cam":[-0.045,0.1,0.4],"look":[-0.007,0.036,0],"starEnv":0.25,"starRough":0.42,"flats":[[-0.026,0.05,0.22,1.1,-0.04,"tails"],[0.03,0.04,0.26,-0.25,0.05,"heads"],[0.006,0.088,0.24,0.1,0.0,"heads"],[0.052,-0.002,0.22,-0.6,0.0,"tails"],[-0.05,0.0,0.22,0.35,0.03,"heads"]]}'
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const out = process.argv[2];
const cfg = JSON.parse(process.argv[3] || "{}");
const base = process.argv[4] ?? "https://coins.housetandem.com";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 2 });
await ctx.addInitScript(() => localStorage.setItem("dozer.name", "Pete"));
const p = await ctx.newPage();
await p.goto(`${base}/?room=LOGO${Date.now().toString(36).toUpperCase()}&t=relay&debug`);
try { await p.waitForFunction(() => window.dozer?.scene?.counts.coins > 150, null, { timeout: 60_000 }); } catch (e) { await p.screenshot({ path: out.replace(".png", "-fail.png") }); console.log(await p.evaluate(() => JSON.stringify({ d: !!window.dozer, c: window.dozer?.scene?.counts }))); throw e; }
await p.waitForTimeout(cfg.settle ?? 2500);
await p.evaluate((cfg) => {
  for (const el of document.body.querySelectorAll("*")) if (!el.contains(document.querySelector("canvas")) && el.tagName !== "CANVAS") el.style.visibility = "hidden";
  const s = window.dozer.scene;
  s.resize = () => {};
  const cv = s.renderer.domElement;
  Object.assign(cv.style, { position: "fixed", left: "0", top: "0", width: "512px", height: "512px", zIndex: 99999, visibility: "visible" });
  s.renderer.setSize(512, 512, false);
  const cam = s.camera, pusher = s.pusher, coins = s.coins;
  const V = cam.position.constructor;
  // Freeze the pusher where it is.
  const pz = cfg.pusherZ ?? pusher.position.z;
  Object.defineProperty(pusher.position, "z", { get: () => pz, set() {} });
  const front = pz + 0.2; // pusher front face z
  for (const t of s.tracks.values()) if (t.mesh) t.mesh.visible = cfg.prizes ?? false;
  for (const c of s.chutes.values()) c.group.visible = false;
  s.dropLight.visible = false;
  s.renderer.toneMappingExposure = cfg.exp ?? 1;
  // The game's own coin materials (edge, heads, tails), in a solid gold instead of the per-instance tint.
  const mats = coins.material.map((m) => { const c = m.clone(); c.color.set(cfg.gold ?? "#ffc94a"); if (cfg.env != null) c.envMapIntensity = cfg.env; if (cfg.metal != null) c.metalness = cfg.metal; if (cfg.rough != null) c.roughness = cfg.rough; if (cfg.bump != null && c.bumpMap) c.bumpScale = cfg.bump; return c; });
  const hero = new pusher.constructor(new coins.geometry.constructor(0.022, 0.022, 0.008, 96), mats);
  hero.castShadow = hero.receiveShadow = true;
  const r = 0.022;
  hero.position.set(cfg.hx ?? 0, (cfg.hy ?? r + 0.003), front + (cfg.hz ?? 0.028));
  hero.rotation.set((cfg.tails ? -Math.PI / 2 : Math.PI / 2) + (cfg.tiltX ?? -0.12), cfg.tiltY ?? 0.35, cfg.tiltZ ?? 0.12, "YXZ");
  s.cabinet.add(hero);
  // Set a mesh down so its lowest vertex just touches the felt (y = 0).
  const V3 = cam.position.constructor;
  const restOnFloor = (mesh) => {
    mesh.updateMatrix();
    const pos = mesh.geometry.attributes.position, v = new V3();
    let min = Infinity;
    for (let i = 0; i < pos.count; i++) min = Math.min(min, v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrix).y);
    mesh.position.y += 0.0002 - min;
  };
  restOnFloor(hero);
  // Coins lying on the felt around the hero: [dx, dz, tilt x, yaw, tilt z, "heads" | "tails"].
  // "stars" is the older form, [dx, y, dz, rx, ry, rz], always tails; its y is ignored.
  const flats = [...(cfg.flats ?? []), ...(cfg.stars ?? []).map(([dx, , dz, rx, ry, rz]) => [dx, dz, rx, ry, rz, "tails"])];
  const starSpots = [];
  const starMats = mats.map((m) => { const c = m.clone(); c.envMapIntensity = cfg.starEnv ?? m.envMapIntensity; c.roughness = cfg.starRough ?? m.roughness; return c; });
  for (const [dx, dz, rx, ry, rz, face] of flats) {
    const coin = new pusher.constructor(hero.geometry, starMats);
    coin.castShadow = coin.receiveShadow = true;
    coin.position.set(hero.position.x + dx, 0, hero.position.z + dz);
    coin.rotation.set((face === "tails" ? Math.PI : 0) + rx, ry, rz, "YXZ");
    restOnFloor(coin);
    starSpots.push([coin.position.x, coin.position.z]);
    s.cabinet.add(coin);
  }
  // Clear a lane of pile coins between the camera and the hero coin.
  if (cfg.lane !== false) {
    const hz = hero.position.z, hx = hero.position.x, w = cfg.laneW ?? 0.06;
    const orig = coins.setMatrixAt.bind(coins);
    const zero = s.tmp.clone().makeScale(0, 0, 0);
    coins.setMatrixAt = (i, m) => { const e = m.elements; // Anything close enough to touch the hero or a star coin goes too, so no coin cuts into another.
      const nearStar = starSpots.some(([x, z]) => Math.hypot(e[12] - x, e[14] - z) < (cfg.starClear ?? 0.05));
      const nearHero = Math.hypot(e[12] - hx, e[14] - hz) < (cfg.heroClear ?? 0.05);
      orig(i, ((e[14] > hz - (cfg.laneBack ?? 0.012) && Math.abs(e[12] - hx) < w) || nearStar || nearHero) ? zero : m); };
  }
  if (cfg.light !== false) {
    const L = s.dropLight.constructor;
    const key = new L("#fff1cf", cfg.keyI ?? 0.6, 0.5, 1.5);
    key.position.set(hero.position.x + 0.05, hero.position.y + 0.06, hero.position.z + 0.08);
    s.cabinet.add(key);
  }
  cam.fov = cfg.fov ?? 32;
  cam.aspect = 1;
  cam.position.set(...(cfg.cam ? cfg.cam.map((v, i) => i === 2 ? front + v : v) : [0.05, 0.06, front + 0.2]));
  cam.lookAt(new V(...(cfg.look ?? [hero.position.x - 0.004, hero.position.y + 0.004, hero.position.z - 0.02])));
  cam.updateProjectionMatrix();
}, cfg);
await p.waitForTimeout(500);
await p.screenshot({ path: out, clip: { x: 0, y: 0, width: 512, height: 512 } });
await browser.close();
