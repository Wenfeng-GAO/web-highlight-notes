// Real side panel (chrome-extension://<id>/src/sidepanel/sidepanel.js).
// Success and the explicit retry use the page's own navigator.clipboard.writeText.
// The clipboard fact is one real Ctrl+V into a blank textarea, then that
// textarea's DOM value. readText is not called. Reject stays injected.
// Download, anchor click, and createObjectURL watchers stay armed across it.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startFixtureServer } from '../fixtures/server.js';
import { chromeLocaleEnv } from './native.js';
import { pageKey } from '../../src/lib/url.js';
import { armDownloadWatch, assertDownloadWatchLive, assertNoDownload } from './read-copy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shotDir = process.env.WHN_NATIVE_SHOTS || '/cursor/stores/self/pr38-paste-3531b708/shots';
const readbackPath = process.env.WHN_NATIVE_READBACK || '/cursor/stores/self/pr38-paste-3531b708/readback.json';

const COPY = {
  zh: {
    locale: 'zh_CN',
    lang: 'zh-CN',
    copyLabel: '复制 Markdown',
    copied: '已复制 ✓',
    retry: '重试',
    unavailable: '此页面没有可复制的内容。',
    failed: '未能复制。',
    clickToUse: '点击插件图标，在此页面使用划线笔记',
    untitled: '未命名页面',
    labels: { source: '来源：', summary: '摘要', highlights: '划线', comment: '评论：' },
  },
  en: {
    locale: 'en_US',
    lang: 'en-US',
    copyLabel: 'Copy Markdown',
    copied: 'Copied ✓',
    retry: 'Try again',
    unavailable: 'There is nothing to copy on this page.',
    failed: "Couldn't copy.",
    clickToUse: 'Click the extension icon to use highlight notes on this page',
    untitled: 'Untitled page',
    labels: { source: 'Source: ', summary: 'Summary', highlights: 'Highlights', comment: 'Note: ' },
  },
};

function note(entry) {
  fs.mkdirSync(path.dirname(readbackPath), { recursive: true });
  const all = fs.existsSync(readbackPath) ? JSON.parse(fs.readFileSync(readbackPath, 'utf8')) : [];
  all.push(entry);
  fs.writeFileSync(readbackPath, `${JSON.stringify(all, null, 2)}\n`);
}

function expectedMarkdown({ title, url, date, summary, highlight, comment, labels }) {
  return `# ${title}\n${labels.source}${url} · ${date}\n## ${labels.summary}\n${summary}\n## ${labels.highlights}\n> ${highlight}\n${labels.comment}${comment}\n`;
}

async function browserDate(panel) {
  return panel.evaluate(() => {
    const date = new Date();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  });
}

async function labelFixture(panel, name) {
  await panel.evaluate((caption) => {
    document.getElementById('whn-fixture-label')?.remove();
    const bar = document.createElement('div');
    bar.id = 'whn-fixture-label';
    bar.dataset.fixture = 'browser-fixture-not-live-host';
    bar.textContent = `BROWSER FIXTURE — local extension page, not a live host · ${caption}`;
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#111;color:#fff;font:12px/1.4 system-ui,sans-serif;padding:6px 8px;pointer-events:none;';
    document.body.appendChild(bar);
  }, name);
  fs.mkdirSync(shotDir, { recursive: true });
  await panel.screenshot({ path: path.join(shotDir, `${name}.png`) });
}

async function injectClipboardReject(panel) {
  await panel.evaluate(() => {
    if (window.__whnDownloadWatch !== true) throw new Error('download watch is not armed');
    if (HTMLAnchorElement.prototype.click.__whnDownloadSpy !== true) throw new Error('anchor spy missing before reject');
    if (URL.createObjectURL.__whnDownloadSpy !== true) throw new Error('createObjectURL spy missing before reject');
    if (typeof navigator.clipboard.writeText !== 'function') throw new Error('native writeText is missing');
    window.__whnNativeWrite = navigator.clipboard.writeText;
    navigator.clipboard.writeText = () => Promise.reject(new Error('clipboard denied'));
    const rejectExec = () => false;
    window.__whnRejectExec = rejectExec;
    document.execCommand = rejectExec;
    if (HTMLAnchorElement.prototype.click.__whnDownloadSpy !== true) throw new Error('reject replaced the anchor spy');
    if (URL.createObjectURL.__whnDownloadSpy !== true) throw new Error('reject replaced the createObjectURL spy');
  });
}

