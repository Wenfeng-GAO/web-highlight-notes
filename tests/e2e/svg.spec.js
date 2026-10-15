// Issue #16: highlighting text inside an inline <svg> blanked the text and could not take
// a comment, because an HTML <span> inside SVG <text> is not rendered. The fixture is the
// real page from the report (5 diagrams; the author's name is removed).
import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pageKey } from '../../src/lib/url.js';
import { chromeLocaleEnv } from './native.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shotDir = process.env.WHN_SHOTS || path.join(root, 'test-results', 'svg-shots');
const LABEL = '控制面';
const LABEL_TEXT = `svg[aria-label="热更新时序"] text:text-is("${LABEL}")`;
const LABEL_HTML = '<text x="56" y="26">控制面</text>';
const COMMENT = '控制面只看 apply_ok';
const LEGACY_COMMENT = '旧版本留下的评论';

let docDir;
let extDir;
let userDataDir;
let context;
let worker;
let extensionId;

function exportRelease(tag, dest) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${tag}^{commit}`], { cwd: root, stdio: 'pipe' });
  } catch {
    execFileSync('git', ['fetch', '--depth=1', 'origin', 'tag', tag], { cwd: root, stdio: 'pipe' });
  }
  const tar = execFileSync('git', ['archive', '--format=tar', tag, 'manifest.json', 'src', 'icons', '_locales'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dest], { input: tar });
}

function installCurrent(dest) {
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

function docUrl(name) {
  return pathToFileURL(path.join(docDir, name)).href;
}

const stored = (key) => worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k] || null, key);

async function open(page, url) {
  await page.goto(url);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.whnReady || '')).toBe('1');
}

/** Select `quote` inside the first element matching `css` and fire the mouseup the toolbar listens to. */
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
const bubble = (page) => page.getByRole('dialog', { name: '划线评论' });

/** Rendered width of an SVG <text>: 0 when its characters are not drawn. */
const textLength = (page, css) => page.locator(css).first().evaluate((node) => node.getComputedTextLength());

/** Screenshot a diagram clear of the page's sticky nav bar. */
async function shootDiagram(page, label, file) {
  const box = await page.locator(`svg[aria-label="${label}"]`).evaluate((svg) => {
    svg.closest('section').scrollIntoView({ block: 'start' });
    window.scrollBy(0, -60);
    const rect = svg.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: Math.min(rect.height, window.innerHeight - rect.top) };
  });
  await page.screenshot({ path: path.join(shotDir, file), clip: box });
}

async function openPanel(page) {
  const tabId = await page.evaluate(() => document.documentElement.dataset.whnTab);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?tabId=${tabId}`);
  return panel;
}

async function exportMarkdown(panel) {
  const download = panel.waitForEvent('download');
  await panel.getByRole('button', { name: '导出 MD', exact: true }).click();
  const file = path.join(os.tmpdir(), `whn-svg-export-${Date.now()}.md`);
  await (await download).saveAs(file);
  return fs.readFileSync(file, 'utf8');
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fs.mkdirSync(shotDir, { recursive: true });
  docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-svg-doc-'));
  for (const name of ['svg-diagrams.html', 'ns-sweep.html']) fs.copyFileSync(path.join(root, 'tests/fixtures', name), path.join(docDir, name));
  // Same page under a second URL, so the new-version flow starts with no notes.
  fs.copyFileSync(path.join(root, 'tests/fixtures/svg-diagrams.html'), path.join(docDir, 'svg-diagrams-new.html'));
  extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-svg-ext-'));
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-svg-profile-'));
});

