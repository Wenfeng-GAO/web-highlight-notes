import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageKey } from '../../src/lib/url.js';
import { startFixtureServer } from '../fixtures/server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = path.join(root, 'artifacts');

const QUOTE_1 = '春天的花园里开满了黄色的花';
const QUOTE_2 = '研究者在图书馆发现了一份手稿';
const QUOTE_3 = '城市在黄昏时分慢慢亮起灯火';
const COMMENT_2 = '这份手稿很关键';
const COMMENT_3 = '黄昏的光线';
const SUMMARY = '一篇关于阅读与城市的测试文章';
const TITLE = '测试文章：阅读与笔记';

let fixture;
let context;
let extensionId;
let worker;
let article;
let panel;
let userDataDir;

function today() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function panelUrl(tabId, url) {
  const params = new URLSearchParams({ tabId: String(tabId), url, title: TITLE });
  return `chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?${params}`;
}

async function selectText(target, selector, text) {
  await target.locator(selector).scrollIntoViewIfNeeded();
  const found = await target.evaluate(({ selector: css, text: quote }) => {
    const element = document.querySelector(css);
    if (!element) return false;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const value = node.nodeValue || '';
      const index = value.indexOf(quote);
      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + quote.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        (node.parentElement || element).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
        return true;
      }
      node = walker.nextNode();
    }
    return false;
  }, { selector, text });
  if (!found) throw new Error(`could not select ${text}`);
}

async function waitReady(target) {
  await target.waitForFunction(() => {
    const state = document.documentElement.dataset.whnReady;
    return state === '1' || state === 'error';
  }, { timeout: 10000 });
  const state = await target.evaluate(() => ({
    ready: document.documentElement.dataset.whnReady,
    error: document.documentElement.dataset.whnError || '',
    tab: document.documentElement.dataset.whnTab || '',
  }));
  expect(state.ready, state.error).toBe('1');
  return state;
}

function highlightButton(target) {
  return target.getByRole('button', { name: '划线', exact: true });
}

function commentButton(target) {
  return target.getByRole('button', { name: '划线+评论', exact: true });
}

function bubble(target) {
  return target.getByRole('dialog', { name: '划线评论' });
}

async function exportMarkdown() {
  const downloadPromise = panel.waitForEvent('download');
  await panel.getByRole('button', { name: '导出 MD', exact: true }).click();
  await expect(panel.getByRole('button', { name: '已复制 ✓', exact: true })).toBeVisible();
  const download = await downloadPromise;
  const dest = path.join(os.tmpdir(), `whn-export-${Date.now()}.md`);
  await download.saveAs(dest);
  return fs.readFileSync(dest, 'utf8');
}

async function readSummary(key) {
  return worker.evaluate(async (storageKey) => {
    const stored = await chrome.storage.local.get(storageKey);
    return stored[storageKey]?.summary ?? null;
  }, key);
}

async function activateTab(target) {
  const id = Number(await target.evaluate(() => document.documentElement.dataset.whnTab || ''));
  expect(id).toBeGreaterThan(0);
  await worker.evaluate(async (tabId) => {
    await chrome.tabs.update(tabId, { active: true });
  }, id);
  await target.bringToFront();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  fixture = await startFixtureServer();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      '--no-first-run',
      '--disable-default-apps',
      '--disable-popup-blocking',
    ],
  });
  let [background] = context.serviceWorkers();
  if (!background) background = await context.waitForEvent('serviceworker', { timeout: 20000 });
  worker = background;
  extensionId = new URL(background.url()).host;

  article = context.pages()[0] || await context.newPage();
  article.on('pageerror', (error) => console.log('PAGEERROR', error.message));
  article.on('console', (message) => {
    if (message.type() === 'error') console.log('CONSOLE', message.text());
  });
  await article.goto(fixture.url);
  await waitReady(article);
  await article.waitForFunction(() => document.documentElement.dataset.whnTab);
  const tabId = await article.evaluate(() => document.documentElement.dataset.whnTab);

  panel = await context.newPage();
  panel.on('pageerror', (error) => console.log('PANELERROR', error.message));
  panel.on('console', (message) => {
    if (message.type() === 'error') console.log('PANEL', message.text());
  });
  await panel.goto(panelUrl(tabId, article.url()));
});

