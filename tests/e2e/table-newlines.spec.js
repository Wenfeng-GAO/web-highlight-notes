// A drag across table rows must store the selection's line breaks.
// Formatting whitespace between rows stays out of the index (so it is not
// wrapped), and user-select:none line numbers stay out of the quote.
// The stored note and the side panel both keep one newline per crossed row.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pageKey } from '../../src/lib/url.js';
import { chromeLocaleEnv } from './native.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const evidenceDir = process.env.WHN_EVIDENCE || path.join(os.tmpdir(), 'whn-newline-evidence');

const TABLE_QUOTE = [
  'tarballs are uploaded after the build finishes here',
  'middle line of the diff stays in the code column',
  'Upload tarball artifact to the release bucket',
].join('\n');

const PARAGRAPH = 'ordinary paragraph keeps every selected word';
const POEM = 'line one of the note\nline two of the note';

let context;
let worker;
let extensionId;
let userDataDir;
let docDir;

const ready = (page) => page.evaluate(() => document.documentElement.dataset.whnReady || '');
const tabIdOf = (page) => page.evaluate(() => Number(document.documentElement.dataset.whnTab));
const stored = (key) => worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k] || null, key);

function pageUrl(name) {
  return pathToFileURL(path.join(docDir, name)).href;
}

function writeEvidence(name, value) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function quoteStats(text) {
  const value = text ?? '';
  return {
    text: value,
    length: value.length,
    newlines: (value.match(/\n/g) || []).length,
  };
}