test.afterAll(async () => {
  await context?.close();
  for (const dir of [docDir, extDir, userDataDir]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('acceptance 3: a 0.1.6 highlight on SVG text shows the text again after upgrade + reload, in panel and export', async () => {
  // 0.1.6 makes the record through the real UI and blanks the label (the reported bug).
  exportRelease('v0.1.6', extDir);
  ({ ctx: context, sw: worker, id: extensionId } = await launch(extDir, userDataDir));
  expect(await worker.evaluate(() => chrome.runtime.getManifest().version)).toBe('0.1.6');
  let page = context.pages()[0] || await context.newPage();
  const url = docUrl('svg-diagrams.html');
  const key = pageKey(url);
  await open(page, url);
  expect(await textLength(page, LABEL_TEXT)).toBeGreaterThan(10);
  await select(page, LABEL_TEXT, LABEL);
  await highlightBtn(page).click();
  await expect(page.locator('svg span.whn-hl')).toHaveCount(1);
  expect(await page.locator('svg[aria-label="热更新时序"] text').first().evaluate((node) => node.getComputedTextLength())).toBe(0);
  await shootDiagram(page, '热更新时序', 'c0-legacy-0.1.6-label-blank.png');
  // 0.1.6 can't open a bubble on it, so give it the comment the way the panel would store one.
  await worker.evaluate(async ({ k, comment }) => {
    const record = (await chrome.storage.local.get(k))[k];
    record.highlights[0].comment = comment;
    await chrome.storage.local.set({ [k]: record });
  }, { k: key, comment: LEGACY_COMMENT });
  const legacy = await stored(key);
  expect(legacy.highlights).toHaveLength(1);
  expect(legacy.highlights[0]).toMatchObject({ text: LABEL, anchored: true, comment: LEGACY_COMMENT });
  await context.close();

  // Update in place (same profile, same storage) and reload the page.
  installCurrent(extDir);
  fs.rmSync(path.join(userDataDir, 'Default', 'Service Worker'), { recursive: true, force: true });
  ({ ctx: context, sw: worker, id: extensionId } = await launch(extDir, userDataDir));
  expect(await worker.evaluate(() => chrome.runtime.getManifest().version)).toBe(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version);
  expect(await stored(key)).toEqual(legacy);
  page = context.pages()[0] || await context.newPage();
  await open(page, url);

  // The text is drawn again and the <text> node is exactly the page's own.
  await expect(page.locator('svg span.whn-hl')).toHaveCount(0);
  expect(await page.locator(LABEL_TEXT).evaluate((node) => node.outerHTML)).toBe(LABEL_HTML);
  expect(await textLength(page, LABEL_TEXT)).toBeGreaterThan(10);
  // It renders as the SVG-native mark, with the comment dot.
  const mark = page.locator(`rect.whn-svg-hl[data-whn-id="${legacy.highlights[0].id}"]`);
  await expect(mark).toHaveCount(1);
  expect(await mark.evaluate((node) => node.nextElementSibling.localName)).toBe('circle');
  await expect.poll(async () => (await stored(key)).highlights[0].anchored).toBe(true);
  await shootDiagram(page, '热更新时序', 'c-legacy-after-reload.png');

  const panel = await openPanel(page);
  await expect(panel.locator('.quote')).toHaveText([LABEL]);
  await expect(panel.locator('.item.unanchored')).toHaveCount(0);
  await expect(panel.getByText(LEGACY_COMMENT)).toBeVisible();
  const md = await exportMarkdown(panel);
  expect(md).toContain(`> ${LABEL}`);
  expect(md).toContain(LEGACY_COMMENT);
  await panel.screenshot({ path: path.join(shotDir, 'c-legacy-sidepanel.png') });
  await panel.close();
});

test('acceptance 1+2: highlight an SVG label natively, comment on it, and it survives a reload', async () => {
  const page = context.pages()[0];
  const url = docUrl('svg-diagrams-new.html');
  const key = pageKey(url);
  await open(page, url);
  const before = await page.locator('main').evaluate((node) => [...node.querySelectorAll('svg text')].map((text) => text.outerHTML));
  const widthBefore = await textLength(page, LABEL_TEXT);

  await select(page, LABEL_TEXT, LABEL);
  await expect(highlightBtn(page)).toBeVisible();
  await highlightBtn(page).click();
  const mark = page.locator('svg[aria-label="热更新时序"] rect.whn-svg-hl');
  await expect(mark).toHaveCount(1);
  // Acceptance 1: the text is still drawn and no <text> node changed.
  expect(await textLength(page, LABEL_TEXT)).toBeCloseTo(widthBefore, 3);
  expect(await page.locator('main').evaluate((node) => [...node.querySelectorAll('svg text')].map((text) => text.outerHTML))).toEqual(before);
  await expect(page.locator('svg .whn-hl:not(rect)')).toHaveCount(0);
  // Design: the rect sits right before the <text> (text paints on top) and covers it.
  const geometry = await mark.evaluate((rect) => {
    const text = rect.nextElementSibling;
    const a = rect.getBoundingClientRect();
    const b = text.getBoundingClientRect();
    return {
      next: text.localName,
      rx: rect.getAttribute('rx'),
      fill: getComputedStyle(rect).fill,
      covers: a.left <= b.left + 1 && a.right >= b.right - 1 && a.top <= b.top + 1 && a.bottom >= b.bottom - 1,
    };
  });
  expect(geometry).toEqual({ next: 'text', rx: '2', fill: 'rgba(250, 204, 21, 0.4)', covers: true });
  await shootDiagram(page, '热更新时序', 'a-svg-highlight.png');

  // Hover deepens the fill even though the text, not the rect, is under the pointer.
  const box = await page.locator(LABEL_TEXT).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(mark).toHaveClass(/whn-hover/);
  expect(await mark.evaluate((rect) => getComputedStyle(rect).fill)).toBe('rgba(250, 204, 21, 0.6)');

  // Acceptance 2: clicking the label opens the bubble and takes a comment.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(bubble(page)).toBeVisible();
  await bubble(page).getByRole('textbox', { name: '评论' }).fill(COMMENT);
  await bubble(page).getByRole('button', { name: '保存', exact: true }).click();
  await expect(bubble(page)).toBeHidden();
  const dot = page.locator('svg[aria-label="热更新时序"] circle.whn-svg-dot');
  await expect(dot).toHaveCount(1);
  expect(await dot.evaluate((circle) => ({ r: circle.getAttribute('r'), fill: getComputedStyle(circle).fill }))).toEqual({ r: '3', fill: 'rgb(202, 138, 4)' });
  await expect.poll(async () => (await stored(key))?.highlights?.[0]?.comment).toBe(COMMENT);
  await page.mouse.move(5, 5);
  await shootDiagram(page, '热更新时序', 'b-svg-comment-dot.png');

  const panel = await openPanel(page);
  await expect(panel.locator('.quote')).toHaveText([LABEL]);
  await expect(panel.getByText(COMMENT)).toBeVisible();
  await panel.screenshot({ path: path.join(shotDir, 'b-sidepanel-comment.png') });
  await panel.close();

  // Restore path: after a reload it is the same native mark, text untouched.
  await open(page, url);
  await expect(mark).toHaveCount(1);
  await expect(dot).toHaveCount(1);
  expect(await page.locator(LABEL_TEXT).evaluate((node) => node.outerHTML)).toBe(LABEL_HTML);
  expect((await stored(key)).highlights[0].anchored).toBe(true);
  await page.locator(LABEL_TEXT).click();
  await expect(bubble(page).getByRole('textbox', { name: '评论' })).toHaveValue(COMMENT);
  await page.screenshot({ path: path.join(shotDir, 'b-bubble-on-svg-label.png') });
  await page.keyboard.press('Escape');

  // <tspan>: a mark behind part of a sentence; the <tspan> stays as it is.
  const sentence = 'svg[aria-label="失败场景"] text:has(tspan)';
  const sentenceBefore = await page.locator(sentence).evaluate((node) => node.outerHTML);
  await select(page, `${sentence} tspan`, '存疑');
  await expect(highlightBtn(page)).toBeVisible();
  await highlightBtn(page).click();
  await expect(page.locator('svg[aria-label="失败场景"] rect.whn-svg-hl')).toHaveCount(1);
  expect(await page.locator(sentence).evaluate((node) => node.outerHTML)).toBe(sentenceBefore);
  const tspanCovered = await page.locator('svg[aria-label="失败场景"] rect.whn-svg-hl').evaluate((rect) => {
    const a = rect.getBoundingClientRect();
    const b = document.querySelector('svg[aria-label="失败场景"] tspan').getBoundingClientRect();
    return a.left <= b.left + 1 && a.right >= b.right - 1 && a.width < b.width + 4;
  });
  expect(tspanCovered).toBe(true);

  // Page text in plain HTML still uses the span mark.
  await select(page, '.key:has-text("控制面只有在")', '控制面只有在');
  await highlightBtn(page).click();
  await expect(page.locator('.key span.whn-hl')).toHaveText('控制面只有在');
  expect((await stored(key)).highlights.map((item) => item.text)).toEqual(['控制面只有在', LABEL, '存疑']);
});

test('sweep: textPath, rotated SVG text and MathML get no toolbar and stay intact; foreignObject and translated text work', async () => {
  const page = context.pages()[0];
  const url = docUrl('ns-sweep.html');
  const key = pageKey(url);
  await open(page, url);
  const snapshot = () => page.evaluate(() => ({
    svg: document.querySelector('#diagram').outerHTML,
    math: document.querySelector('#emc').outerHTML,
  }));
  const pristine = await snapshot();

  for (const [css, quote] of [
    ['#onpath', '沿着曲线'],
    ['#turned', '旋转的'],
    ['#perchar', '逐字旋转'],
    ['#switched', '开关里'],
    ['#emc', '能量公式'],
    ['#emc', 'E'],
  ]) {
    await select(page, css, quote);
    await expect(highlightBtn(page), `${css} ${quote}`).toBeHidden();
  }
  // A selection that runs from HTML into MathML is refused as a whole.
  await page.evaluate(() => {
    const range = document.createRange();
    range.setStart(document.querySelector('#formula').firstChild, 0);
    range.setEnd(document.querySelector('#emc mtext').firstChild, 2);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.querySelector('#formula').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  });
  await page.waitForTimeout(150);
  await expect(highlightBtn(page)).toBeHidden();
  expect(await snapshot()).toEqual(pristine);

  // Native marks where placement is exact: nested transforms and the text's own translate.
  for (const [css, quote] of [['#moved', '平移缩放'], ['#shifted', '自带平移'], ['#plain', '平面框标签']]) {
    await select(page, css, quote);
    await expect(highlightBtn(page), css).toBeVisible();
    await highlightBtn(page).click();
    const placed = await page.locator(css).evaluate((text, q) => {
      const rect = text.previousElementSibling;
      const node = text.firstChild;
      const range = document.createRange();
      range.setStart(node, node.nodeValue.indexOf(q));
      range.setEnd(node, node.nodeValue.indexOf(q) + q.length);
      const a = rect.getBoundingClientRect();
      const b = range.getBoundingClientRect();
      return rect.classList.contains('whn-svg-hl') && Math.abs(a.left - b.left) < 2 && Math.abs(a.right - b.right) < 2 && a.top <= b.top + 1 && a.bottom >= b.bottom - 1;
    }, quote);
    expect(placed, css).toBe(true);
  }
  // <foreignObject> holds HTML, so the ordinary span works there.
  await select(page, '#fo', '网页段落');
  await expect(highlightBtn(page)).toBeVisible();
  await highlightBtn(page).click();
  await expect(page.locator('#fo span.whn-hl')).toHaveText('网页段落');
  await expect.poll(async () => (await stored(key))?.highlights?.length).toBe(4);
  // Original SVG <text> nodes are untouched by all of the above.
  expect(await page.evaluate(() => [...document.querySelectorAll('#diagram text')].map((t) => t.outerHTML)))
    .toEqual(await page.evaluate((html) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return [...doc.querySelectorAll('#diagram text')].map((t) => t.outerHTML);
    }, pristine.svg));
});

test('sweep, restore path: legacy records on MathML and textPath leave the text intact and show ⚠ 未定位', async () => {
  const page = context.pages()[0];
  const url = docUrl('ns-sweep.html');
  const key = pageKey(url);
  // Build the records the way <=0.1.6 did (indexText + selectorFromOffsets, 30 chars of context).
  const quotes = await page.evaluate(() => {
    const skip = 'script, style, noscript, template, #whn-root';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.parentElement && !node.parentElement.closest(skip) && node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    let text = '';
    for (let node = walker.nextNode(); node; node = walker.nextNode()) text += node.nodeValue;
    return ['能量公式', '沿着曲线排列', '复用的定义'].map((exact, index) => {
      const start = text.indexOf(exact);
      return {
        id: `legacy-${index}`,
        text: exact,
        prefix: text.slice(Math.max(0, start - 30), start),
        suffix: text.slice(start + exact.length, start + exact.length + 30),
        comment: index === 0 ? '公式旁的评论' : '',
        draft: null,
        createdAt: 1000 + index,
        pos: start,
        anchored: true,
      };
    });
  });
  const record = await stored(key);
  record.highlights.push(...quotes);
  await worker.evaluate(async ({ k, value }) => chrome.storage.local.set({ [k]: value }), { k: key, value: record });
  await open(page, url);
  expect(await page.evaluate(() => document.querySelector('#emc').outerHTML)).toBe('<math id="emc"><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup><mtext>能量公式</mtext></math>');
  expect(await page.evaluate(() => document.querySelector('#onpath').outerHTML)).toBe('<text id="onpath"><textPath href="#curve">沿着曲线排列的文字</textPath></text>');
  await expect(page.locator('math span, svg text span')).toHaveCount(0);
  await expect.poll(async () => (await stored(key)).highlights.filter((item) => item.id.startsWith('legacy-')).map((item) => item.anchored)).toEqual([false, false, false]);
  // The earlier native marks still render next to the unanchored ones.
  await expect(page.locator('#diagram rect.whn-svg-hl')).toHaveCount(3);

  const panel = await openPanel(page);
  await expect(panel.locator('.item.unanchored')).toHaveCount(3);
  await expect(panel.locator('.item.unanchored .warn').first()).toHaveText('⚠ 未定位');
  const md = await exportMarkdown(panel);
  for (const quote of ['能量公式', '沿着曲线排列', '复用的定义']) expect(md).toContain(`> ${quote}`);
  expect(md).toContain('公式旁的评论');
  await panel.screenshot({ path: path.join(shotDir, 'sweep-unanchored-sidepanel.png') });
  await panel.close();
});
