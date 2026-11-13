// Positive controls for the in-page comment UI and the permission card.
// The attack cases fail on the open-shadow / query-string build and pass once
// the page cannot read the bubble and the card will not grant or decline from
// an unauthenticated embed.
import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageKey } from '../../src/lib/url.js';
import { startFixtureServer } from '../fixtures/server.js';
import { answerPermissionDialog, chromeLocaleEnv, clickActionIcon } from './native.js';
import { expectOverlay, overlayBubbleState, overlayButton, overlayDialog, promptShown, readyPrompt } from './overlay-ui.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const QUOTE = '春天的花园里开满了黄色的花';
const SECRET = 'SECRET_NOTE_9f3c';
const EVIL = 'https://whn-audit-control.test/*';
const WILDCARD = 'https://*/*';

let fixture;
let context;
let worker;
let extensionId;
let userDataDir;

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

async function declinedKeys() {
  const declined = await worker.evaluate(async () => (await chrome.storage.local.get('__whn:declined'))['__whn:declined'] || {});
  return Object.keys(declined).sort();
}

async function contains(pattern) {
  return worker.evaluate((origins) => chrome.permissions.contains({ origins }), [pattern]);
}

async function storedComment(page) {
  const key = pageKey(page.url());
  const row = await worker.evaluate(async (storageKey) => (await chrome.storage.local.get(storageKey))[storageKey] || null, key);
  return row?.highlights?.[0]?.comment ?? null;
}

// The permission bubble is drawn inside the Chrome window, so it is not a new
// X11 window and Playwright never emits a popup. A real prompt dims the page
// with a large neutral scrim; the in-page card does not.
function permissionScrim() {
  const png = path.join(os.tmpdir(), 'whn-perm-scrim.png');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-video_size', '1920x1200', '-i', process.env.DISPLAY || ':1', '-frames:v', '1', png], { stdio: 'pipe' });
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', png, '-vf', 'scale=480:300', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1_000_000 });
  const width = 480;
  const height = Math.floor(300 * 0.82);
  let scrim = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      const red = raw[index];
      const green = raw[index + 1];
      const blue = raw[index + 2];
      if (Math.abs(red - green) < 12 && Math.abs(green - blue) < 12 && red > 60 && red < 120) scrim += 1;
    }
  }
  return scrim;
}

function shot(name) {
  const dir = process.env.WHN_FIXED_SHOTS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(os.tmpdir(), 'whn-perm-scrim.png'), path.join(dir, name));
}

async function armRequestProbe(frame) {
  await frame.waitForLoadState('load');
  await frame.evaluate(() => {
    const original = chrome.permissions.request.bind(chrome.permissions);
    const calls = [];
    chrome.permissions.request = (options) => {
      calls.push(options?.origins ? [...options.origins] : []);
      return original(options);
    };
    window.__whnRequestProbe = calls;
  });
}

async function clickAndWatch(page, frame, name) {
  await armRequestProbe(frame);
  await page.bringToFront();
  const before = permissionScrim();
  await frame.getByRole('button', { name, exact: true }).click();
  await page.waitForTimeout(700);
  const after = permissionScrim();
  const requests = await frame.evaluate(() => window.__whnRequestProbe || []);
  const ready = await frame.evaluate(() => document.documentElement.dataset.ready || '');
  return { requests, dialog: after > before + 5000, before, after, ready };
}

async function plant(page, src) {
  const opened = page.waitForEvent('framenavigated', {
    predicate: (frame) => frame.url().startsWith(src),
    timeout: 8000,
  });
  await page.evaluate((next) => {
    document.querySelector('#war')?.remove();
    const iframe = document.createElement('iframe');
    iframe.id = 'war';
    iframe.src = next;
    iframe.style.cssText = 'width:640px;height:90px;border:0';
    document.body.append(iframe);
  }, src);
  const frame = await opened;
  await frame.waitForLoadState('load');
  return frame;
}

