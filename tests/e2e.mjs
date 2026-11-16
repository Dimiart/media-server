// Наскрізна перевірка в Chromium: розширення завантажене, локальний сайт віддає
// тестові потоки HLS (див. README, розділ «Перевірка»).
// Запуск: node tests/e2e.mjs <папка_сайту> [папка_для_знімків]

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = path.resolve(process.argv[2]);
const shotsDir = process.argv[3] && path.resolve(process.argv[3]);
const PORT = 8765;
const origin = `http://127.0.0.1:${PORT}`;

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: siteDir, stdio: "ignore" });
const results = [];
const check = (name, ok, extra = "") => {
  results.push(ok);
  console.info(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
};

const context = await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(), "ms-profile-")), {
  channel: "chromium",
  acceptDownloads: true,
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
});

try {
  await new Promise((r) => setTimeout(r, 800));
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  const extId = new URL(worker.url()).host;

  const site = await context.newPage();
  // Playwright перейменовує завантаження; повертаємо звичайну поведінку Chrome.
  const downloadsDir = await mkdtemp(path.join(tmpdir(), "ms-downloads-"));
  const cdp = await context.newCDPSession(site);
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadsDir });
  await site.goto(`${origin}/index.html`);
  await site.waitForTimeout(2500);
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, `${origin}/*`);

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 440, height: 420 });
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`);
  await popup.waitForSelector(".item");
  const names = await popup.$$eval(".item .name", (els) => els.map((e) => e.textContent));
  check("знайдено master, два списки, mp4 і без сегментів .ts", names.length === 4 && names.includes("enc/index") && !names.some((n) => n.includes("seg")), names.join(", "));
  const badge = await worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
  check("лічильник на іконці", badge === "4", badge);
  if (shotsDir) await popup.screenshot({ path: path.join(shotsDir, "popup.png") });

  // Режим завантажень CDP ігнорує назву, яку задає розширення, тому шукаємо
  // наступне завершене завантаження й порівнюємо вміст.
  let lastId = 0;
  const waitDownload = async () => {
    for (let i = 0; i < 100; i++) {
      const done = await worker.evaluate(() => chrome.downloads.search({ state: "complete" }));
      const item = done.filter((d) => d.id > lastId).sort((a, b) => a.id - b.id)[0];
      if (item) {
        lastId = item.id;
        return item;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  };
  const sameBytes = (file, expected) => readFileSync(file).equals(readFileSync(path.join(siteDir, expected)));

  // 1. Звичайний файл.
  const row = (name) => popup.locator(".item", { has: popup.locator(".name", { hasText: name }) });
  await row("film").locator(".download").click();
  const film = await waitDownload();
  check("mp4 збережено без змін", Boolean(film) && sameBytes(film.filename, "film.mp4"), film?.filename);

  // 2. Головний список → зашифрований варіант 640x480.
  const hlsPage = async (name) => {
    const [page] = await Promise.all([context.waitForEvent("page"), row(name).locator(".download").click()]);
    await page.waitForSelector("#choose:not([hidden])");
    return page;
  };
  let page = await hlsPage("master");
  const options = await page.$$eval("#variant option", (els) => els.map((e) => e.textContent));
  check("варіанти якості від найкращого", options[0].startsWith("480p") && options.length === 2, options.join(" | "));
  await page.fill("#name", "ТЕСТ відео");
  if (await page.isVisible("#to-disk")) await page.uncheck("#to-disk");
  if (shotsDir) {
    await page.setViewportSize({ width: 720, height: 560 });
    await page.screenshot({ path: path.join(shotsDir, "download.png") });
  }
  await page.click("#start");
  await page.waitForFunction(() => document.getElementById("saved").children.length > 0, null, { timeout: 30000 })
    .catch(async (e) => {
      console.info("message:", await page.textContent("#message"));
      throw e;
    });
  check("назва з поля «Назва файлу»", /^(ТЕСТ відео|TEST video)\.ts$/.test(await page.textContent("#saved li")), await page.textContent("#saved li"));
  const enc = await waitDownload();
  check("AES-128 розшифровано, сегменти зібрано по порядку", Boolean(enc) && sameBytes(enc.filename, "expected-plain.ts"), enc?.filename);
  await page.close();

  // 3. fMP4 (init + .m4s) → .mp4.
  await popup.bringToFront();
  page = await hlsPage("fmp4/index");
  await page.fill("#name", "ТЕСТ fmp4");
  if (await page.isVisible("#to-disk")) await page.uncheck("#to-disk");
  await page.click("#start");
  await page.waitForFunction(() => document.getElementById("saved").children.length > 0, null, { timeout: 30000 });
  check("fMP4 отримує розширення .mp4", /fmp4\.mp4$/.test(await page.textContent("#saved li")), await page.textContent("#saved li"));
  const fmp4 = await waitDownload();
  check("fMP4 зібрано в .mp4", Boolean(fmp4) && sameBytes(fmp4.filename, "expected-fmp4.mp4"), fmp4?.filename);

  // 4. Нова навігація очищає список.
  await site.goto(`${origin}/plain/index.m3u8`).catch(() => {});
  await site.goto("about:blank");
  await popup.waitForTimeout(500);
  const left = await worker.evaluate((id) => chrome.storage.session.get(`tab:${id}`), tabId);
  check("після переходу список порожній", (left[`tab:${tabId}`]?.items.length || 0) === 0);
} finally {
  await context.close();
  server.kill();
}

const failed = results.filter((r) => !r).length;
console.info(`\n${results.length - failed}/${results.length} перевірок пройдено`);
process.exit(failed ? 1 : 0);
