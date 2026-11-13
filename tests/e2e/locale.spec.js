// UI strings come from chrome.i18n; an English Chrome gets the en messages.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from '../fixtures/server.js';
import { chromeLocaleEnv, clickActionIcon } from './native.js';
import { expectOverlay, overlayBox, overlayButton, overlayDialog, overlayToolbar, readyPrompt } from './overlay-ui.js';

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
    await expectOverlay(overlayToolbar(page, 'Highlight')).toBeVisible();
    await overlayButton(page, 'Highlight + note').click();
    const bubble = overlayDialog(page, 'Highlight note');
    await expectOverlay(bubble.getByPlaceholder('Write a note')).toBeVisible();
    await expectOverlay(bubble.getByRole('button', { name: 'Delete highlight' })).toBeVisible();
    await bubble.getByRole('textbox', { name: 'Note' }).fill('english note');
    await bubble.getByRole('button', { name: 'Save', exact: true }).click();
    const card = await readyPrompt(page);
    await page.waitForTimeout(300);
    // With the note bubble open, the card goes below the bubble, covering neither it nor the text.
    const text = await page.locator('.whn-hl').boundingBox();
    const rects = {
      card: await overlayBox(page, 'iframe.prompt'),
      bubble: await overlayBox(page, '.bubble'),
      text: text ? { top: text.y, bottom: text.y + text.height, left: text.x, right: text.x + text.width } : null,
    };
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
