// 0.1.4 permission model: no host access at install. A toolbar click (activeTab)
// runs the extension on the current page; granting a site registers a persistent
// content script so highlights restore on reload with no click.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageKey } from '../../src/lib/url.js';
import { startFixtureServer } from '../fixtures/server.js';
import { answerPermissionDialog, chromeLocaleEnv, clickActionIcon } from './native.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = process.env.WHN_SHOTS || '';
const QUOTE_1 = '春天的花园里开满了黄色的花';
const QUOTE_2 = '研究者在图书馆发现了一份手稿';

let fixture;
let context;
let worker;
let extensionId;
let userDataDir;

// Distinct sites on one local server: a.test (granted), b.test (never touched), c.test (declined).
const site = (host) => `http://${host}:${fixture.port}/article.html`;

async function selectText(page, selector, text) {
  const ok = await page.evaluate(({ css, quote }) => {
    const element = document.querySelector(css);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = (node.nodeValue || '').indexOf(quote);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + quote.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      node.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      return true;
    }
    return false;
  }, { css: selector, quote: text });
  if (!ok) throw new Error(`could not select ${text}`);
}

async function highlight(page, selector, text) {
  await selectText(page, selector, text);
  await page.getByRole('button', { name: '划线', exact: true }).click();
  await expect(page.locator('.whn-hl', { hasText: text })).toHaveCount(1);
}

const ready = (page) => page.evaluate(() => document.documentElement.dataset.whnReady || '');
const promptFrame = (page) => page.frameLocator('#whn-root >> iframe.prompt');

/** Viewport rects of the card and of the given highlight (union of its spans). */
async function cardAndHighlightRects(page, text) {
  return page.evaluate((quote) => {
    const card = document.querySelector('#whn-root').shadowRoot.querySelector('iframe.prompt').getBoundingClientRect();
    const spans = [...document.querySelectorAll('.whn-hl')].filter((el) => {
      const id = el.dataset.whnId;
      return [...document.querySelectorAll(`.whn-hl[data-whn-id="${id}"]`)].map((n) => n.textContent).join('') === quote;
    });
    const rects = spans.map((el) => el.getBoundingClientRect());
    const hl = {
      top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)),
      left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)),
    };
    return { card: { top: card.top, bottom: card.bottom, left: card.left, right: card.right, width: card.width }, hl, viewport: innerHeight };
  }, text);
}

function overlaps(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

async function stored(key) {
  return worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k] || null, key);
}

async function registeredMatches() {
  return worker.evaluate(async () => {
    const [script] = await chrome.scripting.getRegisteredContentScripts({ ids: ['whn-auto'] });
    return script?.matches || [];
  });
}

async function contains(pattern) {
  return worker.evaluate((origins) => chrome.permissions.contains({ origins }), [pattern]);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fixture = await startFixtureServer();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-perm-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    env: chromeLocaleEnv('zh_CN'),
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      '--no-first-run',
      '--disable-default-apps',
      '--lang=zh-CN',
      '--host-resolver-rules=MAP *.test 127.0.0.1',
    ],
  });
  [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  await fixture?.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

test('manifest asks for no host access at install and drops tabs', async () => {
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.permissions.sort()).toEqual(['activeTab', 'scripting', 'sidePanel', 'storage']);
  expect(manifest.host_permissions || []).toEqual([]);
  expect(manifest.content_scripts || []).toEqual([]);
  expect(manifest.optional_host_permissions).toEqual(['http://*/*', 'https://*/*']);
  expect((await worker.evaluate(() => chrome.permissions.getAll())).origins).toEqual([]);
});