test.afterAll(async () => {
  await context?.close();
  await fixture?.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

test('highlights, comments, and summary survive a reload', async () => {
  await expect(panel.getByText('选中文字即可划线')).toBeVisible();
  await expect(panel.locator('#title')).toHaveText(TITLE);

  await selectText(article, '#edit', '可编辑区域的文字');
  await article.waitForTimeout(200);
  await expect(highlightButton(article)).toBeHidden();

  await article.locator('#area').evaluate((element) => {
    element.focus();
    element.setSelectionRange(0, 6);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  });
  await article.waitForTimeout(200);
  await expect(highlightButton(article)).toBeHidden();

  await selectText(article, '#p1', QUOTE_1);
  await expect(highlightButton(article)).toBeVisible();
  await article.screenshot({ path: path.join(artifacts, 'toolbar.png') });
  await highlightButton(article).click();
  await expect(article.locator('.whn-hl', { hasText: QUOTE_1 })).toHaveCount(1);
  await expect(panel.locator('.quote', { hasText: QUOTE_1 })).toBeVisible();

  await selectText(article, '#p2', QUOTE_2);
  await expect(commentButton(article)).toBeVisible();
  await commentButton(article).click();
  const dialog = bubble(article);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: '评论' }).fill('临时草稿');
  await article.screenshot({ path: path.join(artifacts, 'bubble.png') });
  await article.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await expect.poll(async () => worker.evaluate(async (key) => {
    const stored = await chrome.storage.local.get(key);
    return stored[key]?.highlights?.find((item) => item.text === '研究者在图书馆发现了一份手稿')?.draft;
  }, pageKey(article.url()))).toBe('临时草稿');

  await article.reload();
  await waitReady(article);
  await article.locator('.whn-hl', { hasText: QUOTE_2 }).click();
  await expect(dialog.getByRole('textbox', { name: '评论' })).toHaveValue('临时草稿');
  await dialog.getByRole('textbox', { name: '评论' }).fill(COMMENT_2);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(article.locator('.whn-hl-end.whn-has-comment', { hasText: QUOTE_2 })).toHaveCount(1);

  await selectText(article, '#p3', QUOTE_3);
  await commentButton(article).click();
  await dialog.getByRole('textbox', { name: '评论' }).fill(COMMENT_3);
  await dialog.getByRole('textbox', { name: '评论' }).press('Control+Enter');
  await expect(dialog).toBeHidden();

  await expect(panel.locator('#counts')).toHaveText('3 条划线 · 2 条评论');
  await panel.locator('#summary').fill(SUMMARY);
  await panel.locator('#title').click();
  await expect.poll(async () => worker.evaluate(async (key) => {
    const stored = await chrome.storage.local.get(key);
    return stored[key]?.summary;
  }, pageKey(fixture.url))).toBe(SUMMARY);

  await expect(panel.locator('.quote').nth(0)).toHaveText(QUOTE_1);
  await expect(panel.locator('.quote').nth(1)).toHaveText(QUOTE_2);
  await expect(panel.locator('.quote').nth(2)).toHaveText(QUOTE_3);
  await panel.screenshot({ path: path.join(artifacts, 'sidepanel.png') });

  await article.reload();
  await waitReady(article);
  await expect(article.locator('.whn-hl', { hasText: QUOTE_1 })).toHaveCount(1);
  await expect(article.locator('.whn-hl', { hasText: QUOTE_2 })).toHaveCount(1);
  await expect(article.locator('.whn-hl', { hasText: QUOTE_3 })).toHaveCount(1);
  await expect(article.locator('.whn-hl-end.whn-has-comment')).toHaveCount(2);

  await panel.reload();
  await expect(panel.locator('#summary')).toHaveValue(SUMMARY);
  await expect(panel.locator('#counts')).toHaveText('3 条划线 · 2 条评论');
  await expect(panel.locator('#title')).toHaveText(TITLE);

  await article.evaluate(() => window.scrollTo(0, 0));
  const flashed = article.waitForFunction(() => document.querySelector('.whn-hl.whn-flash'));
  await panel.locator('.item', { hasText: QUOTE_3 }).click();
  await flashed;
  await expect.poll(() => article.evaluate(() => window.scrollY)).toBeGreaterThan(200);
});

