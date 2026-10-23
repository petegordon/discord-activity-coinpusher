// End-to-end test for the phone remote (PHONE-REMOTE.md).
// Usage: node scripts/e2e-remote.mjs [baseUrl] [relay|peerjs]
// Expects `npm run preview` (wrangler dev) to be serving baseUrl.
//
// 1. A remote opened before anyone is at the machine must not become host.
// 2. Bob (desktop, no motion) pairs a phone. With synthetic DeviceMotion the
//    phone rolls to aim his chute, flicks to drop his coins, and jerks up to shake.
// 3. The host leaves; Bob takes over the shelf and his phone keeps working.
// 4. "New link" on the table makes the old phone link stop working.
import { chromium } from "playwright-core";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const transport = process.argv[3] ?? "relay";
const room = `RMT${Date.now().toString(36).toUpperCase()}`;
const outDir = "scripts/out";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
});
const errors = [];
const watch = (page, label) => {
  page.on("pageerror", (e) => errors.push(`[${label}] ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/is taken|Aborting|Could not connect to peer|ERR_|status of 4/.test(m.text()) && errors.push(`[${label}] console: ${m.text()}`));
};
const fail = (msg) => {
  throw new Error(msg);
};
const poll = { polling: 200 };
/** Fail instead of hanging if `promise` doesn't settle in `ms`. */
const within = (promise, ms, what) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error(`timed out: ${what}`)), ms))]);

async function table(name) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  await ctx.addInitScript((n) => localStorage.setItem("dozer.name", n), name);
  const page = await ctx.newPage();
  watch(page, name);
  await page.goto(`${base}/?room=${room}&t=${transport}&nomotion&debug`);
  await page.waitForFunction(() => window.dozer?.room?.players?.length > 0, null, { timeout: 30_000, ...poll });
  return page;
}

/** A phone: touch, mobile viewport, and a steady stream of DeviceMotion events we can steer. Held flat, screen up. */
async function phone(url, label) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    // Headless Chrome has no DeviceMotionEvent; a stand-in with the same fields is enough for our reader.
    if (typeof DeviceMotionEvent === "undefined") {
      window.DeviceMotionEvent = class extends Event {
        constructor(type, init = {}) {
          super(type);
          Object.assign(this, { acceleration: null, accelerationIncludingGravity: null, rotationRate: null, interval: 16 }, init);
        }
      };
    }
    // a: linear acceleration; roll: degrees, right edge down positive.
    window.__motion = { a: [0, 0, 0], roll: 0 };
    setInterval(() => {
      const { a, roll } = window.__motion;
      const r = (roll * Math.PI) / 180;
      const g = [-9.8 * Math.sin(r), 0, 9.8 * Math.cos(r)];
      window.dispatchEvent(
        new DeviceMotionEvent("devicemotion", {
          acceleration: { x: a[0], y: a[1], z: a[2] },
          accelerationIncludingGravity: { x: a[0] + g[0], y: a[1] + g[1], z: a[2] + g[2] },
          rotationRate: { alpha: 0, beta: 0, gamma: 0 },
          interval: 16,
        }),
      );
    }, 16);
  });
  const page = await ctx.newPage();
  watch(page, label);
  await page.goto(url);
  await page.click("#r-connect");
  return page;
}

/** Hold the pad, roll the wrist to `roll`°, then flick forward. */
async function rollAndFlick(page, roll) {
  await page.waitForSelector("#zone.mine", { timeout: 15_000 });
  const sub = await page.textContent("#zone .zone-sub");
  if (!/roll your wrist/.test(sub)) fail(`phone isn't using motion: "${sub}"`);
  const box = await page.locator("#zone").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(async (roll) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 1; i <= 10; i++) {
      window.__motion = { a: [0, 0, 0], roll: (roll * i) / 10 };
      await sleep(30);
    }
    await sleep(200);
    window.__motion = { a: [0, 22, 0], roll };
    await sleep(64);
    window.__motion = { a: [0, 0, 0], roll };
    await sleep(400);
  }, roll);
  await page.mouse.up();
}

/** With the pad released, jerk the phone straight up. */
async function jerkUp(page) {
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__motion = { a: [0, 0, 20], roll: 0 };
    await sleep(64);
    window.__motion = { a: [0, 0, 0], roll: 0 };
    await sleep(400);
  });
}

const selfId = (page) => page.evaluate(() => window.dozer.self.id);
const game = (page) => page.evaluate(() => window.dozer.room.game);
/** Resolves with the first frame event of kind `k` the page sees from now on. */
const nextEvent = (page, k) =>
  page.evaluate(
    (k) =>
      new Promise((resolve) => {
        window.dozer.room.on("frame", (f) => {
          for (const e of f.events) if (e.k === k) resolve(e);
        });
      }),
    k,
  );

