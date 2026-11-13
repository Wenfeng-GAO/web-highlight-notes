// Production side panel only: chrome-extension://<id>/src/sidepanel/sidepanel.html.
// Storage rejection is injected on that live page. This does not copy flushSummarySave.
// The page is a local fixture, not a live host.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageKey } from '../../src/lib/url.js';
import { startFixtureServer } from '../fixtures/server.js';
import { chromeLocaleEnv } from './native.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shotDir = process.env.WHN_SUMMARY_SHOTS || '/opt/cursor/artifacts/summary-save';

const SAME = '草稿还在';
const OLDER = '旧草稿';
const NEWER = '新草稿';

async function shot(panel, name) {
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

async function installStorage(panel) {
  await panel.evaluate(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    const state = { mode: 'reject', calls: [], hold: null };
    window.__summarySave = state;
    chrome.storage.local.set = (items) => {
      state.calls.push(JSON.parse(JSON.stringify(items)));
      if (state.mode === 'hold') {
        return new Promise((resolve, reject) => {
          state.hold = { resolve: () => resolve(original(items)), reject };
        });
      }
      if (state.mode === 'reject') return Promise.reject(new Error('quota'));
      return original(items);
    };
  });
}

async function storageMode(panel, mode) {
  await panel.evaluate((next) => {
    window.__summarySave.mode = next;
  }, mode);
}

async function callCount(panel) {
  return panel.evaluate(() => window.__summarySave.calls.length);
}

test('rejected summary save keeps the draft and a later retry writes it', async () => {
  const fixture = await startFixtureServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-summary-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 400, height: 720 },
    env: chromeLocaleEnv('zh_CN'),
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      '--no-first-run',
      '--disable-default-apps',
      '--lang=zh-CN',
    ],
  });
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).host;
    const pageUrl = `${fixture.url}?case=summary-retry`;
    const storage = pageKey(pageUrl);
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 400, height: 720 });
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?${new URLSearchParams({ url: pageUrl, title: 'Summary page' })}`);
    const script = await panel.evaluate(() => document.querySelector('script[type="module"]')?.src || '');
    expect(script).toBe(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.js`);
    await expect(panel.locator('#title')).toHaveText('Summary page');
    await installStorage(panel);
    const summary = panel.locator('#summary');
    await summary.fill(SAME);
    await panel.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect.poll(() => callCount(panel)).toBe(1);
    await expect(summary).toHaveValue(SAME);
    await shot(panel, 'zh-reject-text-remains');

    await storageMode(panel, 'allow');
    await summary.blur();
    const deadline = Date.now() + 2500;
    let stored = null;
    while (Date.now() < deadline) {
      stored = await worker.evaluate(async (key) => {
        const found = await chrome.storage.local.get(key);
        return found[key]?.summary ?? null;
      }, storage);
      if (stored === SAME) break;
      await panel.waitForTimeout(100);
    }
    await panel.reload();
    await expect(panel.locator('#title')).toHaveText('Summary page');
    await shot(panel, 'zh-retry-reload');
    expect(stored).toBe(SAME);
    await expect(panel.locator('#summary')).toHaveValue(SAME);
  } finally {
    await context.close();
    await fixture.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('an older save cannot mark newer summary text as already saved', async () => {
  const fixture = await startFixtureServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-summary-edit-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 400, height: 720 },
    env: chromeLocaleEnv('zh_CN'),
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      '--no-first-run',
      '--disable-default-apps',
      '--lang=zh-CN',
    ],
  });
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).host;
    const pageUrl = `${fixture.url}?case=summary-edit`;
    const storage = pageKey(pageUrl);
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 400, height: 720 });
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?${new URLSearchParams({ url: pageUrl, title: 'Summary page' })}`);
    await expect(panel.locator('#title')).toHaveText('Summary page');
    await installStorage(panel);
    await storageMode(panel, 'hold');
    const summary = panel.locator('#summary');
    await summary.fill(OLDER);
    await summary.blur();
    await expect.poll(() => callCount(panel)).toBe(1);

    await summary.click();
    await storageMode(panel, 'reject');
    await panel.evaluate((value) => {
      const field = document.querySelector('#summary');
      field.focus();
      field.value = value;
    }, NEWER);
    await panel.evaluate(() => window.__summarySave.hold.resolve());
    await expect(summary).toHaveValue(NEWER);
    await shot(panel, 'zh-editing-during-save');

    await panel.waitForTimeout(400);
    await storageMode(panel, 'allow');
    await summary.blur();
    const deadline = Date.now() + 2500;
    let stored = null;
    while (Date.now() < deadline) {
      stored = await worker.evaluate(async (key) => {
        const found = await chrome.storage.local.get(key);
        return found[key]?.summary ?? null;
      }, storage);
      if (stored === NEWER) break;
      await panel.waitForTimeout(100);
    }
    await panel.reload();
    await expect(panel.locator('#title')).toHaveText('Summary page');
    await shot(panel, 'zh-editing-retry-reload');
    expect(stored).toBe(NEWER);
    await expect(panel.locator('#summary')).toHaveValue(NEWER);
  } finally {
    await context.close();
    await fixture.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
