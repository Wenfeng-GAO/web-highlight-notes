// Regression record for the 0.1.3 bug Wenfeng hit: on a local file:// page the
// highlights show, but the side panel says 「未打开页面 · 0 条划线」. Runs the real
// v0.1.3 release (git tag) and asserts the broken state, so the root cause stays
// documented: 0.1.3's side panel accepted only http(s) URLs (isWebUrl).
import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromeLocaleEnv } from './native.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('0.1.3 baseline: file:// highlights render but the side panel shows 「未打开页面」', async () => {
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-013-'));
  const docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-013-doc-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-013-profile-'));
  try {
    execFileSync('git', ['rev-parse', '--verify', 'v0.1.3^{commit}'], { cwd: root, stdio: 'pipe' });
  } catch {
    execFileSync('git', ['fetch', '--depth=1', 'origin', 'tag', 'v0.1.3'], { cwd: root, stdio: 'pipe' });
  }
  const tar = execFileSync('git', ['archive', '--format=tar', 'v0.1.3', 'manifest.json', 'src', 'icons'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', extDir], { input: tar });
  fs.copyFileSync(path.join(root, 'tests/fixtures/article.html'), path.join(docDir, 'x.html'));
  const docUrl = pathToFileURL(path.join(docDir, 'x.html')).href;
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    env: chromeLocaleEnv('zh_CN'),
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run', '--lang=zh-CN'],
  });
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).host;
    const page = context.pages()[0] || await context.newPage();
    await page.goto(docUrl);
    await page.waitForFunction(() => document.documentElement.dataset.whnReady === '1');
    await worker.evaluate(async (key) => {
      await chrome.storage.local.set({ [key]: { url: key, title: '', summary: '', highlights: [{ id: 'h1', text: '春天的花园里开满了黄色的花', prefix: '', suffix: '', comment: '', draft: null, createdAt: 1, pos: 1, anchored: true }] } });
    }, docUrl);
    await expect(page.locator('.whn-hl')).toHaveCount(1);
    const tabId = await page.evaluate(() => document.documentElement.dataset.whnTab);
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?${new URLSearchParams({ tabId, url: docUrl, title: 'x' })}`);
    await expect(panel.locator('#title')).toHaveText('未打开页面');
    await expect(panel.locator('#counts')).toHaveText('0 条划线 · 0 条评论');
  } finally {
    await context.close();
    for (const dir of [extDir, docDir, userDataDir]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
