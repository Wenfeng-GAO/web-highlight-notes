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
