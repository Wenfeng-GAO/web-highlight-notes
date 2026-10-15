// The file-access card in both UI languages (#11). With file access off Chrome shows a
// local file exactly like about:blank / data: / blob: (no tabs permission), so the copy
// must read right for both; there is no separate hint line.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromeLocaleEnv, clickActionIcon, setFileAccess } from './native.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = process.env.WHN_SHOTS || '';

const CASES = [
  { tag: 'zh', locale: 'zh_CN', lang: 'zh-CN', title: '此页面暂时不能划线', body: '如果是本地 HTML 文件，在扩展详情里打开“允许访问文件网址”即可', button: '打开扩展设置' },
  { tag: 'en', locale: 'en_US', lang: 'en-US', title: "Can't highlight on this page yet", body: 'If this is a local HTML file, turn on “Allow access to file URLs” in the extension details.', button: 'Open extension settings' },
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
  test(`file access off (${c.tag}): the card reads right for a local file and for blank pages`, async () => {
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
      await expect(notice.locator('.notice-body')).toHaveText(c.body);
      await expect(notice.getByRole('button', { name: c.button })).toBeVisible();
      await expect(notice.locator('.notice-note')).toHaveCount(0);
      await expect(notice.locator('.notice-title')).toHaveCSS('font-size', '13px');
      await expect(notice.locator('.notice-title')).toHaveCSS('font-weight', '700');
      await expect(notice.locator('.notice-body')).toHaveCSS('font-size', '12px');
      await expect(notice.locator('.notice-body')).toHaveCSS('color', 'rgb(107, 114, 128)');
      await expect(notice).toHaveCSS('background-color', 'rgb(249, 250, 251)');
      // AA for the body text on the card background.
      const bg = await notice.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(contrast('rgb(107, 114, 128)', bg)).toBeGreaterThanOrEqual(4.5);
      if (shots) await panel.screenshot({ path: path.join(shots, `sidepanel-file-access-off-${c.tag}.png`) });

      // about:blank looks the same to the extension, so it gets the same card; the copy
      // ("…暂时不能划线 / 如果是本地 HTML 文件…") is still true there.
      const blank = await context.newPage();
      await blank.goto('about:blank');
      await clickActionIcon(blank);
      const blankId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
      const blankPanel = await context.newPage();
      await blankPanel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?tabId=${blankId}`);
      await expect(blankPanel.locator('#notice .notice-title')).toHaveText(c.title);
    } finally {
      await context.close();
      for (const dir of [userDataDir, docDir]) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