test('does not show the toolbar for selections in input, textarea, or contenteditable', async () => {
  for (const selector of ['#field', '#area']) {
    await article.locator(selector).scrollIntoViewIfNeeded();
    await article.locator(selector).evaluate((element) => {
      element.focus();
      element.setSelectionRange(0, 6);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    });
    await article.waitForTimeout(250);
    await expect(highlightButton(article), selector).toBeHidden();
    await article.keyboard.press('Shift+ArrowRight');
    await article.waitForTimeout(250);
    await expect(highlightButton(article), `${selector} keyboard`).toBeHidden();
  }
  await article.locator('#edit').click();
  await selectText(article, '#edit', '可编辑区域的文字');
  await article.waitForTimeout(250);
  await expect(highlightButton(article)).toBeHidden();
  await article.keyboard.press('Shift+ArrowLeft');
  await article.waitForTimeout(250);
  await expect(highlightButton(article)).toBeHidden();
  await article.evaluate(() => { document.activeElement?.blur(); window.getSelection().removeAllRanges(); });
});

test('exports markdown in the documented format', async () => {
  const markdown = await exportMarkdown();
  const source = pageKey(fixture.url);
  expect(markdown).toBe(`# ${TITLE}
来源：${source} · ${today()}
## 摘要
${SUMMARY}
## 划线
> ${QUOTE_1}
> ${QUOTE_2}
评论：${COMMENT_2}
> ${QUOTE_3}
评论：${COMMENT_3}
`);
  await expect(panel.getByRole('button', { name: '导出 MD', exact: true })).toBeVisible({ timeout: 3000 });
});

test('keeps a highlight that can no longer be anchored', async () => {
  const from = pageKey(fixture.url);
  const variant = `${fixture.url}?variant=changed`;
  const to = pageKey(variant);
  const copied = await worker.evaluate(async ({ from: source, to: target }) => {
    const stored = await chrome.storage.local.get(source);
    if (!stored[source]) return { ok: false };
    const copy = structuredClone(stored[source]);
    copy.url = target;
    await chrome.storage.local.set({ [target]: copy });
    return { ok: true, count: copy.highlights.length };
  }, { from, to });
  expect(copied.ok).toBe(true);

  await article.goto(variant);
  await waitReady(article);
  await expect(article.locator('.whn-hl', { hasText: QUOTE_1 })).toHaveCount(1);
  await expect(article.locator('.whn-hl', { hasText: QUOTE_3 })).toHaveCount(1);
  await expect(article.locator('.whn-hl', { hasText: QUOTE_2 })).toHaveCount(0);
  await expect.poll(async () => worker.evaluate(async (key) => {
    const stored = await chrome.storage.local.get(key);
    return stored[key]?.highlights?.find((item) => item.text.includes('手稿'))?.anchored;
  }, to)).toBe(false);

  const tabId = await article.evaluate(() => document.documentElement.dataset.whnTab);
  await panel.goto(panelUrl(tabId, variant));
  await expect(panel.getByText('⚠ 未定位')).toBeVisible();
  await expect(panel.locator('.quote', { hasText: QUOTE_2 })).toBeVisible();
  await expect(panel.locator('.item.unanchored')).toHaveCount(1);
  await panel.screenshot({ path: path.join(artifacts, 'unanchored.png') });

  const markdown = await exportMarkdown();
  expect(markdown).toContain(`> ${QUOTE_2}`);
  expect(markdown).toContain(`评论：${COMMENT_2}`);
  expect(markdown).toContain(`> ${QUOTE_1}`);
  expect(markdown).toContain(`> ${QUOTE_3}`);
  expect(markdown).toContain('## 划线');
});