test('before any grant: nothing auto-injects; an icon click (activeTab) makes highlighting work and offers the grant card', async () => {
  const page = context.pages()[0] || await context.newPage();
  await page.goto(site('a.test'));
  await page.waitForTimeout(1000);
  expect(await ready(page)).toBe('');
  await expect(page.locator('#whn-root')).toHaveCount(0);

  await clickActionIcon(page);
  await expect.poll(() => ready(page)).toBe('1');
  await highlight(page, '#p1', QUOTE_1);
  expect((await stored(pageKey(page.url())))?.highlights?.map((h) => h.text)).toEqual([QUOTE_1]);

  const card = promptFrame(page);
  await expect(card.getByText('允许在此网站自动显示划线，刷新后仍在')).toBeVisible();
  await expect(card.getByRole('button', { name: '允许', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: '暂不', exact: true })).toBeVisible();
  // The card sits 8px under the highlighted text and never covers it.
  await page.waitForTimeout(300);
  const placed = await cardAndHighlightRects(page, QUOTE_1);
  expect(Math.round(placed.card.width)).toBe(240);
  expect(overlaps(placed.card, placed.hl)).toBe(false);
  expect(Math.round(placed.card.top - placed.hl.bottom)).toBe(8);
  if (shots) await page.screenshot({ path: path.join(shots, 'prompt-card.png') });
});

test('allow grants only this site; reload restores highlights with no click', async () => {
  const page = context.pages()[0];
  await promptFrame(page).getByRole('button', { name: '允许', exact: true }).click();
  await answerPermissionDialog(page, true);
  await expect.poll(() => contains('http://a.test/*')).toBe(true);
  await expect(page.locator('#whn-root >> iframe.prompt')).toBeHidden();
  expect(await contains('http://b.test/*')).toBe(false);
  await expect.poll(registeredMatches).toEqual(['http://a.test/*']);

  await page.reload();
  await expect.poll(() => ready(page)).toBe('1');
  await expect(page.locator('.whn-hl', { hasText: QUOTE_1 })).toHaveCount(1);

  // A new highlight on a granted site does not prompt again.
  await highlight(page, '#p2', QUOTE_2);
  await page.waitForTimeout(500);
  await expect(page.locator('#whn-root >> iframe.prompt')).toBeHidden();
});

test('the card flips above the selection when there is no room below, still without overlap', async () => {
  const page = await context.newPage();
  await page.goto(site('e.test'));
  await clickActionIcon(page);
  await expect.poll(() => ready(page)).toBe('1');
  // Put #p2 at the very bottom of the viewport.
  await page.evaluate(() => {
    const el = document.querySelector('#p2');
    const push = innerHeight - el.getBoundingClientRect().bottom - 10;
    document.body.style.paddingTop = `${push}px`;
  });
  expect(await page.evaluate(() => innerHeight - document.querySelector('#p2').getBoundingClientRect().bottom)).toBeLessThan(40);
  await selectText(page, '#p2', QUOTE_2);
  await page.getByRole('button', { name: '划线', exact: true }).click();
  await expect(page.locator('#whn-root >> iframe.prompt')).toBeVisible();
  await page.waitForTimeout(300);
  const { card, hl } = await cardAndHighlightRects(page, QUOTE_2);
  expect(overlaps(card, hl)).toBe(false);
  expect(card.bottom).toBeLessThanOrEqual(hl.top);
  await page.close();
});

test('a site that was never granted does not auto-inject', async () => {
  const page = await context.newPage();
  await page.goto(site('b.test'));
  await page.waitForTimeout(1500);
  expect(await ready(page)).toBe('');
  await expect(page.locator('#whn-root')).toHaveCount(0);
  await page.close();
});

