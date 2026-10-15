// Acceptance #5: update 0.1.3 -> 0.1.4 in place (same unpacked path, same
// profile, so same extension id and storage). 0.1.3 had host_permissions
// <all_urls>; 0.1.4 moves host access to optional_host_permissions.
import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageKey } from '../../src/lib/url.js';
import { startFixtureServer } from '../fixtures/server.js';
import { chromeLocaleEnv } from './native.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const QUOTE_1 = '春天的花园里开满了黄色的花';
const QUOTE_2 = '研究者在图书馆发现了一份手稿';
const COMMENT_2 = '这份手稿很关键';
const SUMMARY = '升级前写的摘要';

function exportOldRelease(dest) {
  // CI checks out shallow; fetch the tag if needed.
  try {
    execFileSync('git', ['rev-parse', '--verify', 'v0.1.3^{commit}'], { cwd: root, stdio: 'pipe' });
  } catch {
    execFileSync('git', ['fetch', '--depth=1', 'origin', 'tag', 'v0.1.3'], { cwd: root, stdio: 'pipe' });
  }
  const tar = execFileSync('git', ['archive', '--format=tar', 'v0.1.3', 'manifest.json', 'src', 'icons'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dest], { input: tar });
}

function installCurrent(dest) {
  for (const entry of fs.readdirSync(dest)) fs.rmSync(path.join(dest, entry), { recursive: true, force: true });
  for (const entry of ['manifest.json', 'src', 'icons', '_locales']) {
    fs.cpSync(path.join(root, entry), path.join(dest, entry), { recursive: true });
  }
}

async function launch(extDir, userDataDir) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    env: chromeLocaleEnv('zh_CN'),
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-first-run',
      '--disable-default-apps',
      '--lang=zh-CN',
    ],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  return { context, worker, extensionId: new URL(worker.url()).host };
}

let fixture;
let extDir;
let userDataDir;

test.beforeAll(async () => {
  fixture = await startFixtureServer();
  extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-upgrade-ext-'));
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-upgrade-profile-'));
});

test.afterAll(async () => {
  await fixture?.close();
  for (const dir of [extDir, userDataDir]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('upgrade from 0.1.3 keeps notes, the site grant, auto-restore, side panel and export', async () => {
  // 1. 0.1.3: make notes through the real UI.
  exportOldRelease(extDir);
  let { context, worker } = await launch(extDir, userDataDir);
  expect(await worker.evaluate(() => chrome.runtime.getManifest().version)).toBe('0.1.3');
  let page = context.pages()[0] || await context.newPage();
  await page.goto(fixture.url);
  await page.waitForFunction(() => document.documentElement.dataset.whnReady === '1');
  const key = pageKey(page.url());
  for (const [selector, quote] of [['#p1', QUOTE_1], ['#p2', QUOTE_2]]) {
    await page.evaluate(({ css, text }) => {
      const element = document.querySelector(css);
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
        return;
      }
    }, { css: selector, text: quote });
    await page.getByRole('button', { name: '划线', exact: true }).click();
    await expect(page.locator('.whn-hl', { hasText: quote })).toHaveCount(1);
  }
  await worker.evaluate(async ({ k, summary, quote, comment }) => {
    const record = (await chrome.storage.local.get(k))[k];
    record.summary = summary;
    record.highlights.find((h) => h.text === quote).comment = comment;
    await chrome.storage.local.set({ [k]: record });
  }, { k: key, summary: SUMMARY, quote: QUOTE_2, comment: COMMENT_2 });
  const before = await worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
  expect(before.highlights).toHaveLength(2);
  await context.close();

  // 2. Update in place to 0.1.4.
  installCurrent(extDir);
  // A store update re-registers the extension service worker. Relaunching with a
  // changed unpacked folder does not (Chrome kept running the cached 0.1.3
  // worker script), so drop the profile's worker cache to get the same effect.
  // Permissions and storage live elsewhere in the profile and are untouched.
  fs.rmSync(path.join(userDataDir, 'Default', 'Service Worker'), { recursive: true, force: true });
  ({ context, worker } = await launch(extDir, userDataDir));
  const extensionId = new URL(worker.url()).host;
  expect(await worker.evaluate(() => chrome.runtime.getManifest().version)).toBe('0.1.4');

  // Observed: Chrome keeps the old <all_urls> grant, narrowed to the new optional set.
  const granted = await worker.evaluate(() => chrome.permissions.getAll());
  console.log('UPGRADE granted after update:', JSON.stringify(granted));
  expect(granted.origins.sort()).toEqual(['http://*/*', 'https://*/*']);
  expect(await worker.evaluate(() => chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] }))).toBe(true);

  // Sites that already had notes get the persistent script; other sites do not.
  await expect.poll(() => worker.evaluate(async () => {
    const [script] = await chrome.scripting.getRegisteredContentScripts({ ids: ['whn-auto'] });
    return script ? { matches: script.matches, persist: script.persistAcrossSessions } : null;
  })).toEqual({ matches: ['http://127.0.0.1/*'], persist: true });
  expect(await worker.evaluate(async () => (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick)).toBe(false);

  // Storage is untouched.
  expect(await worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key)).toEqual(before);

  // Auto-restore on load with no click.
  page = context.pages()[0] || await context.newPage();
  await page.goto(fixture.url);
  await page.waitForFunction(() => document.documentElement.dataset.whnReady === '1');
  await expect(page.locator('.whn-hl', { hasText: QUOTE_1 })).toHaveCount(1);
  await expect(page.locator('.whn-hl-end.whn-has-comment', { hasText: QUOTE_2 })).toHaveCount(1);

  // A site with no notes is not auto-injected even though the broad grant covers it.
  const other = await context.newPage();
  await other.goto(fixture.url.replace('127.0.0.1', 'localhost'));
  await other.waitForTimeout(1200);
  expect(await other.evaluate(() => document.documentElement.dataset.whnReady || '')).toBe('');
  await other.close();

  // Side panel lists the notes with no 需点击 status, and export carries them.
  const tabId = await page.evaluate(() => document.documentElement.dataset.whnTab);
  const panel = await context.newPage();
  const params = new URLSearchParams({ tabId, url: page.url(), title: '测试文章：阅读与笔记' });
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?${params}`);
  await expect(panel.locator('#counts')).toHaveText('2 条划线 · 1 条评论');
  await expect(panel.locator('#summary')).toHaveValue(SUMMARY);
  await expect(panel.locator('.quote').nth(0)).toHaveText(QUOTE_1);
  await expect(panel.locator('.quote').nth(1)).toHaveText(QUOTE_2);
  await expect(panel.locator('#status')).toBeHidden();
  const downloadPromise = panel.waitForEvent('download');
  await panel.getByRole('button', { name: '导出 MD', exact: true }).click();
  const download = await downloadPromise;
  const file = path.join(os.tmpdir(), `whn-upgrade-${Date.now()}.md`);
  await download.saveAs(file);
  const markdown = fs.readFileSync(file, 'utf8');
  expect(markdown).toContain(`> ${QUOTE_1}`);
  expect(markdown).toContain(`> ${QUOTE_2}\n评论：${COMMENT_2}`);
  expect(markdown).toContain(`## 摘要\n${SUMMARY}`);
  await context.close();
});
