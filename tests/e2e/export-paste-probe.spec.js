// One bounded probe. Real side panel click uses native writeText.
// A separate http page then receives one real Ctrl+V. The fact is the
// textarea's DOM value. No readText, no writeText stub, no fill, no
// synthetic paste payload.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from '../fixtures/server.js';
import { chromeLocaleEnv } from './native.js';
import { pageKey } from '../../src/lib/url.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = process.env.WHN_PASTE_OUT || path.join(root, 'test-results', 'export-paste-probe');

const labels = { source: '来源：', summary: '摘要', highlights: '划线', comment: '评论：' };

function writeReport(report) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'probe.json'), `${JSON.stringify(report, null, 2)}\n`);
}

function expectedMarkdown({ title, url, date, summary, highlight, comment }) {
  return `# ${title}\n${labels.source}${url} · ${date}\n## ${labels.summary}\n${summary}\n## ${labels.highlights}\n> ${highlight}\n${labels.comment}${comment}\n`;
}

async function permissionState(page, name) {
  return page.evaluate(async (permissionName) => {
    try {
      const status = await Promise.race([
        navigator.permissions.query({ name: permissionName }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('permission query timeout')), 2000)),
      ]);
      return status.state;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, name);
}

async function focusSnapshot(page) {
  return page.evaluate(() => ({
    origin: location.origin,
    href: location.href,
    hasFocus: document.hasFocus(),
    visibility: document.visibilityState,
    activeTag: document.activeElement?.tagName || '',
    activeId: document.activeElement?.id || '',
  }));
}

test('narrow probe: native sidepanel copy then one Ctrl+V', async () => {
  test.setTimeout(45000);
  const report = {
    head: '3531b70879640a4497b9ad0655ddc8c1d7938e17',
    base: '9f9b53713896fdaf5109e4cc689af14535ecebd9',
    readTextCalled: false,
    writeStubbed: false,
  };
  let fixture;
  let context;
  try {
    fixture = await startFixtureServer();
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whn-paste-probe-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: { width: 800, height: 720 },
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
    let [background] = context.serviceWorkers();
    if (!background) background = await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(background.url()).host;
    report.extensionOrigin = `chrome-extension://${extensionId}`;
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: report.extensionOrigin,
      });
      report.grantExtension = 'granted';
    } catch (error) {
      report.grantExtension = error instanceof Error ? error.message : String(error);
    }

    const pageUrl = `${fixture.url}?case=paste-probe`;
    const body = {
      title: 'Paste page',
      summary: 'Seed summary',
      highlights: [{ id: 'h1', text: 'Alpha line', comment: 'Beta note', pos: 1, createdAt: 1 }],
    };
    const key = pageKey(pageUrl);
    await background.evaluate(async ({ key, record }) => {
      await chrome.storage.local.set({ [key]: record });
    }, { key, record: { ...body, url: key } });

    const panel = await context.newPage();
    await panel.setViewportSize({ width: 420, height: 720 });
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?${new URLSearchParams({ url: pageUrl, title: body.title })}`);
    const script = await panel.evaluate(() => document.querySelector('script[type="module"]')?.src || '');
    expect(script).toBe(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.js`);
    await expect(panel.locator('#title')).toHaveText(body.title);
    await expect(panel.locator('.quote')).toHaveText('Alpha line');
    await panel.evaluate(() => {
      window.__whnExecCopy = 0;
      window.__whnWriteRef = navigator.clipboard.writeText;
      window.__whnClicks = [];
      document.getElementById('export').addEventListener('click', (event) => {
        window.__whnClicks.push({ type: event.type, isTrusted: event.isTrusted });
      });
      const original = document.execCommand.bind(document);
      document.execCommand = (command, ...args) => {
        if (String(command).toLowerCase() === 'copy') window.__whnExecCopy += 1;
        return original(command, ...args);
      };
    });
    report.panelBefore = await focusSnapshot(panel);
    report.panelPermissions = {
      write: await permissionState(panel, 'clipboard-write'),
      read: await permissionState(panel, 'clipboard-read'),
    };
    const date = await panel.evaluate(() => {
      const now = new Date();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      return `${now.getFullYear()}-${month}-${day}`;
    });
    const expected = expectedMarkdown({
      title: body.title,
      url: key,
      date,
      summary: body.summary,
      highlight: 'Alpha line',
      comment: 'Beta note',
    });
    report.expected = expected;
    await panel.bringToFront();
    await panel.locator('#export').click({ timeout: 8000 });
    await expect(panel.locator('#export')).toHaveText('已复制 ✓');
    report.afterCopy = await panel.evaluate(() => ({
      button: document.getElementById('export').textContent,
      execCopy: window.__whnExecCopy || 0,
      writeStillNative: navigator.clipboard.writeText === window.__whnWriteRef,
      clicks: window.__whnClicks || [],
    }));
    fs.mkdirSync(outDir, { recursive: true });
    await panel.screenshot({ path: path.join(outDir, 'panel-after-copy.png') });

    const editor = await context.newPage();
    await editor.setViewportSize({ width: 800, height: 500 });
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
    report.editorOrigin = new URL(editor.url()).origin;
    report.editorPermissions = {
      write: await permissionState(editor, 'clipboard-write'),
      read: await permissionState(editor, 'clipboard-read'),
    };
    const target = editor.locator('#paste-target');
    await expect(target).toHaveValue('');
    await editor.bringToFront();
    await target.click({ timeout: 8000 });
    report.editorFocused = await focusSnapshot(editor);
    await editor.keyboard.press('Control+V');
    await editor.waitForTimeout(1000);
    report.editorAfterPaste = await focusSnapshot(editor);
    report.pasteEvents = await editor.evaluate(() => window.__whnPasteEvents || []);
    report.pasted = await target.inputValue();
    report.match = report.pasted === expected;
    await editor.screenshot({ path: path.join(outDir, 'editor-after-paste.png') });
    writeReport(report);
    expect(report.afterCopy.writeStillNative).toBe(true);
    expect(report.afterCopy.execCopy).toBe(0);
    expect(report.afterCopy.clicks).toEqual([{ type: 'click', isTrusted: true }]);
    expect(report.pasted).toBe(expected);
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    writeReport(report);
    throw error;
  } finally {
    await context?.close();
    await fixture?.close();
  }
});