function promptUrl(query) {
  return `chrome-extension://${extensionId}/src/prompt/prompt.html${query}`;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fixture = await startFixtureServer();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-trust-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1100, height: 800 },
    env: chromeLocaleEnv('zh_CN'),
    args: [
      '--lang=zh-CN',
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      '--no-first-run',
      '--disable-default-apps',
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

test('attack: page cannot read, reopen, or overwrite a comment, and a hostile embed cannot grant or decline', async () => {
  const page = context.pages()[0] || await context.newPage();
  await page.goto(site('attack.test'));
  await clickActionIcon(page);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.whnReady || '')).toBe('1');
  await selectText(page, '#p1', QUOTE);
  await overlayButton(page, '划线+评论').click();
  const dialog = overlayDialog(page, '划线评论');
  await dialog.getByRole('textbox', { name: '评论' }).fill(SECRET);

  const readWhileOpen = await page.evaluate(() => {
    const shadow = document.querySelector('#whn-root')?.shadowRoot;
    return shadow?.querySelector('textarea')?.value ?? null;
  });
  const openOnCdp = await overlayBubbleState(page);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  expect(await storedComment(page)).toBe(SECRET);

  const reopened = await page.evaluate(() => {
    getSelection()?.removeAllRanges();
    const mark = document.querySelector('.whn-hl');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    mark?.dispatchEvent(event);
    const shadow = document.querySelector('#whn-root')?.shadowRoot;
    const textarea = shadow?.querySelector('textarea');
    if (textarea) {
      textarea.value = 'PAGE_OVERWRITE_9f3c';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      shadow.querySelector('[data-action="save"]')?.click();
    }
    return {
      trusted: event.isTrusted,
      shadow: shadow ? 'open' : null,
      bubbleOpen: !!shadow?.querySelector('.bubble')?.classList.contains('open'),
      read: textarea?.value ?? null,
    };
  });
  await page.waitForTimeout(300);
  const closedOnCdp = await overlayBubbleState(page);

  const retarget = await page.evaluate((id) => {
    const iframe = document.querySelector('#whn-root')?.shadowRoot?.querySelector('iframe.prompt');
    if (!iframe) return false;
    iframe.src = `chrome-extension://${id}/src/prompt/prompt.html?origin=${encodeURIComponent('https://*/*')}`;
    return true;
  }, extensionId);

  const embed = await context.newPage();
  await embed.goto(site('embed.test'));
  async function hostile(query, button) {
    const frame = await plant(embed, promptUrl(query));
    const watched = await clickAndWatch(embed, frame, button);
    if (watched.dialog) await answerPermissionDialog(embed, false);
    return watched;
  }
  const evilLater = await hostile(`?origin=${encodeURIComponent(EVIL)}`, '暂不');
  const afterLater = await declinedKeys();
  const wildcardLater = await hostile(`?origin=${encodeURIComponent(WILDCARD)}`, '暂不');
  const afterWildcard = await declinedKeys();
  const forgedAllow = await hostile(`?origin=${encodeURIComponent('https://not-the-page.test/*')}`, '允许');
  shot('unbound-allow-no-dialog.png');
  const granted = await contains('https://not-the-page.test/*');
  const afterAllow = await declinedKeys();

  const forged = await page.evaluate(() => {
    const before = document.documentElement.dataset.whnSite || '';
    window.postMessage({ whnPrompt: true, type: 'done', granted: true }, '*');
    return { before, after: document.documentElement.dataset.whnSite || '' };
  });

  expect({
    readWhileOpen,
    shadow: reopened.shadow,
    untrusted: reopened.trusted,
    reopened: reopened.bubbleOpen,
    leakedOnReopen: reopened.read,
    comment: await storedComment(page),
    cdpOpen: openOnCdp.open,
    cdpOpenShown: openOnCdp.shown,
    cdpOpenValue: openOnCdp.value,
    cdpClosed: closedOnCdp.open,
    cdpClosedShown: closedOnCdp.shown,
    cdpClosedDisplay: closedOnCdp.display,
    cdpClosedValue: closedOnCdp.value,
    evilDeclined: afterLater.includes(EVIL),
    evilDialog: evilLater.dialog,
    evilRequests: evilLater.requests.length,
    wildcardDeclined: afterWildcard.includes(WILDCARD),
    wildcardDialog: wildcardLater.dialog,
    wildcardRequests: wildcardLater.requests.length,
    embedGranted: granted,
    allowWroteNotThePage: afterAllow.includes('https://not-the-page.test/*'),
    allowDialog: forgedAllow.dialog,
    allowRequests: forgedAllow.requests,
    allowReady: forgedAllow.ready,
    forgedGranted: forged.after === 'granted',
    retargeted: retarget,
  }).toEqual({
    readWhileOpen: null,
    shadow: null,
    untrusted: false,
    reopened: false,
    leakedOnReopen: null,
    comment: SECRET,
    cdpOpen: true,
    cdpOpenShown: true,
    cdpOpenValue: SECRET,
    cdpClosed: false,
    cdpClosedShown: false,
    cdpClosedDisplay: 'none',
    cdpClosedValue: SECRET,
    evilDeclined: false,
    evilDialog: false,
    evilRequests: 0,
    wildcardDeclined: false,
    wildcardDialog: false,
    wildcardRequests: 0,
    embedGranted: false,
    allowWroteNotThePage: false,
    allowDialog: false,
    allowRequests: [],
    allowReady: '',
    forgedGranted: false,
    retargeted: false,
  });
  await embed.close();
});

