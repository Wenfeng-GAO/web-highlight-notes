// Loads the unpacked extension's real sidepanel document
// (chrome-extension://<id>/src/sidepanel/sidepanel.html), not a copied component.
// Pages are a local fixture server and a local file. They are not a live host.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startFixtureServer } from '../fixtures/server.js';
import { chromeLocaleEnv } from './native.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shotDir = process.env.WHN_EXPORT_SHOTS || '/opt/cursor/artifacts/export-feedback';

const COPY = {
  zh: {
    locale: 'zh_CN',
    lang: 'zh-CN',
    exportLabel: '导出 MD',
    copied: '已复制 ✓',
    started: '已发起下载',
    unavailable: '此页面暂时不能导出。',
    failed: '未能复制，也没有发起下载。',
    clickToUse: '点击插件图标，在此页面使用划线笔记',
    untitled: '未命名页面',
    panelEmpty: '选中文字即可划线',
    source: '来源：',
  },
  en: {
    locale: 'en_US',
    lang: 'en-US',
    exportLabel: 'Export MD',
    copied: 'Copied ✓',
    started: 'Download started',
    unavailable: 'Export is unavailable on this page.',
    failed: "Couldn't copy or start a download.",
    clickToUse: 'Click the extension icon to use highlight notes on this page',
    untitled: 'Untitled page',
    panelEmpty: 'Select text to highlight',
    source: 'Source: ',
  },
};

const SAVED_CLAIMS = ['已下载', 'Downloaded', 'File saved', '已保存'];

function assertNotSavedClaim(text) {
  for (const claim of SAVED_CLAIMS) expect(text).not.toContain(claim);
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
  const file = path.join(shotDir, `${name}.png`);
  await panel.screenshot({ path: file });
}

async function installClipboard(panel, mode) {
  await panel.evaluate((kind) => {
    document.documentElement.dataset.clipboardText = '';
    document.documentElement.dataset.clipboardResult = '';
    window.__whnUnhandled = 0;
    window.addEventListener('unhandledrejection', () => {
      window.__whnUnhandled += 1;
    });
    navigator.clipboard.writeText = (text) => {
      document.documentElement.dataset.clipboardText = String(text);
      if (kind === 'resolve') {
        document.documentElement.dataset.clipboardResult = 'resolve';
        return Promise.resolve();
      }
      document.documentElement.dataset.clipboardResult = 'reject';
      return Promise.reject(new Error('clipboard denied'));
    };
    if (kind !== 'resolve') document.execCommand = () => false;
  }, mode);
}