test('deletes a highlight from the bubble and keeps it gone after reload', async () => {
  await article.goto(fixture.url);
  await waitReady(article);
  const tabId = await article.evaluate(() => document.documentElement.dataset.whnTab);
  await panel.goto(panelUrl(tabId, fixture.url));
  await expect(panel.locator('#counts')).toHaveText('3 条划线 · 2 条评论');

  await article.locator('.whn-hl', { hasText: QUOTE_1 }).click();
  const dialog = bubble(article);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '删除划线', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(article.locator('.whn-hl', { hasText: QUOTE_1 })).toHaveCount(0);
  await expect(panel.locator('#counts')).toHaveText('2 条划线 · 2 条评论');
  await expect(panel.locator('.quote', { hasText: QUOTE_1 })).toHaveCount(0);

  await article.reload();
  await waitReady(article);
  await expect(article.locator('.whn-hl', { hasText: QUOTE_1 })).toHaveCount(0);
  await expect(article.locator('.whn-hl', { hasText: QUOTE_2 })).toHaveCount(1);
  await expect(article.locator('.whn-hl', { hasText: QUOTE_3 })).toHaveCount(1);

  await panel.reload();
  await expect(panel.locator('#counts')).toHaveText('2 条划线 · 2 条评论');
  await expect(panel.getByText(QUOTE_1)).toHaveCount(0);
  await expect(panel.locator('#summary')).toHaveValue(SUMMARY);
});

test('keeps the full summary when typing quickly then blurring', async () => {
  const FAST = 'My test summary';
  const key = pageKey(fixture.url);
  await article.goto(fixture.url);
  await waitReady(article);
  const tabId = await article.evaluate(() => document.documentElement.dataset.whnTab);
  await panel.goto(panelUrl(tabId, fixture.url));

  await panel.locator('#summary').click();
  await panel.locator('#summary').fill('');
  await panel.locator('#title').click();
  await expect.poll(async () => worker.evaluate(async (storageKey) => {
    const stored = await chrome.storage.local.get(storageKey);
    return stored[storageKey]?.summary ?? '';
  }, key)).toBe('');

  await panel.locator('#summary').click();
  await panel.keyboard.type('My test s', { delay: 0 });
  await expect.poll(async () => worker.evaluate(async (storageKey) => {
    const stored = await chrome.storage.local.get(storageKey);
    return stored[storageKey]?.summary ?? '';
  }, key)).toBe('My test s');

  await panel.keyboard.type('ummary', { delay: 0 });
  await panel.locator('#title').click();
  await panel.reload();
  await expect(panel.locator('#summary')).toHaveValue(FAST);
});

test('side panel follows navigation and active tab changes without reloading', async () => {
  const pageA = `${fixture.url}?doc=a`;
  const pageB = `${fixture.url}?doc=b`;
  const keyA = pageKey(pageA);
  const keyB = pageKey(pageB);
  await worker.evaluate(async ({ keyA: aKey, keyB: bKey, quoteA, quoteB, commentB }) => {
    const record = (key, summary, highlights) => ({ url: key, title: '', summary, highlights });
    await chrome.storage.local.set({
      [aKey]: record(aKey, '摘要甲', [{
        id: 'page-a',
        text: quoteA,
        prefix: '',
        suffix: '',
        comment: '',
        draft: null,
        createdAt: 1,
        pos: 1,
        anchored: true,
      }]),
      [bKey]: record(bKey, '摘要乙', [{
        id: 'page-b',
        text: quoteB,
        prefix: '',
        suffix: '',
        comment: commentB,
        draft: null,
        createdAt: 2,
        pos: 2,
        anchored: true,
      }]),
    });
  }, { keyA, keyB, quoteA: QUOTE_1, quoteB: QUOTE_3, commentB: COMMENT_3 });

  await article.goto(pageA);
  await waitReady(article);
  const tabId = await article.evaluate(() => document.documentElement.dataset.whnTab);
  await panel.goto(panelUrl(tabId, pageA));
  await panel.evaluate(() => { window.__whnAlive = 'panel'; });
  await expect(panel.locator('#summary')).toHaveValue('摘要甲');
  await expect(panel.locator('.quote', { hasText: QUOTE_1 })).toBeVisible();
  await expect(panel.locator('#counts')).toHaveText('1 条划线 · 0 条评论');

  await activateTab(article);
  await article.goto(pageB);
  await waitReady(article);
  await expect(panel.locator('#summary')).toHaveValue('摘要乙');
  await expect(panel.locator('.quote', { hasText: QUOTE_3 })).toBeVisible();
  await expect(panel.locator('.quote', { hasText: QUOTE_1 })).toHaveCount(0);
  await expect(panel.locator('.comment', { hasText: COMMENT_3 })).toBeVisible();
  await expect(panel.locator('#counts')).toHaveText('1 条划线 · 1 条评论');
  expect(await panel.evaluate(() => window.__whnAlive)).toBe('panel');

  const other = await context.newPage();
  try {
    await other.goto(pageA);
    await waitReady(other);
    await activateTab(other);
    await expect(panel.locator('#summary')).toHaveValue('摘要甲');
    await expect(panel.locator('.quote', { hasText: QUOTE_1 })).toBeVisible();
    await expect(panel.locator('.quote', { hasText: QUOTE_3 })).toHaveCount(0);
    await expect(panel.locator('#counts')).toHaveText('1 条划线 · 0 条评论');
    expect(await panel.evaluate(() => window.__whnAlive)).toBe('panel');

    await activateTab(article);
    await expect(panel.locator('#summary')).toHaveValue('摘要乙');
    await expect(panel.locator('.quote', { hasText: QUOTE_3 })).toBeVisible();
    await expect(panel.locator('#counts')).toHaveText('1 条划线 · 1 条评论');
    expect(await panel.evaluate(() => window.__whnAlive)).toBe('panel');
  } finally {
    await other.close();
  }
});

