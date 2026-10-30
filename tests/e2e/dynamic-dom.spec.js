// Issue #25: highlights must come back when the page paints the same text
// after document_idle, or replaces the nodes the marks were wrapped around.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pageKey } from '../../src/lib/url.js';
import { chromeLocaleEnv } from './native.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = '/opt/cursor/artifacts';
const LATE = '迟到的正文句子在加载完成后才出现在页面上。';
const STABLE = '稳定段落里的这句话用来划线，然后被同样的文字换掉节点。';
const VIRTUAL = '虚拟列表里的句子先被清掉再原样放回来。';

let context;
let worker;
let extensionId;
let userDataDir;
let docDir;
let fileUrl;

const ready = (page) => page.evaluate(() => document.documentElement.dataset.whnReady || '');
const tabIdOf = (page) => page.evaluate(() => Number(document.documentElement.dataset.whnTab));
const stored = (key) => worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k] || null, key);

async function selectFromTo(page, selector) {
  await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    const node = el.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.nodeValue.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  }, selector);
  await page.waitForTimeout(200);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-dynamic-'));
  fs.copyFileSync(path.join(root, 'tests/fixtures/dynamic.html'), path.join(docDir, 'dynamic.html'));
  fs.writeFileSync(path.join(docDir, 'files.html'), `<!doctype html><meta charset="utf-8">
    <style>td { white-space: pre; } .hidden { display:none }</style>
    <input id="host-search"><table><tbody id="diff">
    <tr><td id="line57">const first = alpha();</td></tr>
    <tr><td id="line58"><span class="hidden">copy metadata</span>const second = beta();</td></tr>
    <tr><td id="line59">const third = gamma();</td></tr>
    </tbody></table><script>
    window.stolen = 0;
    for (const type of ['keydown', 'keypress', 'keyup']) document.addEventListener(type, event => {
      if (/^[a-z]$/.test(event.key)) { window.stolen++; event.preventDefault(); document.querySelector('#host-search').focus(); }
    });
    setTimeout(() => {
      const diff = document.querySelector('#diff');
      diff.innerHTML = '<tr><td id="line57">const first = alpha();</td></tr><tr><td id="line58"><span hidden>changed metadata</span>const second = beta();</td></tr><tr><td id="line59">const third = gamma();</td></tr>';
      document.body.dataset.rewritten = '1';
    }, 6000);
    </script>`);
  fileUrl = pathToFileURL(path.join(docDir, 'dynamic.html')).href;
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-dynamic-profile-'));
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
  await worker.evaluate(async () => chrome.storage.local.clear());
});