for (const [tag, copy] of Object.entries(COPY)) {
  test.describe(`export feedback (${tag})`, () => {
    let fixture;
    let context;
    let extensionId;
    let worker;
    let httpTabId;
    let fileUrl;
    let otherFileUrl;

    test.beforeAll(async () => {
      fixture = await startFixtureServer();
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `whn-export-${tag}-`));
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
      const httpPage = await context.newPage();
      await httpPage.goto(fixture.url);
      httpTabId = await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return tab.id;
      });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `whn-export-file-${tag}-`));
      const filePath = path.join(dir, 'note.html');
      const otherPath = path.join(dir, 'other.html');
      fs.writeFileSync(filePath, '<!doctype html><meta charset="utf-8"><title>File note</title><p>local file fixture</p>');
      fs.writeFileSync(otherPath, '<!doctype html><meta charset="utf-8"><title>Other note</title><p>second local file fixture</p>');
      fileUrl = pathToFileURL(filePath).href;
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

    test('empty page keeps export visible but explains that it is unavailable', async () => {
      const panel = await openPanel(new URLSearchParams({ tabId: String(httpTabId) }));
      await expect(panel.locator('.app')).toHaveAttribute('data-mode', 'page');
      await expect(panel.locator('#title')).toHaveText(copy.untitled);
      await expect(panel.locator('#list .empty')).toHaveText(copy.clickToUse);
      const exportBtn = panel.locator('#export');
      await expect(exportBtn).toBeVisible();
      await expect(exportBtn).toBeDisabled();
      await expect(exportBtn).toHaveAttribute('aria-disabled', 'true');
      await expect(exportBtn).toHaveText(copy.exportLabel);
      const hint = panel.locator('#export-hint');
      await expect(hint).toBeVisible();
      await expect(hint).toHaveText(copy.unavailable);
      await expect(panel.locator('#export-error')).toBeHidden();
      await exportBtn.click({ force: true });
      await expect(exportBtn).toHaveText(copy.exportLabel);
      await expect(exportBtn).not.toHaveText(copy.copied);
      await labelFixture(panel, `${tag}-empty`);
    });

    test('a readable page restores export after the empty state', async () => {
      const panel = await openPanel(new URLSearchParams({ tabId: String(httpTabId) }));
      await expect(panel.locator('#title')).toHaveText(copy.untitled);
      await expect(panel.locator('#export')).toBeDisabled();
      const filePage = await context.newPage();
      await filePage.goto(fileUrl);
      await expect(panel.locator('#title')).toHaveText('File note');
      await expect(panel.locator('.app')).toHaveAttribute('data-mode', 'page');
      await expect(panel.locator('#list .empty')).toHaveText(copy.panelEmpty);
      const exportBtn = panel.locator('#export');
      await expect(exportBtn).toBeEnabled();
      await expect(exportBtn).toHaveAttribute('aria-disabled', 'false');
      await expect(exportBtn).toHaveText(copy.exportLabel);
      await expect(panel.locator('#export-hint')).toHaveCount(1);
      await expect(panel.locator('#export-hint')).toBeHidden();
      await expect(panel.locator('#export-error')).toBeHidden();
    });

    test('fulfilled clipboard shows Copied and does not claim the file was saved', async () => {
      const pageUrl = `${fixture.url}?case=success-${tag}`;
      const panel = await openPanel(new URLSearchParams({ url: pageUrl, title: 'Known page' }));
      await expect(panel.locator('#title')).toHaveText('Known page');
      await expect(panel.locator('#export')).toBeEnabled();
      await installClipboard(panel, 'resolve');
      const downloadPromise = panel.waitForEvent('download');
      await panel.locator('#export').click();
      await expect(panel.locator('#export')).toHaveText(copy.copied);
      const label = await panel.locator('#export').innerText();
      assertNotSavedClaim(label);
      await expect(panel.locator('#export-error')).toBeHidden();
      const written = await panel.evaluate(() => document.documentElement.dataset.clipboardText || '');
      expect(written).toContain('# Known page');
      expect(written).toContain(copy.source);
      expect(written).toContain(pageUrl);
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/\.md$/);
      await download.cancel();
      expect(await panel.evaluate(() => window.__whnUnhandled || 0)).toBe(0);
      await labelFixture(panel, `${tag}-success`);
    });

    test('rejected clipboard with a real download start says download started', async () => {
      const panel = await openPanel(new URLSearchParams({ url: `${fixture.url}?case=download-${tag}`, title: 'Download page' }));
      await expect(panel.locator('#title')).toHaveText('Download page');
      await installClipboard(panel, 'reject');
      const downloadPromise = panel.waitForEvent('download');
      await panel.locator('#export').click();
      await expect(panel.locator('#export')).not.toHaveText(copy.exportLabel, { timeout: 3000 });
      const label = await panel.locator('#export').innerText();
      expect(label).toBe(copy.started);
      expect(label).not.toBe(copy.copied);
      assertNotSavedClaim(label);
      await expect(panel.locator('#export-error')).toBeHidden();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/\.md$/);
      await download.cancel();
      expect(await panel.evaluate(() => document.documentElement.dataset.clipboardResult)).toBe('reject');
      expect(await panel.evaluate(() => window.__whnUnhandled || 0)).toBe(0);
      await labelFixture(panel, `${tag}-download-started`);
    });

    test('copy and download both failing keep the action label and a persistent error', async () => {
      const panel = await openPanel(new URLSearchParams({ url: `${fixture.url}?case=blocked-${tag}`, title: 'Blocked page' }));
      await expect(panel.locator('#title')).toHaveText('Blocked page');
      await installClipboard(panel, 'reject');
      await panel.evaluate(() => {
        HTMLAnchorElement.prototype.click = function () {
          throw new Error('download blocked');
        };
      });
      let sawDownload = false;
      panel.on('download', () => {
        sawDownload = true;
      });
      const errors = [];
      panel.on('pageerror', (error) => errors.push(error.message));
      await panel.locator('#export').click();
      const exportBtn = panel.locator('#export');
      await expect(exportBtn).toHaveText(copy.exportLabel);
      await expect(exportBtn).not.toHaveText(copy.copied);
      await expect(exportBtn).not.toHaveText(copy.started);
      const error = panel.locator('#export-error');
      await expect(error).toBeVisible();
      await expect(error).toHaveText(copy.failed);
      assertNotSavedClaim(await error.innerText());
      await labelFixture(panel, `${tag}-failure`);
      await panel.waitForTimeout(1700);
      await expect(exportBtn).toHaveText(copy.exportLabel);
      await expect(error).toBeVisible();
      expect(sawDownload).toBe(false);
      expect(errors).toEqual([]);
      expect(await panel.evaluate(() => window.__whnUnhandled || 0)).toBe(0);

      const other = await context.newPage();
      await other.goto(otherFileUrl);
      await expect(panel.locator('#title')).toHaveText('Other note');
      await expect(panel.locator('#export')).toBeEnabled();
      await expect(panel.locator('#export')).toHaveText(copy.exportLabel);
      await expect(panel.locator('#export')).toHaveAttribute('aria-disabled', 'false');
      await expect(panel.locator('#export-error')).toBeHidden();
      await expect(panel.locator('#export-hint')).toBeHidden();
    });

    test('a rejected save promise does not claim success', async () => {
      const panel = await openPanel(new URLSearchParams({ url: `${fixture.url}?case=storage-${tag}`, title: 'Storage page' }));
      await expect(panel.locator('#title')).toHaveText('Storage page');
      await panel.evaluate(() => {
        window.__whnUnhandled = 0;
        window.addEventListener('unhandledrejection', () => {
          window.__whnUnhandled += 1;
        });
        document.documentElement.dataset.clipboardText = '';
        navigator.clipboard.writeText = (text) => {
          document.documentElement.dataset.clipboardText = String(text);
          return Promise.resolve();
        };
        chrome.storage.local.set = () => Promise.reject(new Error('storage down'));
      });
      await panel.locator('#export').click();
      await expect(panel.locator('#export')).toHaveText(copy.exportLabel);
      await expect(panel.locator('#export')).not.toHaveText(copy.copied);
      await expect(panel.locator('#export-error')).toBeVisible();
      await expect(panel.locator('#export-error')).toHaveText(copy.failed);
      expect(await panel.evaluate(() => document.documentElement.dataset.clipboardText || '')).toBe('');
      expect(await panel.evaluate(() => window.__whnUnhandled || 0)).toBe(0);
    });
  });
}
