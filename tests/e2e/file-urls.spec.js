// Local HTML files (file://). Chrome only lets an extension touch file:// pages
// when "Allow access to file URLs" is on for it.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pageKey } from '../../src/lib/url.js';
import { chromeLocaleEnv, clickActionIcon, setFileAccess } from './native.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = process.env.WHN_SHOTS || '';
const TITLE = '测试文章：阅读与笔记';
const QUOTE_1 = '春天的花园里开满了黄色的花';
const QUOTE_2 = '研究者在图书馆发现了一份手稿';
const COMMENT_2 = '本地文件里的评论';

// One-page PDF ("Hello PDF"), small enough to inline.
const MINI_PDF = (() => {
  const stream = 'BT /F1 18 Tf 20 100 Td (Hello PDF) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
})();

let context;
let worker;
let extensionId;
let userDataDir;
let docDir;
let docUrl;

async function selectText(page, selector, text) {
  const ok = await page.evaluate(({ css, quote }) => {
    const walker = document.createTreeWalker(document.querySelector(css), NodeFilter.SHOW_TEXT);
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

const ready = (page) => page.evaluate(() => document.documentElement.dataset.whnReady || '');
const tabIdOf = (page) => page.evaluate(() => Number(document.documentElement.dataset.whnTab));

/** Open the side panel page for a tab the way Chrome does: only the tab id, no URL hint. */
async function openPanel(tabId) {
  const panel = await context.newPage();
  const query = tabId ? `?${new URLSearchParams({ tabId: String(tabId) })}` : '';
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html${query}`);
  return panel;
}

async function activeTabId(page) {
  await page.bringToFront();
  return worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-local-'));
  // Space, CJK and '#' in the file name: tab.url and location.href must give the same key.
  fs.copyFileSync(path.join(root, 'tests/fixtures/article.html'), path.join(docDir, '本地 笔记 #1.html'));
  docUrl = pathToFileURL(path.join(docDir, '本地 笔记 #1.html')).href;
  fs.writeFileSync(path.join(docDir, 'frame.html'), `<!doctype html><meta charset="utf-8"><title>frame</title><p>top</p><iframe src="${docUrl}"></iframe>`);
  fs.writeFileSync(path.join(docDir, 'doc.pdf'), MINI_PDF);
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-file-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    env: chromeLocaleEnv('zh_CN'),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-first-run', '--lang=zh-CN'],
  });
  [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  extensionId = new URL(worker.url()).host;
  // The worker registers the file:///* content script right after it starts; a page
  // opened before that would miss it (a fresh-profile race, not something users hit).
  await expect.poll(() => worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts({ ids: ['whn-auto'] }))[0]?.matches || []), { timeout: 15000 }).toContain('file:///*');
});

test.afterAll(async () => {
  await context?.close();
  for (const dir of [userDataDir, docDir]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('file:///* adds no install warning beyond 0.1.4', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  expect(manifest.host_permissions).toEqual(['file:///*']);
  const without = { ...manifest };
  delete without.host_permissions;
  const warnings = (m) => worker.evaluate((text) => chrome.management.getPermissionWarningsByManifest(text), JSON.stringify(m));
  expect(await warnings(manifest)).toEqual(await warnings(without));
});

test('file access on: a local file works with no click; the side panel shows its title, counts and items; export is complete', async () => {
  expect(await worker.evaluate(() => chrome.extension.isAllowedFileSchemeAccess())).toBe(true);
  const page = context.pages()[0] || await context.newPage();
  await page.goto(docUrl);
  await expect.poll(() => ready(page)).toBe('1');

  await selectText(page, '#p1', QUOTE_1);
  await page.getByRole('button', { name: '划线', exact: true }).click();
  await selectText(page, '#p2', QUOTE_2);
  await page.getByRole('button', { name: '划线+评论', exact: true }).click();
  const bubble = page.getByRole('dialog', { name: '划线评论' });
  await bubble.getByRole('textbox', { name: '评论' }).fill(COMMENT_2);
  await bubble.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.whn-hl')).toHaveCount(2);
  const stored = await worker.evaluate(async (key) => (await chrome.storage.local.get(key))[key], pageKey(docUrl));
  expect(stored.highlights).toHaveLength(2);
  // Local files never get the per-site permission card.
  await page.waitForTimeout(500);
  await expect(page.locator('#whn-root iframe.prompt.open')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.dataset.whnSite)).toBe('granted');

  const panel = await openPanel(await tabIdOf(page));
  await expect(panel.locator('#title')).toHaveText(TITLE);
  await expect(panel.locator('#counts')).toHaveText('2 条划线 · 1 条评论');
  await expect(panel.locator('.quote').nth(0)).toHaveText(QUOTE_1);
  await expect(panel.locator('.quote').nth(1)).toHaveText(QUOTE_2);
  await expect(panel.locator('.comment', { hasText: COMMENT_2 })).toBeVisible();
  await expect(panel.locator('#notice')).toBeHidden();
  if (shots) {
    await panel.setViewportSize({ width: 360, height: 640 });
    await panel.screenshot({ path: path.join(shots, 'sidepanel-file.png') });
    await panel.setViewportSize({ width: 1280, height: 800 });
  }
  const downloadPromise = panel.waitForEvent('download');
  await panel.getByRole('button', { name: '导出 MD', exact: true }).click();
  const file = path.join(os.tmpdir(), `whn-file-${Date.now()}.md`);
  await (await downloadPromise).saveAs(file);
  const markdown = fs.readFileSync(file, 'utf8');
  expect(markdown).toContain(`# ${TITLE}\n来源：${pageKey(docUrl)} · `);
  expect(markdown).toContain(`> ${QUOTE_1}`);
  expect(markdown).toContain(`> ${QUOTE_2}\n评论：${COMMENT_2}`);
  await panel.close();
});

test('file access on: highlights on a local file restore on reload with no click', async () => {
  const page = context.pages()[0];
  await page.bringToFront();
  await page.reload();
  await expect.poll(() => ready(page)).toBe('1');
  await expect(page.locator('.whn-hl')).toHaveCount(2);
  });

test('history.pushState: the panel keeps the key the page saves under', async () => {
  const page = context.pages()[0];
  await page.bringToFront();
  await page.evaluate(() => history.pushState({}, '', '?view=2#part'));
  const panel = await openPanel(await tabIdOf(page));
  await expect(panel.locator('#title')).toHaveText(TITLE);
  await expect(panel.locator('#counts')).toHaveText('2 条划线 · 1 条评论');
  await panel.close();
  await page.goto(docUrl);
});

test('frames: only the top document gets the highlighter', async () => {
  const page = await context.newPage();
  await page.goto(pathToFileURL(path.join(docDir, 'frame.html')).href);
  await expect.poll(() => ready(page)).toBe('1');
  await page.waitForTimeout(500);
  const sub = page.frames().find((frame) => frame !== page.mainFrame() && frame.url() === docUrl);
  expect(await sub.evaluate(() => document.documentElement.dataset.whnReady || '')).toBe('');
  await page.close();
});

async function expectUnsupported(page) {
  const panel = await openPanel(await activeTabId(page));
  await expect(panel.locator('#list .empty')).toHaveText('此页面不支持划线');
  await expect(panel.locator('#list .empty')).toHaveCSS('color', 'rgb(107, 114, 128)');
  await expect(panel.locator('#notice')).toBeHidden();
  await expect(panel.locator('#export')).toBeHidden();
  await expect(panel.getByRole('button', { name: '打开扩展设置' })).toHaveCount(0);
  await panel.close();
}

test('unsupported pages (chrome://, new tab) show 「此页面不支持划线」 with no button', async () => {
  for (const url of ['chrome://version', 'chrome://newtab']) {
    const page = await context.newPage();
    await page.goto(url);
    await expectUnsupported(page);
    await page.close();
  }
});

test('PDF viewer, about:blank, data: and blob: pages are unsupported (after a click where Chrome hides the URL)', async () => {
  const page = await context.newPage();
  await page.goto(pathToFileURL(path.join(docDir, 'doc.pdf')).href);
  await expect.poll(() => ready(page)).toBe('unsupported');
  await expectUnsupported(page);

  for (const url of ['about:blank', 'data:text/html,<p>hello data</p>']) {
    await page.goto(url);
    await clickActionIcon(page);
    await page.waitForTimeout(300);
    await expectUnsupported(page);
  }
  await page.goto(docUrl);
  await expect.poll(() => ready(page)).toBe('1');
  await page.evaluate(() => { location.href = URL.createObjectURL(new Blob(['<p>blob text</p>'], { type: 'text/html' })); });
  await expect.poll(() => page.url()).toMatch(/^blob:/);
  await clickActionIcon(page);
  await page.waitForTimeout(300);
  await expectUnsupported(page);
  await page.close();
});

// Issue #11: with file access off Chrome hides a file tab's URL (no tabs permission),
// so the panel must recognise the tab from what it can see, not from its URL.
test('file access off: after the icon click the panel shows the file-access card and opens this extension\'s settings', async () => {
  worker = await setFileAccess(context, extensionId, false);
  expect(await worker.evaluate(() => chrome.extension.isAllowedFileSchemeAccess())).toBe(false);
  const page = await context.newPage();
  await page.goto(docUrl);
  await page.waitForTimeout(800);
  expect(await ready(page)).toBe('');
  const id = await activeTabId(page);
  // The real condition (#11): the URL of the file tab is hidden from the extension.
  expect(await worker.evaluate(async (tid) => (await chrome.tabs.get(tid)).url ?? null, id)).toBeNull();

  // Before any click this tab looks like any page without a grant.
  const panel = await openPanel(id);
  await expect(panel.locator('#list .empty')).toHaveText('点击插件图标，在此页面使用划线笔记');
  await expect(panel.locator('#notice')).toBeHidden();

  // The click (which also opens the real side panel) tells the open panel what this tab is.
  await clickActionIcon(page);
  const notice = panel.locator('#notice');
  await expect(notice).toBeVisible();
  await expect(panel.locator('#list .empty', { hasText: '此页面不支持划线' })).toHaveCount(0);
  await expect(panel.locator('.app')).toHaveAttribute('data-mode', 'file-access-off');
  await expect(notice.locator('.notice-title')).toHaveText('需要允许访问本地文件');
  await expect(notice.locator('.notice-body')).toHaveText('在扩展详情里打开“允许访问文件网址”，就能在本地 HTML 上划线');
  await expect(notice.locator('.notice-note')).toHaveText('如果这不是本地文件（例如空白页），此页面不支持划线。');
  await expect(notice).toHaveCSS('background-color', 'rgb(249, 250, 251)');
  await expect(notice).toHaveCSS('border-radius', '8px');
  await expect(notice.locator('.notice-title')).toHaveCSS('font-size', '13px');
  await expect(notice.locator('.notice-title')).toHaveCSS('font-weight', '700');
  await expect(notice.locator('.notice-body')).toHaveCSS('font-size', '12px');
  await expect(notice.locator('.notice-body')).toHaveCSS('color', 'rgb(107, 114, 128)');
  await expect(panel.locator('#export')).toBeHidden();
  await panel.close();

  // A panel opened after the click shows the same.
  const later = await openPanel(id);
  await expect(later.locator('#notice')).toBeVisible();
  if (shots) {
    await later.setViewportSize({ width: 360, height: 640 });
    await later.screenshot({ path: path.join(shots, 'sidepanel-file-access-off.png') });
    await later.setViewportSize({ width: 1280, height: 800 });
  }
  const opened = context.waitForEvent('page');
  await later.locator('#notice').getByRole('button', { name: '打开扩展设置' }).click();
  const settings = await opened;
  await expect.poll(() => settings.url()).toBe(`chrome://extensions/?id=${extensionId}`);
  await settings.close();
  await later.close();
  await page.close();
});

test('file access off: chrome:// and the new tab page still say 「此页面不支持划线」, not the file card', async () => {
  for (const url of ['chrome://version', 'chrome://newtab']) {
    const page = await context.newPage();
    await page.goto(url);
    await clickActionIcon(page);
    await page.waitForTimeout(300);
    await expectUnsupported(page);
    await page.close();
  }
});

test('file access on again: the file tab works and the card is gone', async () => {
  worker = await setFileAccess(context, extensionId, true);
  await expect.poll(() => worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts({ ids: ['whn-auto'] }))[0]?.matches || []), { timeout: 10000 }).toContain('file:///*');
  const page = await context.newPage();
  await page.goto(docUrl);
  await expect.poll(() => ready(page)).toBe('1');
  await expect(page.locator('.whn-hl')).toHaveCount(2);
  const panel = await openPanel(await activeTabId(page));
  await expect(panel.locator('#counts')).toHaveText('2 条划线 · 1 条评论');
  await expect(panel.locator('#notice')).toBeHidden();
  await panel.close();
  await page.close();
});