test('late text is highlighted again and stays anchored, with its comment', async () => {
  const pageUrl = `${fileUrl}?delay=1200`;
  const key = pageKey(pageUrl);
  await worker.evaluate(async ({ key, text }) => {
    await chrome.storage.local.set({
      [key]: {
        url: key,
        title: '动态正文',
        summary: '',
        highlights: [{
          id: 'late-1',
          text,
          prefix: '',
          suffix: '',
          comment: '迟到的评论',
          createdAt: 1,
          pos: 0,
          anchored: true,
        }],
      },
    });
  }, { key, text: LATE });

  const page = context.pages()[0] || await context.newPage();
  await page.goto(pageUrl);
  await expect.poll(() => ready(page)).toBe('1');
  await expect.poll(() => page.locator('#late').innerText()).toContain(LATE);
  await expect(page.locator('#late .whn-hl')).toHaveText(LATE, { timeout: 4000 });

  const saved = await stored(key);
  expect(saved.highlights[0].anchored).toBe(true);
  expect(saved.highlights[0].comment).toBe('迟到的评论');
  expect(saved.highlights[0].text).toBe(LATE);
  if (fs.existsSync(shots)) await page.screenshot({ path: path.join(shots, 'after-late.png') });

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?tabId=${await tabIdOf(page)}`);
  await expect(panel.locator('.quote')).toHaveText(LATE);
  await expect(panel.locator('.warn')).toHaveCount(0);
  await expect(panel.locator('#counts')).toHaveText('1 条划线 · 1 条评论');
  const downloadPromise = panel.waitForEvent('download');
  await panel.getByRole('button', { name: '导出 MD', exact: true }).click();
  const download = await downloadPromise;
  const dest = path.join(os.tmpdir(), `whn-late-${Date.now()}.md`);
  await download.saveAs(dest);
  const markdown = fs.readFileSync(dest, 'utf8');
  expect(markdown).toContain(LATE);
  expect(markdown).toContain('迟到的评论');
  if (fs.existsSync(shots)) await panel.screenshot({ path: path.join(shots, 'after-late-panel.png') });
  await panel.close();
});

test('replacing a paragraph with the same text brings the highlight back', async () => {
  const page = context.pages()[0] || await context.newPage();
  await page.goto(fileUrl);
  await expect.poll(() => ready(page)).toBe('1');
  await selectFromTo(page, '#stable');
  await page.getByRole('button', { name: '划线', exact: true }).click();
  await expect(page.locator('#stable .whn-hl')).toHaveText(STABLE);

  await page.locator('#stable').evaluate((el) => {
    el.replaceChildren(document.createTextNode(el.textContent));
  });
  await expect(page.locator('#stable .whn-hl')).toHaveText(STABLE, { timeout: 4000 });
  expect((await stored(pageKey(fileUrl))).highlights[0].anchored).toBe(true);
  if (fs.existsSync(shots)) await page.screenshot({ path: path.join(shots, 'after-dom-wipe.png') });
});

test('clearing a paragraph and putting the same text back restores the highlight', async () => {
  const page = context.pages()[0];
  await page.goto(fileUrl);
  await expect.poll(() => ready(page)).toBe('1');
  await selectFromTo(page, '#virtual');
  await page.getByRole('button', { name: '划线', exact: true }).click();
  await expect(page.locator('#virtual .whn-hl')).toHaveText(VIRTUAL);

  await page.locator('#virtual').evaluate((el) => {
    const text = el.textContent;
    el.textContent = '';
    el.textContent = text;
  });
  await expect(page.locator('#virtual .whn-hl')).toHaveText(VIRTUAL, { timeout: 4000 });
  expect((await stored(pageKey(fileUrl))).highlights[0].anchored).toBe(true);
});

test('a sanitizer that strips marks does not keep the page busy', async () => {
  const page = context.pages()[0];
  await page.goto(fileUrl);
  await expect.poll(() => ready(page)).toBe('1');
  await page.evaluate(() => {
    const strip = () => {
      for (const node of document.querySelectorAll('.whn-hl')) {
        const parent = node.parentNode;
        while (node.firstChild) parent.insertBefore(node.firstChild, node);
        node.remove();
      }
    };
    new MutationObserver(strip).observe(document.body, { subtree: true, childList: true });
    strip();
  });
  await selectFromTo(page, '#stable');
  await page.getByRole('button', { name: '划线', exact: true }).click();
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => 1 + 1)).toBe(2);
  const saved = await stored(pageKey(fileUrl));
  expect(saved.highlights).toHaveLength(1);
  expect(saved.highlights[0].text).toBe(STABLE);
});

async function selectDiff(page) {
  await page.evaluate(() => {
    const range = document.createRange();
    range.setStart(document.querySelector('#line57').firstChild, 6);
    const end = document.querySelector('#line59').firstChild;
    range.setEnd(end, end.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.querySelector('#line59').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  });
}

test('comment typing is isolated from document shortcuts, including edit and save', async () => {
  const page = context.pages()[0];
  await page.goto(new URL('files.html', fileUrl).href);
  await expect.poll(() => ready(page)).toBe('1');
  await selectDiff(page);
  await page.getByRole('button', { name: '划线+评论', exact: true }).click();
  const area = page.locator('#whn-root textarea');
  await area.pressSequentially('alpha beta');
  await expect(area).toHaveValue('alpha beta');
  expect(await page.evaluate(() => window.stolen)).toBe(0);
  await area.press('Control+Enter');
  await expect.poll(async () => (await stored(pageKey(page.url())))?.highlights[0]?.comment).toBe('alpha beta');
  await page.locator('#line57 .whn-hl').click();
  await area.pressSequentially(' edit');
  await expect(area).toHaveValue('alpha beta edit');
  expect(await page.evaluate(() => window.stolen)).toBe(0);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?tabId=${await tabIdOf(page)}`);
  await panel.evaluate(() => {
    window.leakedKeys = 0;
    for (const type of ['keydown', 'keypress', 'keyup']) window.addEventListener(type, () => window.leakedKeys++);
  });
  await panel.locator('#summary').pressSequentially('summary');
  await expect(panel.locator('#summary')).toHaveValue('summary');
  expect(await panel.evaluate(() => window.leakedKeys)).toBe(0);
  await panel.close();
});

test('mid-line cross-row quote survives refresh and a six-second Files rewrite; partial marks are repaired', async () => {
  const page = context.pages()[0];
  const url = new URL('files.html', fileUrl).href;
  await page.goto(url);
  await expect.poll(() => ready(page)).toBe('1');
  await selectDiff(page);
  await page.getByRole('button', { name: '划线', exact: true }).click();
  const quote = 'first = alpha();const second = beta();const third = gamma();';
  await expect.poll(async () => (await stored(pageKey(url)))?.highlights[0]?.text).toBe(quote);
  await page.reload();
  await expect.poll(() => ready(page)).toBe('1');
  await expect(page.locator('td .whn-hl')).toHaveCount(3);
  await expect(page.locator('body')).toHaveAttribute('data-rewritten', '1');
  await expect(page.locator('td .whn-hl')).toHaveCount(3);
  await page.locator('#line58').evaluate(el => { el.textContent = 'const second = beta();'; });
  await expect(page.locator('td .whn-hl')).toHaveCount(3);
  expect((await stored(pageKey(url))).highlights[0].anchored).toBe(true);
  await page.locator('#line58').evaluate(el => { el.textContent = 'unrelated replacement'; });
  await expect.poll(async () => (await stored(pageKey(url)))?.highlights[0]?.anchored).toBe(false);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?tabId=${await tabIdOf(page)}`);
  await expect(panel.locator('.warn')).toContainText('未定位');
  await panel.close();
});
