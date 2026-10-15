// The grey hint under the file-access card's button, in both UI languages:
// 12px, #6B7280 (same as the card body, AA on the card background), set apart by
// its size and its own line under the button.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromeLocaleEnv, clickActionIcon, setFileAccess } from './native.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = process.env.WHN_SHOTS || '';

const CASES = [
  { tag: 'zh', locale: 'zh_CN', lang: 'zh-CN', title: '需要允许访问本地文件', button: '打开扩展设置', hint: '如果这不是本地文件，此页面不支持划线。' },
  { tag: 'en', locale: 'en_US', lang: 'en-US', title: 'Allow access to local files', button: 'Open extension settings', hint: "Not a local file? Highlighting isn't available on this page." },
];

function luminance(rgb) {
  const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map(Number).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

for (const c of CASES) {
  test(`file access off (${c.tag}): hint line under the button`, async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `whn-hint-${c.tag}-`));
    const docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-hint-doc-'));
    fs.copyFileSync(path.join(root, 'tests/fixtures/article.html'), path.join(docDir, 'a.html'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: { width: 1280, height: 800 },
      env: chromeLocaleEnv(c.locale),
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-first-run', `--lang=${c.lang}`],
    });
    try {
      let [worker] = context.serviceWorkers();
      if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
      const extensionId = new URL(worker.url()).host;
      worker = await setFileAccess(context, extensionId, false);
      const page = await context.newPage();
      await page.goto(pathToFileURL(path.join(docDir, 'a.html')).href);
      await clickActionIcon(page);
      const id = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
      const panel = await context.newPage();
      await panel.setViewportSize({ width: 360, height: 640 });
      await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?tabId=${id}`);
      const notice = panel.locator('#notice');
      await expect(notice).toBeVisible();
      await expect(notice.locator('.notice-title')).toHaveText(c.title);
      const hint = notice.locator('.notice-note');
      await expect(hint).toHaveText(c.hint);
      await expect(hint).toHaveCSS('font-size', '12px');
      await expect(hint).toHaveCSS('color', 'rgb(107, 114, 128)');
      // Same colour as the body text; the body keeps its colour.
      await expect(notice.locator('.notice-body')).toHaveCSS('color', 'rgb(107, 114, 128)');
      // Its own line, under the button.
      const button = await notice.getByRole('button', { name: c.button }).boundingBox();
      const hintBox = await hint.boundingBox();
      expect(hintBox.y).toBeGreaterThanOrEqual(button.y + button.height);
      // AA for normal text on the card background.
      const bg = await notice.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(contrast('rgb(107, 114, 128)', bg)).toBeGreaterThanOrEqual(4.5);
      if (shots) await panel.screenshot({ path: path.join(shots, `sidepanel-file-access-off-${c.tag}.png`) });
    } finally {
      await context.close();
      for (const dir of [userDataDir, docDir]) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
