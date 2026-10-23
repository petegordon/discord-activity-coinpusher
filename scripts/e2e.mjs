// End-to-end: two (or more) headless Chrome players play a whole game on one shelf.
// Usage: node scripts/e2e.mjs [baseUrl] [relay|peerjs] [players]
// Expects `npm run preview` (wrangler dev) to be serving baseUrl.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const transport = process.argv[3] ?? "relay";
const count = Number(process.argv[4] ?? 2);
const room = `E2E${Date.now().toString(36).toUpperCase()}`;
const names = ["Alice", "Bob", "Cara", "Dan"];
const outDir = "scripts/out";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
});

const errors = [];
/** Fail instead of hanging if `promise` doesn't settle in `ms`. */
const within = (promise, ms, what) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error(`timed out: ${what}`)), ms))]);
const players = [];
for (let i = 0; i < count; i++) {
  const ctx = await browser.newContext({ viewport: i === 0 ? { width: 1100, height: 760 } : { width: 390, height: 780 }, deviceScaleFactor: 1 });
  await ctx.addInitScript((name) => localStorage.setItem("dozer.name", name), names[i]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${names[i]}] ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/is taken|Aborting|Could not connect to peer/.test(m.text()) && errors.push(`[${names[i]}] console: ${m.text()}`));
  await page.goto(`${base}/?room=${room}&t=${transport}&nomotion&debug`);
  await page.waitForFunction(() => window.dozer?.room?.players?.length > 0, null, { timeout: 30_000, polling: 200 });
  players.push({ name: names[i], page });
  await page.waitForTimeout(300);
}

const dump = async () => {
  for (const p of players) {
    try {
      console.log(p.name, JSON.stringify(await p.page.evaluate(() => ({
        isHost: window.dozer.room.isHost, phase: window.dozer.room.game.phase, coins: window.dozer.room.game.coins, score: window.dozer.room.game.score,
        bodies: window.dozer.room.bodies.size, drawn: window.dozer.scene.counts, tilt: window.dozer.room.lastFrame?.tilt,
        zone: document.querySelector(".zone-title")?.textContent, status: document.getElementById("status").textContent,
      }))));
    } catch (err) { console.log(p.name, "eval failed", err.message); }
  }
  console.log("errors:", errors);
};
process.on("unhandledRejection", async (e) => {
  console.log("FAILED:", e.message.split("\n")[0], "at line", (e.stack.match(/e2e\.mjs:(\d+)/) ?? [])[1]);
  await dump();
  process.exit(2);
});

const game = (p) => p.page.evaluate(() => window.dozer.room.game);
await Promise.all(players.map((p) => p.page.waitForFunction((n) => window.dozer.room.players.length === n, count, { timeout: 30_000, polling: 200 })));
const host = (await Promise.all(players.map((p) => p.page.evaluate(() => window.dozer.room.isHost)))).indexOf(true);
console.log("joined; host:", players[host].name);

// The shelf appears in the lobby, once the host's physics has loaded.
await Promise.all(players.map((p) => p.page.waitForFunction(() => window.dozer.scene.counts.coins > 100, null, { timeout: 60_000, polling: 250 })));
console.log("shelf drawn for everyone:", JSON.stringify(await players[0].page.evaluate(() => window.dozer.scene.counts)));
await players[0].page.screenshot({ path: `${outDir}/${transport}-lobby.png` });

await players[host].page.selectOption("#coins-each", "20");
await players[host].page.click("#start");
await Promise.all(players.map((p) => p.page.waitForFunction(() => window.dozer.room.game.phase === "playing", null, { timeout: 10_000, polling: 100 })));

// Each player drops a few coins by tapping their pad, aimed with the arrow keys.
for (let round = 0; round < 6; round++) {
  for (const [i, p] of players.entries()) {
    await p.page.keyboard.press(round % 2 ? "ArrowLeft" : "ArrowRight");
    await p.page.click("#zone", { position: { x: 60 + i * 20, y: 40 } });
  }
  await players[0].page.waitForTimeout(420);
}
await players[0].page.waitForTimeout(800);
const afterDrops = await game(players[0]);
console.log("after drops: dropped", afterDrops.dropped, "coins", JSON.stringify(afterDrops.coins));
if (afterDrops.dropped !== 6 * count) throw new Error(`expected ${6 * count} drops, got ${afterDrops.dropped}`);
await players[0].page.screenshot({ path: `${outDir}/${transport}-playing.png` });

// Everyone shakes at once: one synchronized shake.
const seen = players[0].page.evaluate(
  () =>
    new Promise((resolve) => {
      window.dozer.room.on("frame", (f) => {
        for (const e of f.events) if (e.k === "shake") resolve(e);
      });
    }),
);
// Press SHAKE on every page at once (Playwright clicks can land >300 ms apart).
await Promise.all(players.map((p) => p.page.evaluate(() => document.getElementById("shake-btn").click())));
const shake = await within(seen, 10_000, "shake event");
console.log("shake:", JSON.stringify(shake));
if (count > 1 && shake.by.length !== count) throw new Error("shakes didn't combine");
await players[0].page.waitForTimeout(200);
await players[0].page.screenshot({ path: `${outDir}/${transport}-shake.png` });

// Shake again until the tilt alarm locks the shelf.
for (let i = 0; i < 4; i++) {
  await players[0].page.waitForTimeout(500);
  await Promise.all(players.map((p) => p.page.click("#shake-btn", { force: true }).catch(() => {})));
}
await players[0].page.waitForFunction(() => window.dozer.room.lastFrame?.locked > 0, null, { timeout: 5000, polling: 100 });
await players[0].page.waitForTimeout(400);
await players[0].page.screenshot({ path: `${outDir}/${transport}-tilt.png` });
console.log("tilted; zone says:", await players[0].page.textContent(".zone-title"));
await players[0].page.waitForFunction(() => window.dozer.room.lastFrame?.locked === 0, null, { timeout: 8000, polling: 200 });

// Play everything out: keep tapping until the game ends.
const t0 = Date.now();
while (Date.now() - t0 < 180_000) {
  const g = await game(players[0]);
  if (g.phase === "over") break;
  for (const p of players) {
    const mine = await p.page.evaluate(() => window.dozer.room.game.coins[window.dozer.self.id] ?? 0);
    if (mine > 0) await p.page.keyboard.press("Space");
  }
  await players[0].page.waitForTimeout(380);
}
await Promise.all(players.map((p) => p.page.waitForFunction(() => window.dozer.room.game.phase === "over", null, { timeout: 30_000, polling: 250 })));
await players[0].page.waitForTimeout(500);
await players[0].page.screenshot({ path: `${outDir}/${transport}-over.png` });

const finals = await Promise.all(players.map(game));
const key = (g) => JSON.stringify({ score: g.score, coins: g.coins, dropped: g.dropped, won: g.coinsWon, lost: g.coinsLost });
const consistent = finals.every((g) => key(g) === key(finals[0]));
const f = finals[0];
// Coins are conserved: every coin in hand at the start is either still in hand, or was dropped; drops come back only via the tray.
const conserved = Object.values(f.coins).reduce((a, b) => a + b, 0) === 20 * count - f.dropped + f.coinsWon;
console.log("final:", key(f), "prizes", f.prizes, `(${Math.round((Date.now() - t0) / 1000)} s of play)`);
console.log("consistent across players:", consistent, "coins conserved:", conserved);
console.log("errors:", errors.length ? errors : "none");
await browser.close();
process.exit(consistent && conserved && !errors.length ? 0 : 1);