try {
  // ---- 1. A remote that shows up first never becomes host ----
  const early = await phone(`${base}/remote?room=${room}&t=${transport}&debug#k=${randomBytes(16).toString("hex")}`, "early-phone");
  await early.waitForTimeout(1500);
  const alice = await table("Alice");
  await alice.waitForFunction(() => window.dozer.room.isHost, null, { timeout: 30_000, ...poll });
  await early.waitForSelector("#r-message:not([hidden])", { timeout: 15_000 });
  console.log("unpaired remote first: table is host, remote says:", await early.textContent("#r-msg-title"));
  await early.context().close();

  // ---- 2. Bob (not the host) pairs a phone from the lobby and plays with it ----
  const bob = await table("Bob");
  await alice.waitForFunction(() => window.dozer.room.players.length === 2, null, { timeout: 30_000, ...poll });
  await bob.click("#lobby-phone");
  await bob.waitForSelector("#pair:not([hidden]) #pair-qr svg", { timeout: 5_000 });
  const link = (await bob.textContent("#pair-link")).trim();
  if (!link.includes("/remote?") || !link.includes("#k=")) fail(`bad link ${link}`);
  await bob.screenshot({ path: `${outDir}/remote-${transport}-pair.png` });

  const remote = await phone(link, "phone");
  const bobId = await selfId(bob);
  const remoteOnline = (page, want) =>
    page.waitForFunction(([id, w]) => window.dozer.room.players.find((p) => p.id === id)?.remoteOnline === w, [bobId, want], { timeout: 30_000, ...poll });
  await remoteOnline(bob, true);
  await remoteOnline(alice, true); // everyone sees the 📱 badge
  await bob.waitForSelector("#pair", { state: "hidden", timeout: 5_000 });
  if (remote.url().includes("#")) fail("remote kept the key in the address bar");

  await alice.waitForFunction(() => window.dozer.scene.counts.coins > 100, null, { timeout: 60_000, ...poll });
  await alice.click("#start");
  await bob.waitForFunction(() => document.querySelector("#zone .zone-title")?.textContent === "PLAY WITH YOUR PHONE", null, { timeout: 15_000, ...poll });

  // Roll right and flick: a coin from Bob's chute, aimed right, seen by Alice.
  const aimSeen = alice.evaluate(
    (id) => new Promise((resolve) => window.dozer.room.on("aim", (p, a) => p === id && a > 0.3 && resolve(a))),
    bobId,
  );
  const dropSeen = nextEvent(alice, "drop");
  await rollAndFlick(remote, 30);
  const aim = await within(aimSeen, 10_000, "aim seen at the table");
  const drop = await within(dropSeen, 10_000, "drop seen at the table");
  if (drop.by !== bobId) fail("the phone's drop was credited to someone else");
  await bob.waitForFunction((id) => window.dozer.room.game.coins[id] === 29, bobId, { timeout: 5_000, ...poll });
  console.log(`phone flick: dropped for Bob, aimed ${aim.toFixed(2)} rad; Bob has 29 coins`);
  await remote.screenshot({ path: `${outDir}/remote-${transport}-phone.png` });
  await alice.screenshot({ path: `${outDir}/remote-${transport}-table.png` });

  // Let go and jerk up: a shake by Bob.
  const shakeSeen = nextEvent(alice, "shake");
  await jerkUp(remote);
  const shake = await within(shakeSeen, 10_000, "shake seen at the table");
  if (!shake.by.includes(bobId)) fail("the jerk didn't shake for Bob");
  console.log("phone jerk up: shook the shelf, strength", shake.strength);
  const [ga, gb] = await Promise.all([game(alice), game(bob)]);
  if (JSON.stringify(ga.coins) !== JSON.stringify(gb.coins)) fail("tables disagree on coins");

  // ---- 3. The host leaves; Bob takes over the shelf and his phone keeps working ----
  const before = await bob.evaluate(() => window.dozer.room.bodies.size);
  await alice.context().close();
  await bob.waitForFunction(() => window.dozer.room.isHost && window.dozer.room.players.length === 1, null, { timeout: 60_000, ...poll });
  await bob.waitForFunction(() => window.dozer.room.host?.simReady, null, { timeout: 30_000, ...poll });
  await remoteOnline(bob, true);
  await bob.waitForTimeout(500);
  const after = await bob.evaluate(() => window.dozer.room.bodies.size);
  console.log(`host left: Bob is host, the shelf carried over (${before} -> ${after} bodies), phone still paired`);
  if (Math.abs(after - before) > 20) fail("the shelf was rebuilt instead of carried over");
  const coins = (await game(bob)).coins[bobId];
  await rollAndFlick(remote, -20);
  await bob.waitForFunction(([id, n]) => window.dozer.room.game.coins[id] < n, [bobId, coins], { timeout: 5_000, ...poll });
  console.log("phone still drops for Bob after the migration");

  // ---- 4. New link revokes the old one ----
  await bob.click("#remote-btn");
  await bob.click("#pair-new");
  await remote.waitForSelector("#r-message:not([hidden])", { timeout: 10_000 });
  console.log("after New link, old phone says:", await remote.textContent("#r-msg-title"));
  await remoteOnline(bob, false);

  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
  process.exit(errors.length ? 1 : 0);
} catch (e) {
  console.log("FAILED:", e.message.split("\n")[0], "at line", (e.stack.match(/e2e-remote\.mjs:(\d+)/) ?? [])[1]);
  console.log("errors:", errors);
  await browser.close();
  process.exit(2);
}
