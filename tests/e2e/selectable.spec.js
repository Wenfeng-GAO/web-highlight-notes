// Issue #26: a highlight must store and paint the selection, not line numbers
// (user-select: none) or hidden nodes the range happens to cross.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pageKey } from '../../src/lib/url.js';
import { chromeLocaleEnv } from './native.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = '/opt/cursor/artifacts';

let context;
let worker;
let extensionId;
let userDataDir;
let docDir;
let pageUrl;

const ready = (page) => page.evaluate(() => document.documentElement.dataset.whnReady || '');
const tabIdOf = (page) => page.evaluate(() => Number(document.documentElement.dataset.whnTab));
const stored = (key) => worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k] || null, key);

async function selectFromTo(page, startSel, endSel) {
  await page.evaluate(({ startSel, endSel }) => {
    const startEl = document.querySelector(startSel);
    const endEl = document.querySelector(endSel);
    const start = startEl.firstChild;
    const end = endEl.lastChild?.nodeType === Node.TEXT_NODE ? endEl.lastChild : endEl.firstChild;
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, end.nodeValue.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    endEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  }, { startSel, endSel });
  await page.waitForTimeout(200);
}

async function highlight(page) {
  await page.getByRole('button', { name: '划线', exact: true }).click();
  await page.waitForTimeout(200);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-selectable-'));
  fs.copyFileSync(path.join(root, 'tests/fixtures/selectable.html'), path.join(docDir, 'selectable.html'));
  pageUrl = pathToFileURL(path.join(docDir, 'selectable.html')).href;
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-selectable-profile-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1100, height: 800 },
    acceptDownloads: true,
    env: chromeLocaleEnv('zh_CN'),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-first-run', '--lang=zh-CN'],
  });
  [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  extensionId = new URL(worker.url()).host;
  await expect.poll(() => worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts({ ids: ['whn-auto'] }))[0]?.matches || []), { timeout: 15000 }).toContain('file:///*');
});

test.afterAll(async () => {
  await context?.close();
  for (const dir of [userDataDir, docDir]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test.beforeEach(async () => {
  await worker.evaluate(async (key) => chrome.storage.local.remove(key), pageKey(pageUrl));
});

test('a code selection does not keep the user-select:none line number', async () => {
  const page = context.pages()[0] || await context.newPage();
  await page.goto(pageUrl);
  await expect.poll(() => ready(page)).toBe('1');
  await selectFromTo(page, '#code .src', '#code .line:last-child .src');
  const selection = await page.evaluate(() => getSelection().toString());
  expect(selection).toContain('const alpha = 1;');
  expect(selection).toContain('const beta = 2;');
  expect(selection).not.toMatch(/^\s*2/m);
  await highlight(page);

  const quote = (await stored(pageKey(pageUrl))).highlights[0].text;
  expect(quote).toContain('const alpha = 1;');
  expect(quote).toContain('const beta = 2;');
  expect(quote.replace('const beta = 2;', '')).not.toMatch(/2/);
  const marks = await page.locator('.whn-hl').allTextContents();
  expect(marks.join('')).toContain('const alpha = 1;');
  expect(marks.join('')).toContain('const beta = 2;');
  expect(marks).not.toContain('2');
  expect(await page.locator('.ln').evaluateAll((nodes) => nodes.some((node) => node.closest('.whn-hl')))).toBe(false);

  await page.reload();
  await expect.poll(() => ready(page)).toBe('1');
  expect(await page.locator('.ln').evaluateAll((nodes) => nodes.some((node) => node.closest('.whn-hl')))).toBe(false);
  expect((await stored(pageKey(pageUrl))).highlights[0].anchored).toBe(true);
  if (fs.existsSync(shots)) await page.screenshot({ path: path.join(shots, 'after-line-numbers.png') });

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?tabId=${await tabIdOf(page)}`);
  await expect(panel.locator('.quote')).toContainText('const alpha = 1;');
  await expect(panel.locator('.quote')).toContainText('const beta = 2;');
  await expect(panel.locator('.quote')).not.toContainText('2const');
  await expect(panel.locator('#counts')).toHaveText('1 条划线 · 0 条评论');
  const downloadPromise = panel.waitForEvent('download');
  await panel.getByRole('button', { name: '导出 MD', exact: true }).click();
  const download = await downloadPromise;
  const dest = path.join(os.tmpdir(), `whn-lines-${Date.now()}.md`);
  await download.saveAs(dest);
  const markdown = fs.readFileSync(dest, 'utf8');
  expect(markdown).toContain('const alpha = 1;');
  expect(markdown).toContain('const beta = 2;');
  expect(markdown).not.toMatch(/^>\s*2\s*$/m);
  expect(markdown).not.toContain('2const');
  if (fs.existsSync(shots)) await panel.screenshot({ path: path.join(shots, 'after-line-numbers-panel.png') });
  await panel.close();
});

test('hidden text between two paragraphs is not part of the note', async () => {
  const page = context.pages()[0];
  await page.goto(pageUrl);
  await expect.poll(() => ready(page)).toBe('1');
  await selectFromTo(page, '#a', '#b');
  const selection = await page.evaluate(() => getSelection().toString());
  expect(selection).not.toContain('隐藏广告');
  await highlight(page);
  const quote = (await stored(pageKey(pageUrl))).highlights[0].text;
  expect(quote).toContain('可见的开头句子伽玛');
  expect(quote).toContain('可见的结尾句子德尔塔');
  expect(quote).not.toContain('隐藏广告');
  expect(await page.locator('.whn-hl').allTextContents()).not.toContain('隐藏广告文案不要出现在划线里');

  await page.reload();
  await expect.poll(() => ready(page)).toBe('1');
  const again = (await stored(pageKey(pageUrl))).highlights[0];
  expect(again.anchored).toBe(true);
  expect(again.text).not.toContain('隐藏广告');
  if (fs.existsSync(shots)) await page.screenshot({ path: path.join(shots, 'after-hidden-text.png') });
});

test('user-select:text inside a user-select:none parent can still be highlighted', async () => {
  const page = context.pages()[0];
  await page.goto(pageUrl);
  await expect.poll(() => ready(page)).toBe('1');
  await selectFromTo(page, '#keep', '#keep');
  await highlight(page);
  await expect(page.locator('.whn-hl')).toHaveText('这段重新可选的文字应该能划线。');
  expect((await stored(pageKey(pageUrl))).highlights[0].text).toBe('这段重新可选的文字应该能划线。');
});

test('a highlight inside details is still anchored when the details is closed on reload', async () => {
  const page = context.pages()[0];
  await page.goto(pageUrl);
  await expect.poll(() => ready(page)).toBe('1');
  await page.locator('#fold').evaluate((el) => { el.open = true; });
  await selectFromTo(page, '#folded', '#folded');
  await highlight(page);
  await page.locator('#fold').evaluate((el) => { el.open = false; });
  await page.reload();
  await expect.poll(() => ready(page)).toBe('1');
  expect((await stored(pageKey(pageUrl))).highlights[0].anchored).toBe(true);
  expect(await page.locator('#folded .whn-hl').count()).toBe(1);
  await page.locator('#fold').evaluate((el) => { el.open = true; });
  await expect(page.locator('#folded .whn-hl')).toHaveText('折叠区域里的句子在关闭后刷新仍应定位。');
});