test('tokens: wrong, missing, expired, and cross-tab replay do not request or decline', async () => {
  const replay = await context.newPage();
  await replay.goto(site('replay.test'));
  await clickActionIcon(replay);
  await expect.poll(() => replay.evaluate(() => document.documentElement.dataset.whnReady || '')).toBe('1');
  await selectText(replay, '#p1', QUOTE);
  await overlayButton(replay, '划线').click();
  const live = await readyPrompt(replay);
  const ctx = new URL(live.url()).searchParams.get('ctx');
  expect(ctx).toMatch(/^[a-f0-9]{32}$/);
  const record = await worker.evaluate(async (token) => {
    const key = `__whn:ctx:${token}`;
    const stored = (await chrome.storage.session.get(key))[key];
    return stored ? { keys: Object.keys(stored).sort(), pattern: stored.pattern, tabId: stored.tabId } : null;
  }, ctx);
  expect(record.keys).toEqual(['exp', 'pattern', 'tabId']);
  expect(record.pattern).toBe('http://replay.test/*');
  expect(record.tabId).toBe(Number(await replay.evaluate(() => document.documentElement.dataset.whnTab)));

  const other = await context.newPage();
  await other.goto(site('other.test'));
  const replayed = await plant(other, promptUrl(`?ctx=${ctx}`));
  const replayAllow = await clickAndWatch(other, replayed, '允许');
  if (replayAllow.dialog) await answerPermissionDialog(other, false);
  const replayLater = await clickAndWatch(other, replayed, '暂不');
  expect(replayAllow.ready).toBe('');
  expect(replayAllow.dialog).toBe(false);
  expect(replayAllow.requests).toEqual([]);
  expect(replayLater.dialog).toBe(false);
  expect(replayLater.requests).toEqual([]);
  expect(await contains('http://replay.test/*')).toBe(false);
  expect(await declinedKeys()).not.toContain('http://replay.test/*');

  const wrong = await plant(other, promptUrl('?ctx=0123456789abcdef0123456789abcdef'));
  const wrongAllow = await clickAndWatch(other, wrong, '允许');
  if (wrongAllow.dialog) await answerPermissionDialog(other, false);
  const missing = await plant(other, promptUrl(''));
  const missingLater = await clickAndWatch(other, missing, '暂不');
  expect(wrongAllow.ready).toBe('');
  expect(wrongAllow.dialog).toBe(false);
  expect(wrongAllow.requests).toEqual([]);
  expect(missingLater.ready).toBe('');
  expect(missingLater.dialog).toBe(false);
  expect(missingLater.requests).toEqual([]);

  const expired = await worker.evaluate(async (token) => {
    const key = `__whn:ctx:${token}`;
    const stored = (await chrome.storage.session.get(key))[key];
    stored.exp = Date.now() - 1000;
    await chrome.storage.session.set({ [key]: stored });
    return stored.exp < Date.now();
  }, ctx);
  expect(expired).toBe(true);
  const stale = await plant(replay, promptUrl(`?ctx=${ctx}`));
  const staleAllow = await clickAndWatch(replay, stale, '允许');
  if (staleAllow.dialog) await answerPermissionDialog(replay, false);
  const staleLater = await clickAndWatch(replay, stale, '暂不');
  shot('expired-allow-no-dialog.png');
  expect(staleAllow.ready).toBe('');
  expect(staleAllow.dialog).toBe(false);
  expect(staleAllow.requests).toEqual([]);
  expect(staleLater.dialog).toBe(false);
  expect(staleLater.requests).toEqual([]);
  expect(await contains('http://replay.test/*')).toBe(false);
  expect(await declinedKeys()).not.toContain('http://replay.test/*');
  await other.close();
  await replay.close();
});

