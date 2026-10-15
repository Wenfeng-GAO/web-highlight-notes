// Real OS input for the parts of Chrome that Playwright cannot reach: the
// toolbar action (via its keyboard shortcut, which grants activeTab exactly like
// a click) and the native permission dialog. Needs X11 (xvfb) and xdotool.
import { execFileSync } from 'node:child_process';

export const ACTION_SHORTCUT = 'alt+shift+h';

function xdotool(...args) {
  execFileSync('xdotool', args, { stdio: 'pipe' });
}

/** Press the extension's _execute_action shortcut on the page's window. */
export async function clickActionIcon(page) {
  await page.bringToFront();
  await page.waitForTimeout(200);
  xdotool('key', '--clearmodifiers', ACTION_SHORTCUT);
  await page.waitForTimeout(400);
}

/**
 * Answer the native "has requested additional permissions" dialog.
 * Its focused default button is Deny; Tab moves to Allow.
 */
export async function answerPermissionDialog(page, allow) {
  await page.waitForTimeout(800);
  if (allow) xdotool('key', 'Tab', 'Return');
  else xdotool('key', 'Return');
  await page.waitForTimeout(400);
}

/** Chrome on Linux takes its UI (and chrome.i18n) language from LANGUAGE, not only --lang. */
export function chromeLocaleEnv(locale = 'zh_CN') {
  return { ...process.env, LANGUAGE: locale, LANG: `${locale}.UTF-8` };
}

/**
 * Turn "Allow access to file URLs" on or off for an unpacked extension, the way
 * the chrome://extensions toggle does. Playwright's --load-extension starts with
 * it ON. Toggling reloads the extension; with --load-extension Chrome leaves it
 * disabled after that reload, so enable it again. Returns the new service worker.
 */
export async function setFileAccess(context, extensionId, on) {
  // Like a user flipping "Allow access to file URLs" on chrome://extensions. Developer
  // mode must be on first: without it the toggle leaves the extension disabled, and
  // re-enabling it by hand gives a state real installs never reach (file:// tab URLs
  // stay readable with file access off), which once hid a 0.1.5 bug (#11).
  const page = await context.newPage();
  await page.goto(`chrome://extensions/?id=${extensionId}`);
  await page.evaluate(() => new Promise((resolve) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, resolve)));
  const nextWorker = context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  await page.evaluate(([id, allow]) => new Promise((resolve, reject) => {
    chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, fileAccess: allow }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  }), [extensionId, on]);
  const info = await page.evaluate(async (id) => {
    const get = () => new Promise((resolve) => chrome.developerPrivate.getExtensionInfo(id, resolve));
    for (let i = 0; i < 30; i += 1) {
      const current = await get();
      if (current.state === 'ENABLED') return current;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return get();
  }, extensionId);
  await page.close();
  if (info.state !== 'ENABLED' || info.fileAccess.isActive !== on) throw new Error(`file access toggle failed: ${JSON.stringify({ state: info.state, fileAccess: info.fileAccess })}`);
  const worker = await nextWorker;
  return worker || context.serviceWorkers().find((w) => w.url().includes(extensionId));
}