test('keeps summary focus and the full text while storage changes during fast typing', async () => {
  const TEXT = 'Highlight notes summary text';
  const summaryUrl = `${fixture.url}?doc=summary`;
  const key = pageKey(summaryUrl);
  await worker.evaluate(async (storageKey) => {
    await chrome.storage.local.remove(storageKey);
  }, key);

  await article.goto(summaryUrl);
  await waitReady(article);
  const tabId = await article.evaluate(() => document.documentElement.dataset.whnTab);
  await panel.goto(panelUrl(tabId, summaryUrl));
  await panel.evaluate(() => { window.__whnAlive = 'summary'; });

  await panel.locator('#summary').click();
  await panel.evaluate(() => {
    const summary = document.querySelector('#summary');
    window.__whnBlurred = false;
    summary.addEventListener('blur', () => { window.__whnBlurred = true; });
  });

  const churn = worker.evaluate(async (storageKey) => {
    for (let n = 1; n <= 6; n += 1) {
      const stored = await chrome.storage.local.get(storageKey);
      const record = stored[storageKey] || {
        url: storageKey,
        title: '',
        summary: '',
        highlights: [],
      };
      const highlights = [...(record.highlights || []), {
        id: `concurrent-${n}`,
        text: `并发划线${n}`,
        prefix: '',
        suffix: '',
        comment: '',
        draft: null,
        createdAt: n,
        pos: n,
        anchored: true,
      }];
      await chrome.storage.local.set({
        [storageKey]: { ...record, url: storageKey, highlights },
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }, key);

  await panel.keyboard.type(TEXT, { delay: 0 });
  await churn;

  expect(await panel.evaluate(() => document.activeElement === document.querySelector('#summary'))).toBe(true);
  expect(await panel.evaluate(() => window.__whnBlurred)).toBe(false);
  await expect(panel.locator('#summary')).toHaveValue(TEXT);
  await expect(panel.locator('.quote', { hasText: '并发划线1' })).toBeVisible();
  await expect.poll(() => readSummary(key)).toBe(TEXT);

  await worker.evaluate(async (storageKey) => {
    const stored = await chrome.storage.local.get(storageKey);
    const record = stored[storageKey] || {
      url: storageKey,
      title: '',
      summary: '',
      highlights: [],
    };
    const highlights = [...(record.highlights || []), {
      id: 'concurrent-final',
      text: '并发划线终',
      prefix: '',
      suffix: '',
      comment: '',
      draft: null,
      createdAt: Date.now(),
      pos: 100,
      anchored: true,
    }];
    await chrome.storage.local.set({
      [storageKey]: { ...record, url: storageKey, summary: '', highlights },
    });
  }, key);

  expect(await panel.evaluate(() => document.activeElement === document.querySelector('#summary'))).toBe(true);
  expect(await panel.evaluate(() => window.__whnBlurred)).toBe(false);
  await expect(panel.locator('#summary')).toHaveValue(TEXT);
  await expect(panel.locator('.quote', { hasText: '并发划线终' })).toBeVisible();
  await expect.poll(() => readSummary(key)).toBe(TEXT);
  expect(await panel.evaluate(() => window.__whnAlive)).toBe('summary');
});