test('user: real clicks type, save, and reload a comment; the card grants and declines only that host', async () => {
  const page = await context.newPage();
  await page.goto(site('a.test'));
  await clickActionIcon(page);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.whnReady || '')).toBe('1');
  await selectText(page, '#p1', QUOTE);
  await overlayButton(page, '划线+评论').click();
  const dialog = overlayDialog(page, '划线评论');
  await dialog.getByRole('textbox', { name: '评论' }).pressSequentially('手写评论');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  expect(await storedComment(page)).toBe('手写评论');

  await expect.poll(() => promptShown(page)).toBe(true);
  const frame = await readyPrompt(page);
  expect(frame.url()).toContain('ctx=');
  expect(frame.url()).not.toContain('origin=');
  expect(await frame.locator('.text').textContent()).toContain('允许在此网站自动显示划线');
  await page.screenshot({ path: path.join(os.tmpdir(), 'whn-card.png') }).catch(() => {});
  if (process.env.WHN_FIXED_SHOTS) {
    fs.mkdirSync(process.env.WHN_FIXED_SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.WHN_FIXED_SHOTS, 'legitimate-card.png') });
  }
  const grant = await clickAndWatch(page, frame, '允许');
  shot('legitimate-grant-dialog.png');
  expect(grant.dialog, `scrim ${grant.before} -> ${grant.after}`).toBe(true);
  expect(grant.requests).toEqual([['http://a.test/*']]);
  await answerPermissionDialog(page, true);
  await expect.poll(() => contains('http://a.test/*')).toBe(true);
  expect(await contains('http://b.test/*')).toBe(false);
  expect(await contains(EVIL)).toBe(false);

  await page.reload();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.whnReady || '')).toBe('1');
  await page.locator('.whn-hl', { hasText: QUOTE }).click();
  await expectOverlay(dialog.getByRole('textbox', { name: '评论' })).toHaveValue('手写评论');

  const other = await context.newPage();
  await other.goto(site('b.test'));
  await clickActionIcon(other);
  await expect.poll(() => other.evaluate(() => document.documentElement.dataset.whnReady || '')).toBe('1');
  await selectText(other, '#p2', '研究者在图书馆发现了一份手稿');
  await overlayButton(other, '划线').click();
  await expect.poll(() => promptShown(other)).toBe(true);
  const otherFrame = await readyPrompt(other);
  expect(new URL(otherFrame.url()).searchParams.get('origin')).toBeNull();
  const decline = await clickAndWatch(other, otherFrame, '暂不');
  shot('legitimate-decline-no-chrome-dialog.png');
  expect(decline.dialog, `scrim ${decline.before} -> ${decline.after}`).toBe(false);
  expect(decline.requests).toEqual([]);
  await expect.poll(() => promptShown(other)).toBe(false);
  expect(await contains('http://b.test/*')).toBe(false);
  expect(await declinedKeys()).toEqual(['http://b.test/*']);
  await other.close();
  await page.close();
});