async function restoreNativeWrite(panel) {
  await panel.evaluate(() => {
    if (typeof window.__whnNativeWrite !== 'function') throw new Error('native writeText was not saved');
    navigator.clipboard.writeText = window.__whnNativeWrite;
    if (navigator.clipboard.writeText !== window.__whnNativeWrite) throw new Error('native writeText was not restored');
    if (document.execCommand !== window.__whnRejectExec) throw new Error('execCommand fallback was restored');
    if (HTMLAnchorElement.prototype.click.__whnDownloadSpy !== true) throw new Error('restore replaced the anchor spy');
    if (URL.createObjectURL.__whnDownloadSpy !== true) throw new Error('restore replaced the createObjectURL spy');
  });
}

async function probeWatchers(panel, downloads) {
  const before = downloads.length;
  await panel.evaluate(() => {
    const blobUrl = URL.createObjectURL(new Blob(['probe'], { type: 'text/markdown' }));
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = 'watch-probe.md';
    document.body.appendChild(anchor);
    anchor.click();
  });
  await panel.waitForTimeout(500);
  const spies = await panel.evaluate(() => ({
    anchors: (window.__whnAnchorClicks || []).filter((item) => item.download === 'watch-probe.md').length,
    urls: window.__whnObjectUrls || 0,
  }));
  return { anchors: spies.anchors, urls: spies.urls, downloads: downloads.slice(before) };
}

