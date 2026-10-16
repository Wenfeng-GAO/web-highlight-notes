// Issues #18 and #20: an SVG highlight that could not be measured at load is drawn
// when the diagram becomes visible, and a rotation on <text> matches one on a parent <g>.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pageKey } from '../../src/lib/url.js';
import { chromeLocaleEnv } from './native.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shotDir = process.env.WHN_SHOTS || path.join(root, 'test-results', 'svg-reveal-shots');

let docDir;
let extDir;
let userDataDir;
let context;
let worker;
let extensionId;

function installCurrent(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(dest)) fs.rmSync(path.join(dest, entry), { recursive: true, force: true });
  for (const entry of ['manifest.json', 'src', 'icons', '_locales']) {
    fs.cpSync(path.join(root, entry), path.join(dest, entry), { recursive: true });
  }
}

async function launch(dir, profile) {
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    env: chromeLocaleEnv('zh_CN'),
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, '--no-first-run', '--disable-default-apps', '--lang=zh-CN'],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  await expect.poll(() => sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts({ ids: ['whn-auto'] }))[0]?.matches || []), { timeout: 15000 }).toContain('file:///*');
  return { ctx, sw, id: new URL(sw.url()).host };
}

function docUrl() {
  return pathToFileURL(path.join(docDir, 'svg-reveal.html')).href;
}

const stored = (key) => worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k] || null, key);

async function open(page) {
  await page.goto(docUrl());
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.whnReady || '')).toBe('1');
}

async function select(page, css, quote) {
  await page.locator(css).first().scrollIntoViewIfNeeded();
  const found = await page.locator(css).first().evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.nodeValue.indexOf(text);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + text.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      node.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      return true;
    }
    return false;
  }, quote);
  expect(found, `select ${quote}`).toBe(true);
  await page.waitForTimeout(150);
}

const highlightBtn = (page) => page.getByRole('button', { name: '划线', exact: true });

async function highlight(page, css, quote) {
  await select(page, css, quote);
  await expect(highlightBtn(page), quote).toBeVisible();
  await highlightBtn(page).click();
  await page.waitForTimeout(100);
}

