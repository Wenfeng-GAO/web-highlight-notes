// Issue #19: after a single-page navigation the side panel must name the page
// the user is actually on, including when document.title changes well after
// pushState / replaceState / popstate. No second highlight required.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from '../fixtures/server.js';
import { answerPermissionDialog, chromeLocaleEnv } from './native.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = path.join(root, 'artifacts');

const CASES = [
  {
    tag: 'zh',
    locale: 'zh_CN',
    lang: 'zh-CN',
    highlight: '划线',
    exportLabel: '导出 MD',
    copied: '已复制 ✓',
    counts0: '0 条划线 · 0 条评论',
    counts1: '1 条划线 · 0 条评论',
    source: '来源：',
  },
  {
    tag: 'en',
    locale: 'en_US',
    lang: 'en-US',
    highlight: 'Highlight',
    exportLabel: 'Export MD',
    copied: 'Copied ✓',
    counts0: '0 highlights · 0 notes',
    counts1: '1 highlight · 0 notes',
    source: 'Source: ',
  },
];

async function selectParagraph(page) {
  const text = page.locator('#text');
  await expect(text).toBeVisible();
  const box = await text.boundingBox();
  if (!box) throw new Error('paragraph has no box');
  const y = box.y + Math.min(12, box.height / 2);
  await page.mouse.move(box.x + 8, y);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.max(24, Math.min(box.width - 8, 320)), y, { steps: 12 });
  await page.mouse.up();
}

for (const c of CASES) {
  test(`side panel title follows a late SPA rename (${c.tag})`, async () => {
    fs.mkdirSync(artifacts, { recursive: true });
    const fixture = await startFixtureServer();
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `whn-spa-title-${c.tag}-`));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
      env: chromeLocaleEnv(c.locale),
      args: [
        `--disable-extensions-except=${root}`,
        `--load-extension=${root}`,
        '--no-first-run',
        '--disable-default-apps',
        `--lang=${c.lang}`,
      ],
    });
    try {
      let [worker] = context.serviceWorkers();
      if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
      const extensionId = new URL(worker.url()).host;
      expect(await worker.evaluate(() => chrome.i18n.getUILanguage())).toMatch(c.tag === 'zh' ? /^zh/ : /^en/);

      const page = context.pages()[0] || await context.newPage();
      const origin = `http://127.0.0.1:${fixture.port}`;
      await page.goto(`${origin}/spa/a`);
      await expect(page).toHaveTitle('SPA /spa/a');

      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`);
      await panel.evaluate(() => {
        const button = document.createElement('button');
        button.id = 'test-grant';
        button.textContent = 'grant';
        button.addEventListener('click', async () => {
          button.dataset.result = String(await chrome.permissions.request({ origins: ['http://127.0.0.1/*'] }));
        });
        document.body.prepend(button);
      });
      await panel.locator('#test-grant').click();
      await answerPermissionDialog(panel, true);
      await expect(panel.locator('#test-grant')).toHaveAttribute('data-result', 'true');

      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.whnReady || '')).toBe('1');
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.whnTab || '')).not.toBe('');
      const tabId = await page.evaluate(() => document.documentElement.dataset.whnTab);

      // QA repro: title follows pushState by 800ms. One highlight, then「页面 B」, then 2.5s.
      await page.evaluate(() => { sessionStorage.delay = '800'; });
      await selectParagraph(page);
      await page.getByRole('button', { name: c.highlight, exact: true }).click();
      await expect(page.locator('.whn-hl')).toHaveCount(1);

      await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?${new URLSearchParams({ tabId, url: page.url(), title: 'SPA /spa/a' })}`);
      await expect(panel.locator('#title')).toHaveText('SPA /spa/a');
      await expect(panel.locator('#counts')).toHaveText(c.counts1);

      await page.bringToFront();
      await page.getByRole('link', { name: '页面 B' }).click();
      await expect(page).toHaveURL(/\/spa\/b$/);
      await page.waitForTimeout(2500);
      await expect(page).toHaveTitle('SPA /spa/b');
      await expect(page.locator('.whn-hl')).toHaveCount(0);
      await expect(panel.locator('#title')).toHaveText('SPA /spa/b', { timeout: 1000 });
      await expect(panel.locator('#counts')).toHaveText(c.counts0);

      await panel.bringToFront();
      await panel.screenshot({ path: path.join(artifacts, `spa-title-page-b-${c.tag}.png`) });

      const downloadPromise = panel.waitForEvent('download');
      await panel.getByRole('button', { name: c.exportLabel, exact: true }).click();
      await expect(panel.getByRole('button', { name: c.copied, exact: true })).toBeVisible();
      const dest = path.join(os.tmpdir(), `whn-spa-title-${c.tag}-${Date.now()}.md`);
      await (await downloadPromise).saveAs(dest);
      const markdown = fs.readFileSync(dest, 'utf8');
      expect(markdown.startsWith('# SPA /spa/b\n')).toBe(true);
      expect(markdown).toContain(`${c.source}${origin}/spa/b`);

      // No delay: the view renames the document in the same turn as pushState.
      await page.bringToFront();
      await page.evaluate(() => { sessionStorage.delay = '0'; });
      await page.getByRole('link', { name: '页面 A' }).click();
      await expect(page).toHaveURL(/\/spa\/a$/);
      await expect(panel.locator('#title')).toHaveText('SPA /spa/a', { timeout: 1500 });
      await expect(panel.locator('#counts')).toHaveText(c.counts1);

      // Back button. Page B has no saved notes, and its title arrives 800ms after popstate.
      await page.evaluate(() => { sessionStorage.delay = '800'; });
      await page.goBack();
      await expect(page).toHaveURL(/\/spa\/b$/);
      await page.waitForTimeout(2500);
      await expect(page).toHaveTitle('SPA /spa/b');
      await expect(panel.locator('#title')).toHaveText('SPA /spa/b', { timeout: 1000 });
      await expect(panel.locator('#counts')).toHaveText(c.counts0);

      // replaceState to a url this session has never stored.
      await page.evaluate(() => {
        sessionStorage.delay = '800';
        history.replaceState({}, '', '/spa/c');
      });
      await expect(page).toHaveURL(/\/spa\/c$/);
      await page.waitForTimeout(2500);
      await expect(page).toHaveTitle('SPA /spa/c');
      await expect(panel.locator('#title')).toHaveText('SPA /spa/c', { timeout: 1000 });
      await expect(panel.locator('#counts')).toHaveText(c.counts0);

      // A normal (full) navigation still shows that document's own title.
      await page.bringToFront();
      await page.goto(`${origin}/article.html`);
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.whnReady || '')).toBe('1');
      await expect(panel.locator('#title')).toHaveText('测试文章：阅读与笔记');
    } finally {
      await context.close();
      await fixture.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
}
