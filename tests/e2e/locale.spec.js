// UI strings come from chrome.i18n; an English Chrome gets the en messages.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from '../fixtures/server.js';
import { chromeLocaleEnv, clickActionIcon } from './native.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('English Chrome shows English toolbar, bubble, prompt card, side panel and export', async () => {
  const fixture = await startFixtureServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-en-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    env: chromeLocaleEnv('en_US'),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-first-run', '--lang=en-US',
      '--host-resolver-rules=MAP *.test 127.0.0.1'],
  });
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).host;
    expect(await worker.evaluate(() => chrome.i18n.getUILanguage())).toMatch(/^en/);
    const page = context.pages()[0] || await context.newPage();
    const url = `http://en.test:${fixture.port}/article.html`;
    await page.goto(url);
    await clickActionIcon(page);
    await page.waitForFunction(() => document.documentElement.dataset.whnReady === '1');
    await page.evaluate(() => {
      const node = document.querySelector('#p2').firstChild;
      const range = document.createRange();
      range.selectNodeContents(node);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.querySelector('#p2').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    });
    await expect(page.getByRole('toolbar', { name: 'Highlight' })).toBeVisible();
    await page.getByRole('button', { name: 'Highlight + note', exact: true }).click();
    const bubble = page.getByRole('dialog', { name: 'Highlight note' });
    await expect(bubble.getByPlaceholder('Write a note')).toBeVisible();
    await expect(bubble.getByRole('button', { name: 'Delete highlight' })).toBeVisible();
    await bubble.getByRole('textbox', { name: 'Note' }).fill('english note');
    await bubble.getByRole('button', { name: 'Save', exact: true }).click();
    const card = page.frameLocator('#whn-root >> iframe.prompt');
    await expect(page.locator('#whn-root >> iframe.prompt')).toBeVisible();
    await page.waitForTimeout(300);
    // With the note bubble open, the card goes below the bubble, covering neither it nor the text.
    const rects = await page.evaluate(() => {
      const root = document.querySelector('#whn-root').shadowRoot;
      const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
      return { card: box(root.querySelector('iframe.prompt')), bubble: box(root.querySelector('.bubble')), text: box(document.querySelector('.whn-hl')) };
    });
    const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    expect(overlaps(rects.card, rects.bubble)).toBe(false);
    expect(overlaps(rects.card, rects.text)).toBe(false);
    await expect(card.getByText('Allow on this site to show highlights automatically after reload')).toBeVisible();
    await card.getByRole('button', { name: 'Not now' }).click();

    const tabId = await page.evaluate(() => document.documentElement.dataset.whnTab);
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?${new URLSearchParams({ tabId, url, title: 'Article' })}`);
    await expect(panel.locator('#counts')).toHaveText('1 highlight · 1 note');
    await expect(panel.locator('#status')).toHaveText('On this site, click the extension icon to show highlights Allow');
    await expect(panel.locator('#summary')).toHaveAttribute('placeholder', 'Page summary');
    const downloadPromise = panel.waitForEvent('download');
    await panel.getByRole('button', { name: 'Export MD', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Copied ✓', exact: true })).toBeVisible();
    const file = path.join(os.tmpdir(), `whn-en-${Date.now()}.md`);
    await (await downloadPromise).saveAs(file);
    const markdown = fs.readFileSync(file, 'utf8');
    expect(markdown).toMatch(/^# .+\nSource: http:\/\/en\.test:\d+\/article\.html · \d{4}-\d{2}-\d{2}\n## Summary\n\n## Highlights\n> /);
    expect(markdown).toContain('Note: english note');
  } finally {
    await context.close();
    await fixture.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
