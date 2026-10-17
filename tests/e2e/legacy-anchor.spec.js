// Issue #29: a note saved before #27 (quote includes gutter line numbers) is
// located once against the new index. The quote and the annotation stay put.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pageKey } from '../../src/lib/url.js';
import { chromeLocaleEnv } from './native.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = '/opt/cursor/artifacts';
const ANNOTATION = '升级前的批注：不要改任何一个字。';
const LOST_TEXT = 'const missing = 1;\n        2const gone = 2;';
const LOST_COMMENT = '丢失笔记的批注也要原样留下。';

let context;
let worker;
let extensionId;
let userDataDir;
let docDir;
let pageUrl;

const ready = (page) => page.evaluate(() => document.documentElement.dataset.whnReady || '');
const tabIdOf = (page) => page.evaluate(() => Number(document.documentElement.dataset.whnTab));
const stored = (key) => worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k] || null, key);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-legacy-'));
  fs.copyFileSync(path.join(root, 'tests/fixtures/diff.html'), path.join(docDir, 'diff.html'));
  pageUrl = pathToFileURL(path.join(docDir, 'diff.html')).href;
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-legacy-profile-'));
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

test('a pre-#27 line-numbered quote is highlighted and only its locator is rewritten', async () => {
  const page = context.pages()[0] || await context.newPage();
  await page.goto(pageUrl);
  await expect.poll(() => ready(page)).toBe('1');
  const legacy = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !node.nodeValue) return NodeFilter.FILTER_REJECT;
        if (parent.closest('script, style, noscript, template, #whn-root')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let text = '';
    const segments = [];
    let node = walker.nextNode();
    while (node) {
      const start = text.length;
      text += node.nodeValue || '';
      segments.push({ node, start, end: text.length });
      node = walker.nextNode();
    }
    const startNode = document.querySelector('#line1').firstChild;
    const endNode = document.querySelector('#line2').firstChild;
    const start = segments.find((item) => item.node === startNode).start;
    const end = segments.find((item) => item.node === endNode).end;
    return {
      text: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - 30), start),
      suffix: text.slice(end, end + 30),
    };
  });
  expect(legacy.text).toContain('offsetsFromRange');
  expect(legacy.text).toContain('2');
  expect(legacy.text).not.toBe("import { offsetsFromRange } from '../lib/anchor.js';\nimport { applyHighlights } from '../lib/apply.js';");

  const key = pageKey(pageUrl);
  await worker.evaluate(async ({ key, legacy, annotation, lostText, lostComment }) => {
    await chrome.storage.local.set({
      [key]: {
        url: key,
        title: '文件改动',
        summary: '',
        highlights: [
          {
            id: 'legacy',
            text: legacy.text,
            prefix: legacy.prefix,
            suffix: legacy.suffix,
            comment: annotation,
            draft: null,
            createdAt: 1,
            pos: 0,
            anchored: true,
          },
          {
            id: 'lost',
            text: lostText,
            prefix: '旧前缀',
            suffix: '旧后缀',
            comment: lostComment,
            draft: null,
            createdAt: 2,
            pos: 1,
            anchored: true,
          },
        ],
      },
    });
  }, { key, legacy, annotation: ANNOTATION, lostText: LOST_TEXT, lostComment: LOST_COMMENT });

  await page.reload();
  await expect.poll(() => ready(page)).toBe('1');
  await expect(page.locator('#line1 .whn-hl, #line2 .whn-hl').first()).toBeVisible({ timeout: 4000 });
  const painted = (await page.locator('.whn-hl').allTextContents()).join('');
  expect(painted).toContain('offsetsFromRange');
  expect(painted).toContain('applyHighlights');
  expect(await page.locator('.blob-num').evaluateAll((nodes) => nodes.some((node) => node.closest('.whn-hl') || node.querySelector('.whn-hl')))).toBe(false);

  const saved = await stored(key);
  const migrated = saved.highlights.find((item) => item.id === 'legacy');
  const lost = saved.highlights.find((item) => item.id === 'lost');
  expect(migrated.text).toBe(legacy.text);
  expect(migrated.comment).toBe(ANNOTATION);
  expect(migrated.anchored).toBe(true);
  expect(migrated.exact).toContain('offsetsFromRange');
  expect(migrated.exact).toContain('applyHighlights');
  expect(migrated.exact).not.toBe(legacy.text);
  expect(lost.text).toBe(LOST_TEXT);
  expect(lost.comment).toBe(LOST_COMMENT);
  expect(lost.anchored).toBe(false);
  expect(lost.exact).toBeUndefined();
  if (fs.existsSync(shots)) await page.screenshot({ path: path.join(shots, 'after-legacy-diff.png') });

  await page.reload();
  await expect.poll(() => ready(page)).toBe('1');
  await expect(page.locator('#line1 .whn-hl')).toContainText('offsetsFromRange');
  await expect(page.locator('#line2 .whn-hl')).toContainText('applyHighlights');
  const again = await stored(key);
  const migratedAgain = again.highlights.find((item) => item.id === 'legacy');
  const lostAgain = again.highlights.find((item) => item.id === 'lost');
  expect(migratedAgain.text).toBe(legacy.text);
  expect(migratedAgain.comment).toBe(ANNOTATION);
  expect(migratedAgain.exact).toBe(migrated.exact);
  expect(migratedAgain.prefix).toBe(migrated.prefix);
  expect(migratedAgain.suffix).toBe(migrated.suffix);
  expect(migratedAgain.anchored).toBe(true);
  expect(lostAgain.text).toBe(LOST_TEXT);
  expect(lostAgain.comment).toBe(LOST_COMMENT);
  expect(lostAgain.anchored).toBe(false);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?tabId=${await tabIdOf(page)}`);
  const migratedItem = panel.locator('.item', { hasText: ANNOTATION });
  await expect(migratedItem.locator('.comment')).toHaveText(ANNOTATION);
  await expect(migratedItem.locator('.warn')).toHaveCount(0);
  await expect(migratedItem.locator('.quote')).toHaveText(legacy.text);
  const lostItem = panel.locator('.item', { hasText: LOST_COMMENT });
  await expect(lostItem.locator('.warn')).toHaveText('⚠ 未定位');
  await expect(lostItem.locator('.quote')).toHaveText(LOST_TEXT);
  await expect(lostItem.locator('.comment')).toHaveText(LOST_COMMENT);
  await expect(panel.locator('#counts')).toHaveText('2 条划线 · 2 条评论');
  if (fs.existsSync(shots)) await panel.screenshot({ path: path.join(shots, 'after-legacy-panel.png') });
  await panel.close();
});