async function columnBoxes(page) {
  return page.evaluate(() => {
    const ids = ['ln57', 'c57', 'ln58', 'c58', 'ln59', 'c59'];
    const boxes = {};
    for (const id of ids) {
      const rect = document.querySelector(`#${id}`).getBoundingClientRect();
      boxes[id] = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
    return boxes;
  });
}

async function dragAcross(page, spec) {
  await page.locator(spec.startSel).scrollIntoViewIfNeeded();
  const drag = await page.evaluate((spec) => {
    function point(sel, phrase, edge) {
      const node = document.querySelector(sel).firstChild;
      const index = node.nodeValue.indexOf(phrase);
      if (index < 0) throw new Error(`missing ${phrase} in ${sel}`);
      const offset = edge === 'end' ? index + phrase.length - 1 : index;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rect = range.getBoundingClientRect();
      const x = edge === 'end' ? rect.x + Math.max(rect.width - 1, 0) : rect.x + Math.min(1, rect.width / 2);
      return { x, y: rect.y + rect.height / 2, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    }
    return {
      start: point(spec.startSel, spec.startText, 'start'),
      end: point(spec.endSel, spec.endText, 'end'),
    };
  }, spec);
  await page.mouse.move(drag.start.x, drag.start.y);
  await page.mouse.down();
  await page.mouse.move(drag.end.x, drag.end.y, { steps: 30 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  return drag;
}

async function highlight(page) {
  await page.getByRole('button', { name: '划线', exact: true }).click();
  await page.waitForTimeout(300);
}

async function openPanel(page) {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?tabId=${await tabIdOf(page)}`);
  await expect(panel.locator('.quote').first()).toBeVisible();
  return panel;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fs.mkdirSync(evidenceDir, { recursive: true });
  docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-newlines-'));
  fs.writeFileSync(path.join(docDir, 'diff.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>差异表</title>
<style>
  body{font:18px/1.65 sans-serif;max-width:860px;margin:28px;color:#222}
  table.diff{border-collapse:collapse;font-family:ui-monospace,monospace;font-size:15px}
  table.diff td{padding:1px 10px;vertical-align:top}
  .ln{user-select:none;color:#8a8f98;text-align:right;min-width:2.5em}
  .code{white-space:pre}
  pre#poem{font:16px/1.5 ui-monospace,monospace;margin-top:24px}
  .ln2{user-select:none;color:#888;display:inline-block;width:1.5em}
</style></head><body>
<table class="diff" id="diff">
  <tr id="r57"><td class="ln" id="ln57">57</td><td class="code" id="c57">dir tarballs are uploaded after the build finishes here</td></tr>
  <tr hidden><td class="ln">00</td><td class="code">HIDDEN WHITESPACE TOKEN should never enter the note</td></tr>
  <tr id="r58"><td class="ln" id="ln58">58</td><td class="code" id="c58">middle line of the diff stays in the code column</td></tr>
  <tr style="display:none"><td></td><td>display none interstitial token</td></tr>
  <tr id="r59"><td class="ln" id="ln59">59</td><td class="code" id="c59">Upload tarball artifact to the release bucket</td></tr>
</table>
<p id="plain">${PARAGRAPH}</p>
<pre id="poem">${POEM}</pre>
<div id="code"><div class="line"><span class="ln2">1</span><span class="src" id="s1">const alpha = 1;</span></div>
<div class="line"><span class="ln2">2</span><span class="src" id="s2">const beta = 2;</span></div></div>
</body></html>`);
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-newlines-profile-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1100, height: 800 },
    acceptDownloads: true,
    env: chromeLocaleEnv('zh_CN'),
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      '--no-first-run',
      '--disable-default-apps',
      '--lang=zh-CN',
    ],
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

test('diff table drag keeps row boundaries in the note and the side panel', async () => {
  const page = context.pages()[0] || await context.newPage();
  const url = pageUrl('diff.html');
  await page.goto(url);
  await expect.poll(() => ready(page)).toBe('1');
  const layoutBefore = await columnBoxes(page);
  const drag = await dragAcross(page, {
    startSel: '#c57',
    startText: 'tarballs are uploaded',
    endSel: '#c59',
    endText: 'release bucket',
  });
  const selected = await page.evaluate(() => getSelection().toString());
  writeEvidence('selected.json', quoteStats(selected));
  writeEvidence('drag.json', drag);
  expect(selected).toBe(TABLE_QUOTE);

  await highlight(page);
  const record = await stored(pageKey(url));
  const note = record?.highlights?.[0] || null;
  const layoutAfter = await columnBoxes(page);
  await page.screenshot({ path: path.join(evidenceDir, 'page.png') });
  const panel = await openPanel(page);
  const side = await panel.locator('.quote').first().textContent();
  await panel.screenshot({ path: path.join(evidenceDir, 'sidepanel.png') });
  const evidence = {
    selected: quoteStats(selected),
    noteCount: record?.highlights?.length ?? 0,
    note: quoteStats(note?.text),
    sidepanel: quoteStats(side),
    drag,
    layoutBefore,
    layoutAfter,
    anchored: note?.anchored ?? null,
  };
  writeEvidence('scene.json', evidence);

  expect(evidence.noteCount).toBe(1);
  expect(note.text).toBe(TABLE_QUOTE);
  expect(side).toBe(TABLE_QUOTE);
  expect(note.text).not.toContain('heremiddle');
  expect(note.text).not.toContain('columnUpload');
  expect(note.text).not.toContain('HIDDEN WHITESPACE TOKEN');
  expect(note.text).not.toContain('display none interstitial');
  expect(note.text).not.toMatch(/\b57\b|\b58\b|\b59\b/);
  for (const id of ['c57', 'c58', 'c59', 'ln57', 'ln58', 'ln59']) {
    expect(Math.abs(layoutAfter[id].x - layoutBefore[id].x), id).toBeLessThan(1);
    expect(Math.abs(layoutAfter[id].width - layoutBefore[id].width), id).toBeLessThan(1);
  }
  expect(await page.locator('#ln57 .whn-hl, #ln58 .whn-hl, #ln59 .whn-hl').count()).toBe(0);
  expect(await page.locator('#c57 .whn-hl').count()).toBeGreaterThan(0);
  expect(await page.locator('#c58 .whn-hl').count()).toBeGreaterThan(0);
  expect(await page.locator('#c59 .whn-hl').count()).toBeGreaterThan(0);

  await page.reload();
  await expect.poll(() => ready(page)).toBe('1');
  const reloaded = (await stored(pageKey(url))).highlights[0];
  expect(reloaded.text).toBe(TABLE_QUOTE);
  expect(reloaded.anchored).toBe(true);
  expect(await page.locator('#c57 .whn-hl, #c58 .whn-hl, #c59 .whn-hl').count()).toBeGreaterThanOrEqual(3);
  expect(await page.locator('.ln .whn-hl').count()).toBe(0);
  await panel.reload();
  expect(await panel.locator('.quote').first().textContent()).toBe(TABLE_QUOTE);
  await panel.close();
});

test('an ordinary paragraph quote stays a single line', async () => {
  const page = context.pages()[0];
  const url = pageUrl('diff.html');
  await page.goto(url);
  await expect.poll(() => ready(page)).toBe('1');
  await page.evaluate((text) => {
    const node = document.querySelector('#plain').firstChild;
    const index = node.nodeValue.indexOf(text);
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + text.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    node.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  }, PARAGRAPH);
  await highlight(page);
  const notes = (await stored(pageKey(url))).highlights;
  const note = notes.find((item) => item.text === PARAGRAPH);
  expect(note).toBeTruthy();
  expect(note.text).not.toContain('\n');
  const panel = await openPanel(page);
  await expect(panel.locator('.quote', { hasText: PARAGRAPH })).toHaveCount(1);
  await panel.close();
});

test('a normal multi-line quote keeps the newline that is in the text', async () => {
  const page = context.pages()[0];
  const url = pageUrl('diff.html');
  await page.goto(url);
  await expect.poll(() => ready(page)).toBe('1');
  await page.evaluate((text) => {
    const node = document.querySelector('#poem').firstChild;
    const index = node.nodeValue.indexOf(text);
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + text.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    node.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  }, POEM);
  await highlight(page);
  const notes = (await stored(pageKey(url))).highlights;
  const note = notes.find((item) => item.text === POEM);
  expect(note?.text).toBe(POEM);
  const panel = await openPanel(page);
  expect(await panel.locator('.quote', { hasText: 'line one of the note' }).textContent()).toBe(POEM);
  await panel.close();
});

test('hidden line numbers stay out of a multi-line code quote', async () => {
  const page = context.pages()[0];
  const url = pageUrl('diff.html');
  await page.goto(url);
  await expect.poll(() => ready(page)).toBe('1');
  await page.evaluate(() => {
    const start = document.querySelector('#s1').firstChild;
    const end = document.querySelector('#s2').firstChild;
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, end.nodeValue.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    end.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  });
  await highlight(page);
  const notes = (await stored(pageKey(url))).highlights;
  const note = notes.find((item) => item.text.includes('const alpha = 1;') && item.text.includes('const beta = 2;'));
  expect(note).toBeTruthy();
  expect(note.text.replace('const beta = 2;', '')).not.toMatch(/2/);
  expect(note.text).not.toMatch(/^\s*1/m);
  expect(await page.locator('.ln2').evaluateAll((nodes) => nodes.some((node) => node.closest('.whn-hl')))).toBe(false);
  await page.reload();
  await expect.poll(() => ready(page)).toBe('1');
  const again = (await stored(pageKey(url))).highlights.find((item) => item.text.includes('const alpha = 1;'));
  expect(again.anchored).toBe(true);
  expect(again.text).toBe(note.text);
  const panel = await openPanel(page);
  await expect(panel.locator('.quote', { hasText: 'const alpha = 1;' })).not.toContainText('2const');
  await panel.close();
});