test('declined site: highlight saved, listed with 「此网站需点击插件图标显示划线」, exportable; reload hides it; icon click restores it', async () => {
  const page = await context.newPage();
  await page.goto(site('c.test'));
  await clickActionIcon(page);
  await expect.poll(() => ready(page)).toBe('1');
  await highlight(page, '#p1', QUOTE_1);

  // Decline in the native dialog (default button).
  await promptFrame(page).getByRole('button', { name: '允许', exact: true }).click();
  await answerPermissionDialog(page, false);
  await expect(page.locator('#whn-root >> iframe.prompt')).toBeHidden();
  expect(await contains('http://c.test/*')).toBe(false);
  const declined = await worker.evaluate(async () => (await chrome.storage.local.get('__whn:declined'))['__whn:declined']);
  expect(Object.keys(declined)).toEqual(['http://c.test/*']);
  const key = pageKey(page.url());
  expect((await stored(key)).highlights.map((h) => h.text)).toEqual([QUOTE_1]);

  // Side panel lists it with the status line and the 去授权 link; items carry no warning.
  const tabId = Number(await page.evaluate(() => document.documentElement.dataset.whnTab));
  const panel = await context.newPage();
  const params = new URLSearchParams({ tabId: String(tabId), url: page.url(), title: '测试文章：阅读与笔记' });
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?${params}`);
  await expect(panel.locator('.quote', { hasText: QUOTE_1 })).toBeVisible();
  await expect(panel.locator('#status')).toBeVisible();
  await expect(panel.locator('#status')).toHaveText('此网站需点击插件图标显示划线 去授权');
  await expect(panel.locator('#status')).toHaveCSS('color', 'rgb(180, 83, 9)');
  await expect(panel.locator('#status')).toHaveCSS('font-size', '12px');
  await expect(panel.locator('.item.unanchored')).toHaveCount(0);
  await expect(panel.locator('.warn')).toHaveCount(0);
  if (shots) {
    await panel.setViewportSize({ width: 360, height: 640 });
    await panel.screenshot({ path: path.join(shots, 'sidepanel-declined.png') });
    await panel.setViewportSize({ width: 1280, height: 800 });
  }

  const downloadPromise = panel.waitForEvent('download');
  await panel.getByRole('button', { name: '导出 MD', exact: true }).click();
  const download = await downloadPromise;
  const file = path.join(os.tmpdir(), `whn-declined-${Date.now()}.md`);
  await download.saveAs(file);
  expect(fs.readFileSync(file, 'utf8')).toContain(`> ${QUOTE_1}`);

  // Reload: not granted, so nothing shows until the user clicks the icon.
  await page.reload();
  await page.waitForTimeout(1500);
  expect(await ready(page)).toBe('');
  await expect(page.locator('.whn-hl')).toHaveCount(0);
  expect((await stored(key)).highlights.map((h) => h.text)).toEqual([QUOTE_1]);

  // Declined: a new highlight after the click does not prompt again.
  await clickActionIcon(page);
  await expect.poll(() => ready(page)).toBe('1');
  await expect(page.locator('.whn-hl', { hasText: QUOTE_1 })).toHaveCount(1);
  await highlight(page, '#p2', QUOTE_2);
  await page.waitForTimeout(600);
  await expect(page.locator('#whn-root >> iframe.prompt')).toBeHidden();
  await panel.close();
  await page.close();
});

test('「暂不」 declines without the native dialog; 「去授权」 in the side panel grants later', async () => {
  const page = await context.newPage();
  await page.goto(site('d.test'));
  await clickActionIcon(page);
  await expect.poll(() => ready(page)).toBe('1');
  await highlight(page, '#p1', QUOTE_1);
  await promptFrame(page).getByRole('button', { name: '暂不', exact: true }).click();
  await expect(page.locator('#whn-root >> iframe.prompt')).toBeHidden();
  expect(await contains('http://d.test/*')).toBe(false);

  const tabId = Number(await page.evaluate(() => document.documentElement.dataset.whnTab));
  const panel = await context.newPage();
  const params = new URLSearchParams({ tabId: String(tabId), url: page.url(), title: 't' });
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?${params}`);
  await expect(panel.locator('#status')).toBeVisible();
  await panel.getByRole('button', { name: '去授权' }).click();
  await answerPermissionDialog(panel, true);
  await expect.poll(() => contains('http://d.test/*')).toBe(true);
  await expect(panel.locator('#status')).toBeHidden();
  await expect.poll(registeredMatches).toEqual(['http://a.test/*', 'http://d.test/*']);
  await page.reload();
  await expect.poll(() => ready(page)).toBe('1');
  await expect(page.locator('.whn-hl', { hasText: QUOTE_1 })).toHaveCount(1);
  await panel.close();
  await page.close();
});