for (const [tag, copy] of Object.entries(COPY)) {
  test.describe(`native clipboard readback (${tag})`, () => {
    let fixture;
    let context;
    let extensionId;
    let worker;
    let httpTabId;
    let otherFileUrl;

    test.beforeAll(async () => {
      fixture = await startFixtureServer();
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `whn-native-${tag}-`));
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        viewport: { width: 400, height: 720 },
        acceptDownloads: true,
        env: chromeLocaleEnv(copy.locale),
        args: [
          `--disable-extensions-except=${root}`,
          `--load-extension=${root}`,
          '--no-first-run',
          '--disable-default-apps',
          `--lang=${copy.lang}`,
        ],
      });
      context._userDataDir = userDataDir;
      let [background] = context.serviceWorkers();
      if (!background) background = await context.waitForEvent('serviceworker', { timeout: 20000 });
      worker = background;
      extensionId = new URL(background.url()).host;
      context._grantError = '';
      try {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
          origin: `chrome-extension://${extensionId}`,
        });
      } catch (error) {
        context._grantError = error instanceof Error ? error.message : String(error);
      }
      const httpPage = await context.newPage();
      await httpPage.goto(fixture.url);
      httpTabId = await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return tab.id;
      });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `whn-native-file-${tag}-`));
      const otherPath = path.join(dir, 'other.html');
      fs.writeFileSync(otherPath, '<!doctype html><meta charset="utf-8"><title>Other note</title><p>second local file fixture</p>');
      otherFileUrl = pathToFileURL(otherPath).href;
    });

    test.afterAll(async () => {
      await context?.close();
      await fixture?.close();
      if (context?._userDataDir) fs.rmSync(context._userDataDir, { recursive: true, force: true });
    });

    async function openPanel(query) {
      const panel = await context.newPage();
      await panel.setViewportSize({ width: 400, height: 720 });
      const suffix = query ? `?${query}` : '';
      await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html${suffix}`);
      const script = await panel.evaluate(() => document.querySelector('script[type="module"]')?.src || '');
      expect(script).toBe(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.js`);
      return panel;
    }

    function record(entry) {
      note({ tag, grantError: context._grantError || '', ...entry });
    }

    async function pasteOnce() {
      const editor = await context.newPage();
      await editor.setViewportSize({ width: 800, height: 480 });
      await editor.goto(fixture.pasteUrl);
      await editor.evaluate(() => {
        window.__whnPasteEvents = [];
        document.addEventListener('paste', (event) => {
          window.__whnPasteEvents.push({
            type: event.type,
            isTrusted: event.isTrusted,
            defaultPrevented: event.defaultPrevented,
          });
        }, true);
      });
      const target = editor.locator('#paste-target');
      await expect(target).toHaveValue('');
      await editor.bringToFront();
      await target.click({ timeout: 8000 });
      const focused = await editor.evaluate(() => ({
        origin: location.origin,
        hasFocus: document.hasFocus(),
        activeId: document.activeElement?.id || '',
      }));
      expect(focused).toMatchObject({ hasFocus: true, activeId: 'paste-target' });
      await editor.keyboard.press('Control+V');
      await editor.waitForTimeout(500);
      return {
        pasted: await target.inputValue(),
        pasteEvents: await editor.evaluate(() => window.__whnPasteEvents || []),
        focused,
      };
    }

    async function seed(url, record) {
      const key = pageKey(url);
      await worker.evaluate(async ({ key, record }) => {
        await chrome.storage.local.set({ [key]: record });
      }, { key, record: { ...record, url: key } });
      return key;
    }

    test('empty page keeps copy disabled', async () => {
      const panel = await openPanel(new URLSearchParams({ tabId: String(httpTabId) }));
      await expect(panel.locator('#title')).toHaveText(copy.untitled);
      const exportBtn = panel.locator('#export');
      await expect(exportBtn).toBeDisabled();
      await expect(exportBtn).toHaveAttribute('aria-disabled', 'true');
      await expect(exportBtn).toHaveText(copy.copyLabel);
      await expect(panel.locator('#list .empty')).toHaveText(copy.clickToUse);
      await expect(panel.locator('#export-hint')).toHaveText(copy.unavailable);
      const downloads = await armDownloadWatch(panel);
      await exportBtn.click({ force: true });
      await expect(exportBtn).toBeDisabled();
      await expect(exportBtn).toHaveText(copy.copyLabel);
      await expect(exportBtn).not.toHaveText(copy.copied);
      await expect(exportBtn).not.toHaveText(copy.retry);
      await assertNoDownload(panel, downloads);
      await assertDownloadWatchLive(panel);
      const probe = await probeWatchers(panel, downloads);
      expect(probe.anchors).toBe(1);
      expect(probe.urls).toBeGreaterThan(0);
      expect(probe.downloads).toEqual(['watch-probe.md']);
      record({ case: 'empty', productDownloads: [], probe, pasted: null });
      await labelFixture(panel, `${tag}-empty`);
    });

    test('human click writes with native writeText and Ctrl+V matches the markdown', async () => {
      const pageUrl = `${fixture.url}?case=native-success-${tag}`;
      const body = {
        title: 'Native page',
        summary: 'Seed summary',
        highlights: [{ id: 'h1', text: 'Alpha line', comment: 'Beta note', pos: 1, createdAt: 1 }],
      };
      const key = await seed(pageUrl, body);
      const panel = await openPanel(new URLSearchParams({ url: pageUrl, title: body.title }));
      await expect(panel.locator('#title')).toHaveText(body.title);
      await expect(panel.locator('#summary')).toHaveValue(body.summary);
      await expect(panel.locator('.quote')).toHaveText('Alpha line');
      await expect(panel.locator('.comment')).toHaveText('Beta note');
      await expect(panel.locator('#export')).toBeEnabled();
      await expect(panel.locator('#export')).toHaveText(copy.copyLabel);
      await panel.evaluate(() => {
        window.__whnExecCopy = 0;
        const original = document.execCommand.bind(document);
        document.execCommand = (command, ...args) => {
          if (String(command).toLowerCase() === 'copy') window.__whnExecCopy += 1;
          return original(command, ...args);
        };
      });
      const downloads = await armDownloadWatch(panel);
      const date = await browserDate(panel);
      const expected = expectedMarkdown({
        title: body.title,
        url: key,
        date,
        summary: body.summary,
        highlight: 'Alpha line',
        comment: 'Beta note',
        labels: copy.labels,
      });
      await panel.bringToFront();
      await panel.locator('#export').click();
      await expect(panel.locator('#export')).toHaveText(copy.copied);
      await expect(panel.locator('#export-error')).toBeHidden();
      await labelFixture(panel, `${tag}-success`);
      const execCopyCount = await panel.evaluate(() => window.__whnExecCopy || 0);
      expect(execCopyCount).toBe(0);
      await assertNoDownload(panel, downloads);
      const pasted = await pasteOnce();
      record({
        case: 'success',
        pasted: pasted.pasted,
        expected,
        match: pasted.pasted === expected,
        pasteEvents: pasted.pasteEvents,
        focused: pasted.focused,
        execCopyCount,
        productDownloads: [...downloads],
        programmaticRead: 'not used; clipboard-read stays prompt and grantPermissions cannot target the extension origin',
      });
      expect(pasted.pasteEvents).toEqual([{ type: 'paste', isTrusted: true, defaultPrevented: false }]);
      expect(pasted.pasted).toBe(expected);
      await assertNoDownload(panel, downloads);
      await assertDownloadWatchLive(panel);
      const probe = await probeWatchers(panel, downloads);
      expect(probe.anchors).toBe(1);
      expect(probe.urls).toBeGreaterThan(0);
      expect(probe.downloads).toEqual(['watch-probe.md']);
    });

    test('rejected clipboard stays visible and downloads nothing', async () => {
      const pageUrl = `${fixture.url}?case=native-fail-${tag}`;
      const panel = await openPanel(new URLSearchParams({ url: pageUrl, title: 'Blocked page' }));
      await expect(panel.locator('#title')).toHaveText('Blocked page');
      const downloads = await armDownloadWatch(panel);
      await injectClipboardReject(panel);
      await assertDownloadWatchLive(panel);
      await panel.locator('#export').click();
      await assertNoDownload(panel, downloads);
      const exportBtn = panel.locator('#export');
      await expect(exportBtn).toHaveText(copy.retry);
      await expect(exportBtn).toBeEnabled();
      await expect(exportBtn).not.toHaveText(copy.copied);
      await expect(panel.locator('#export-error')).toBeVisible();
      await expect(panel.locator('#export-error')).toHaveText(copy.failed);
      await labelFixture(panel, `${tag}-failure`);
      await panel.waitForTimeout(1700);
      await expect(exportBtn).toHaveText(copy.retry);
      await expect(panel.locator('#export-error')).toBeVisible();
      await assertNoDownload(panel, downloads);
      await assertDownloadWatchLive(panel);
      const other = await context.newPage();
      await other.goto(otherFileUrl);
      await expect(panel.locator('#title')).toHaveText('Other note');
      await expect(panel.locator('#export')).toBeEnabled();
      await expect(panel.locator('#export')).toHaveText(copy.copyLabel);
      await expect(panel.locator('#export-error')).toBeHidden();
      await expect(panel.locator('#export-hint')).toBeHidden();
      await assertNoDownload(panel, downloads);
      const probe = await probeWatchers(panel, downloads);
      expect(probe.anchors).toBe(1);
      expect(probe.urls).toBeGreaterThan(0);
      expect(probe.downloads).toEqual(['watch-probe.md']);
      record({ case: 'failure-persists', productDownloads: [], probe });
    });

    test('explicit retry restores native writeText and Ctrl+V matches', async () => {
      const pageUrl = `${fixture.url}?case=native-retry-${tag}`;
      const body = {
        title: 'Retry page',
        summary: 'Retry summary',
        highlights: [{ id: 'h2', text: 'Gamma line', comment: 'Delta note', pos: 1, createdAt: 1 }],
      };
      const key = await seed(pageUrl, body);
      const panel = await openPanel(new URLSearchParams({ url: pageUrl, title: body.title }));
      await expect(panel.locator('#title')).toHaveText(body.title);
      await expect(panel.locator('#summary')).toHaveValue(body.summary);
      await expect(panel.locator('.quote')).toHaveText('Gamma line');
      const downloads = await armDownloadWatch(panel);
      await injectClipboardReject(panel);
      await panel.locator('#export').click();
      await assertNoDownload(panel, downloads);
      await expect(panel.locator('#export')).toHaveText(copy.retry);
      await expect(panel.locator('#export-error')).toHaveText(copy.failed);
      await assertDownloadWatchLive(panel);
      await restoreNativeWrite(panel);
      const nativeRestored = await panel.evaluate(() => navigator.clipboard.writeText === window.__whnNativeWrite);
      expect(nativeRestored).toBe(true);
      const date = await browserDate(panel);
      const expected = expectedMarkdown({
        title: body.title,
        url: key,
        date,
        summary: body.summary,
        highlight: 'Gamma line',
        comment: 'Delta note',
        labels: copy.labels,
      });
      await panel.bringToFront();
      await panel.locator('#export').click();
      await expect(panel.locator('#export')).toHaveText(copy.copied);
      await expect(panel.locator('#export-error')).toBeHidden();
      await labelFixture(panel, `${tag}-retry`);
      await assertNoDownload(panel, downloads);
      const pasted = await pasteOnce();
      record({
        case: 'retry',
        pasted: pasted.pasted,
        expected,
        match: pasted.pasted === expected,
        pasteEvents: pasted.pasteEvents,
        focused: pasted.focused,
        writeIsNative: true,
        productDownloads: [...downloads],
        programmaticRead: 'not used; clipboard-read stays prompt and grantPermissions cannot target the extension origin',
      });
      expect(pasted.pasteEvents).toEqual([{ type: 'paste', isTrusted: true, defaultPrevented: false }]);
      expect(pasted.pasted).toBe(expected);
      await assertDownloadWatchLive(panel);
      const probe = await probeWatchers(panel, downloads);
      expect(probe.anchors).toBe(1);
      expect(probe.urls).toBeGreaterThan(0);
      expect(probe.downloads).toEqual(['watch-probe.md']);
    });
  });
}
