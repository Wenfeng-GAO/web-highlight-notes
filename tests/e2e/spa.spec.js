// Issue #7: single-page sites change the URL with history.pushState. Notes must follow
// the URL the user sees: saved under it, restored at it, and shown for it in the side panel.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pageKey } from '../../src/lib/url.js';
import { chromeLocaleEnv } from './native.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const QUOTE_A = '春天的花园里开满了黄色的花';
const QUOTE_B = '研究者在图书馆发现了一份手稿';

let context;
let worker;
let extensionId;
let userDataDir;
let docDir;
let base;

const ready = (page) => page.evaluate(() => document.documentElement.dataset.whnReady || '');
const tabIdOf = (page) => page.evaluate(() => Number(document.documentElement.dataset.whnTab));
const stored = (key) => worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k] || null, key);
const contentKey = async (page) => (await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'whn:info' }), await tabIdOf(page)))?.url;
const urlFor = (view) => `${base}?view=${view}`;

async function highlight(page, quote) {
  await expect(page.locator('#text')).toContainText(quote);
  await page.evaluate((text) => {
    const node = document.querySelector('#text').firstChild;
    const index = node.nodeValue.indexOf(text);
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + text.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    node.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  }, quote);
  await page.getByRole('button', { name: '划线', exact: true }).click();
  await expect(page.locator('.whn-hl', { hasText: quote })).toHaveCount(1);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-spa-'));
  fs.copyFileSync(path.join(root, 'tests/fixtures/spa.html'), path.join(docDir, 'spa.html'));
  base = pathToFileURL(path.join(docDir, 'spa.html')).href;
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-spa-profile-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    env: chromeLocaleEnv('zh_CN'),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-first-run', '--lang=zh-CN'],
  });
  [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  for (const dir of [userDataDir, docDir]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('pushState: new notes are saved under the new URL and restore there; back restores the old view', async () => {
  const page = context.pages()[0] || await context.newPage();
  await page.goto(urlFor('a'));
  await expect.poll(() => ready(page)).toBe('1');
  await highlight(page, QUOTE_A);
  expect((await stored(pageKey(urlFor('a')))).highlights.map((h) => h.text)).toEqual([QUOTE_A]);

  // In-app navigation to view b.
  await page.click('#to-b');
  await expect.poll(() => contentKey(page)).toBe(pageKey(urlFor('b')));
  await expect(page.locator('#text')).toContainText(QUOTE_B);
  await expect(page.locator('.whn-hl')).toHaveCount(0);
  await highlight(page, QUOTE_B);
  await expect.poll(async () => (await stored(pageKey(urlFor('b'))))?.highlights?.map((h) => h.text)).toEqual([QUOTE_B]);
  expect((await stored(pageKey(urlFor('a')))).highlights.map((h) => h.text)).toEqual([QUOTE_A]);
  await expect.poll(async () => (await stored(pageKey(urlFor('b'))))?.title).toBe('乙视图');

  // The side panel shows view b, then follows the page back to view a.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?tabId=${await tabIdOf(page)}`);
  await expect(panel.locator('#title')).toHaveText('乙视图');
  await expect(panel.locator('.quote')).toHaveText([QUOTE_B]);
  await page.bringToFront();
  await page.goBack();
  await expect.poll(() => contentKey(page)).toBe(pageKey(urlFor('a')));
  // The view renders 200 ms after popstate; the highlight is anchored again once it does.
  await expect(page.locator('.whn-hl', { hasText: QUOTE_A })).toHaveCount(1);
  await expect(panel.locator('#title')).toHaveText('甲视图');
  await expect(panel.locator('.quote')).toHaveText([QUOTE_A]);
  await panel.close();

  // A reload at either URL shows that URL's notes.
  await page.goto(urlFor('b'));
  await expect.poll(() => ready(page)).toBe('1');
  await expect(page.locator('.whn-hl', { hasText: QUOTE_B })).toHaveCount(1);
  await expect(page.locator('.whn-hl')).toHaveCount(1);
});

test('a hash change is the same page: highlights stay', async () => {
  const page = context.pages()[0];
  await page.evaluate(() => { location.hash = 'part-2'; });
  await page.waitForTimeout(800);
  expect(await contentKey(page)).toBe(pageKey(urlFor('b')));
  await expect(page.locator('.whn-hl', { hasText: QUOTE_B })).toHaveCount(1);
});