async function openPanel(page) {
  const tabId = await page.evaluate(() => document.documentElement.dataset.whnTab);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 1280, height: 800 });
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?tabId=${tabId}`);
  return panel;
}

function item(panel, quote) {
  return panel.locator('.item', { hasText: quote });
}

async function glyphCover(page, css, quote) {
  return page.locator(css).evaluate((text, q) => {
    const rect = text.previousElementSibling;
    const node = text.firstChild;
    const range = document.createRange();
    const start = node.nodeValue.indexOf(q);
    range.setStart(node, start);
    range.setEnd(node, start + q.length);
    const a = rect.getBoundingClientRect();
    const b = range.getBoundingClientRect();
    const iw = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const ih = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    const area = b.width * b.height;
    return {
      mark: !!rect && rect.classList.contains('whn-svg-hl'),
      cover: area ? Math.max(0, iw) * Math.max(0, ih) / area : 0,
      dx: Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2),
      dy: Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2),
    };
  }, quote);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fs.mkdirSync(shotDir, { recursive: true });
  docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-reveal-doc-'));
  fs.copyFileSync(path.join(root, 'tests/fixtures/svg-reveal.html'), path.join(docDir, 'svg-reveal.html'));
  extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-reveal-ext-'));
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-reveal-profile-'));
  installCurrent(extDir);
  ({ ctx: context, sw: worker, id: extensionId } = await launch(extDir, userDataDir));
});

test.afterAll(async () => {
  await context?.close();
  for (const dir of [docDir, extDir, userDataDir]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('a saved SVG highlight appears when a closed details, a hidden tab, or display:none is shown', async () => {
  const page = context.pages()[0] || await context.newPage();
  const key = pageKey(docUrl());
  await open(page);

  await page.locator('#diagram-details summary').click();
  await expect(page.locator('#fold-label')).toBeVisible();
  await highlight(page, '#fold-label', '控制面');

  await page.getByRole('tab', { name: '示意图' }).click();
  await expect(page.locator('#tab-label')).toBeVisible();
  await highlight(page, '#tab-label', '数据面');

  await page.getByRole('button', { name: '显示隐藏图' }).click();
  await expect(page.locator('#script-label')).toBeVisible();
  await highlight(page, '#script-label', '延迟出现');

  await expect.poll(async () => (await stored(key))?.highlights?.map((item) => item.text).sort()).toEqual(['控制面', '数据面', '延迟出现'].sort());

  await open(page);
  expect(await page.locator('#diagram-details').evaluate((element) => element.open)).toBe(false);
  await expect(page.locator('#panel-fig')).toBeHidden();
  await expect(page.locator('#script-svg')).toBeHidden();
  await expect(page.locator('#panel-fig rect.whn-svg-hl, #script-svg rect.whn-svg-hl')).toHaveCount(0);
  const hiddenAnchored = await stored(key);
  const anchoredOf = (quote) => hiddenAnchored.highlights.find((item) => item.text === quote).anchored;
  expect(anchoredOf('数据面')).toBe(false);
  expect(anchoredOf('延迟出现')).toBe(false);

  const panel = await openPanel(page);
  await expect(item(panel, '数据面').locator('.warn')).toHaveText('⚠ 未定位');
  await expect(item(panel, '延迟出现').locator('.warn')).toHaveText('⚠ 未定位');

  await page.locator('#diagram-details summary').click();
  await expect(page.locator('#diagram-details rect.whn-svg-hl')).toBeVisible();
  await expect(item(panel, '控制面').locator('.warn')).toHaveCount(0);
  expect(await page.locator('#fold-label').evaluate((node) => node.outerHTML)).toBe('<text id="fold-label" x="124" y="78" text-anchor="middle" font-size="28">控制面</text>');
  const fold = await page.locator('#diagram-details').boundingBox();
  await page.screenshot({ path: path.join(shotDir, 'details-highlight.png'), clip: { x: fold.x, y: fold.y, width: fold.width, height: fold.height } });

  await page.getByRole('tab', { name: '示意图' }).click();
  await expect(page.locator('#panel-fig rect.whn-svg-hl')).toBeVisible();
  await expect(item(panel, '数据面').locator('.warn')).toHaveCount(0);
  await expect.poll(async () => (await stored(key)).highlights.find((item) => item.text === '数据面').anchored).toBe(true);

  await page.getByRole('button', { name: '显示隐藏图' }).click();
  await expect(page.locator('#script-svg rect.whn-svg-hl')).toBeVisible();
  await expect(item(panel, '延迟出现').locator('.warn')).toHaveCount(0);
  await expect(panel.locator('.item.unanchored')).toHaveCount(0);
  await expect.poll(async () => (await stored(key)).highlights.every((item) => item.anchored)).toBe(true);
  await panel.screenshot({ path: path.join(shotDir, 'side-panel.png'), fullPage: true });
  await panel.close();
});

test('a rotation on the text element and on a parent g both draw on the glyphs', async () => {
  const page = context.pages()[0];
  await open(page);
  await page.locator('#spin').scrollIntoViewIfNeeded();

  await highlight(page, '#own-rot', '自身旋转标签');
  await highlight(page, '#g-rot', '父级旋转标签');
  await highlight(page, '#css-rot', '样式旋转标签');

  const own = await glyphCover(page, '#own-rot', '自身旋转标签');
  const parent = await glyphCover(page, '#g-rot', '父级旋转标签');
  const css = await glyphCover(page, '#css-rot', '样式旋转标签');
  for (const [name, box] of [['own', own], ['parent', parent], ['css', css]]) {
    expect(box.mark, name).toBe(true);
    expect(box.cover, name).toBeGreaterThan(0.95);
    expect(box.dx, name).toBeLessThan(4);
    expect(box.dy, name).toBeLessThan(4);
  }
  expect(Math.abs(own.cover - parent.cover)).toBeLessThan(0.05);

  const spin = await page.locator('#spin').boundingBox();
  await page.screenshot({ path: path.join(shotDir, 'rotation-side-by-side.png'), clip: { x: spin.x, y: spin.y, width: spin.width, height: spin.height } });
  expect(await page.locator('#own-rot').evaluate((node) => node.outerHTML)).toContain('transform="rotate(-28 48 110)"');
  expect(await page.locator('#g-rot').evaluate((node) => node.getAttribute('transform'))).toBeNull();
});
