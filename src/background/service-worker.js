import { isPromptHost } from '../lib/prompt-host.js';
import { isFileUrl, isSitePattern, isSupportedUrl, isUnsupportedPageError, isWebUrl, originPattern } from '../lib/url.js';

// Sites the user granted (or that kept a grant from 0.1.3) get a persistent
// content script, so highlights restore on load with no click. Other sites run
// only after a toolbar click (activeTab).
const SCRIPT_ID = 'whn-auto';
const DECLINED_KEY = '__whn:declined';
const CTX_PREFIX = '__whn:ctx:';
const CTX_TTL_MS = 10 * 60 * 1000;
const CONTENT_JS = 'src/content/boot.js';
const CONTENT_CSS = 'src/content/highlight.css';

function setPanelBehavior() {
  // 0.1.3 set openPanelOnActionClick: true, which Chrome keeps across updates and
  // which suppresses action.onClicked. Turn it off so the click can inject too.
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
}

async function injectTab(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: [CONTENT_CSS] });
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_JS] });
    return true;
  } catch {
    // No access (chrome:// pages, the store, a revoked grant).
    return false;
  }
}

async function hasSite(pattern) {
  if (!pattern) return false;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

/** Sites that should auto-inject: specific grants plus sites with notes that are covered by any grant. */
async function autoSites() {
  const candidates = new Set();
  const { origins = [] } = await chrome.permissions.getAll();
  for (const origin of origins) if (isSitePattern(origin)) candidates.add(origin);
  const stored = await chrome.storage.local.get(null);
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith('__whn:')) continue;
    if (!value?.highlights?.length && !value?.summary) continue;
    const pattern = originPattern(key);
    if (pattern) candidates.add(pattern);
  }
  const sites = [];
  for (const pattern of candidates) if (await hasSite(pattern)) sites.push(pattern);
  return sites.sort();
}

let syncChain = Promise.resolve();
function syncAutoScripts() {
  syncChain = syncChain.then(async () => {
    const matches = await autoSites();
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    if (!matches.length) {
      if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      return matches;
    }
    const script = {
      id: SCRIPT_ID,
      matches,
      js: [CONTENT_JS],
      css: [CONTENT_CSS],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    };
    if (existing.length) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
    return matches;
  }).catch((error) => {
    console.error('web-highlight-notes sync failed', error);
    return [];
  });
  return syncChain;
}

async function clearDeclined(origins) {
  const stored = await chrome.storage.local.get(DECLINED_KEY);
  const declined = { ...(stored[DECLINED_KEY] || {}) };
  let changed = false;
  for (const origin of origins) {
    if (declined[origin]) {
      delete declined[origin];
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [DECLINED_KEY]: declined });
}

async function siteStatus(url) {
  const pattern = originPattern(url);
  // Local files come with the install (file:///*, gated by "Allow access to file URLs"): never ask.
  if (isFileUrl(url)) return { pattern, granted: true, declined: false };
  const stored = await chrome.storage.local.get(DECLINED_KEY);
  return {
    pattern,
    granted: await hasSite(pattern),
    declined: !!(pattern && stored[DECLINED_KEY]?.[pattern]),
  };
}

setPanelBehavior();
// Also on every worker start: onInstalled/onStartup are not guaranteed to reach
// us (an unpacked reload delivered neither in testing), and the sync is idempotent.
syncAutoScripts();
chrome.runtime.onInstalled.addListener(() => {
  setPanelBehavior();
  syncAutoScripts();
});
chrome.runtime.onStartup.addListener(() => {
  setPanelBehavior();
  syncAutoScripts();
});

// Per-tab note for the side panel: the click landed on a page we could not read.
const TAB_STATE_PREFIX = 'whn:tab:';

/**
 * Without the tabs permission an unreadable tab has no url. A click grants activeTab on
 * web pages, so a tab still unreadable after a click is one of:
 *  - chrome://, the new tab page, the Web Store: Chrome's error names them -> unsupported;
 *  - a local file while "Allow access to file URLs" is off -> the panel's file-access card;
 *  - about:blank, data:, blob:. With file access off these look exactly like a local file
 *    (same hidden url, same generic error), so they get the same card; its copy covers both (#11).
 */
async function noteUnreadableTab(tabId) {
  let href = '';
  let message = '';
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: () => location.href });
    href = result?.result || '';
  } catch (error) {
    message = String(error?.message || error);
  }
  // A blob: page made by a local file can be scripted, but its URL dies with the page.
  if (isSupportedUrl(href)) {
    injectTab(tabId);
    return;
  }
  let state = 'unsupported';
  if (!href && !isUnsupportedPageError(message) && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    state = 'file-access-off';
  }
  await chrome.storage.session.set({ [`${TAB_STATE_PREFIX}${tabId}`]: state });
}

chrome.action.onClicked.addListener((tab) => {
  // sidePanel.open must run inside the click gesture, before any await.
  if (tab?.id == null) return;
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  if (isSupportedUrl(tab.url)) injectTab(tab.id);
  else if (tab.url) {
    // about:blank, data:, blob: and the like: tell the panel a click will not help.
    chrome.storage.session.set({ [`${TAB_STATE_PREFIX}${tab.id}`]: 'unsupported' }).catch(() => {});
  } else noteUnreadableTab(tab.id);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A new document may be a different page; forget what the last click learned.
  if (changeInfo.status === 'loading') chrome.storage.session.remove(`${TAB_STATE_PREFIX}${tabId}`).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`${TAB_STATE_PREFIX}${tabId}`).catch(() => {});
});

chrome.permissions.onAdded.addListener(async ({ origins = [] }) => {
  await clearDeclined(origins);
  await syncAutoScripts();
  // Show notes in open tabs of the new site right away.
  const tabs = origins.length ? await chrome.tabs.query({ url: origins }).catch(() => []) : [];
  for (const tab of tabs) injectTab(tab.id);
});
chrome.permissions.onRemoved.addListener(() => syncAutoScripts());

function promptPage(url) {
  try {
    const parsed = new URL(url);
    const expected = new URL(chrome.runtime.getURL('src/prompt/prompt.html'));
    return parsed.origin === expected.origin && parsed.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function newCtx() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// The token is bound to the tab the content script ran in and to the host of
// that frame. The prompt iframe's own URL is an extension URL, so it is never
// used as the page origin.
async function readPromptCtx(ctx, sender) {
  if (!/^[a-f0-9]{32}$/.test(String(ctx || ''))) return null;
  if (!promptPage(sender?.url || '')) return null;
  const key = `${CTX_PREFIX}${ctx}`;
  const stored = await chrome.storage.session.get(key);
  const rec = stored[key];
  if (!rec || typeof rec.tabId !== 'number' || sender.tab?.id !== rec.tabId) return null;
  if (!isPromptHost(rec.pattern) || rec.exp < Date.now()) {
    await chrome.storage.session.remove(key);
    return null;
  }
  return { key, rec };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'whn:hello') {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return false;
  }
  if (message?.type === 'whn:prompt-open') {
    (async () => {
      const pageUrl = sender.url || '';
      const pattern = originPattern(pageUrl);
      if (!isWebUrl(pageUrl) || typeof sender.tab?.id !== 'number' || !isPromptHost(pattern)) {
        sendResponse({ ok: false });
        return;
      }
      const ctx = newCtx();
      await chrome.storage.session.set({
        [`${CTX_PREFIX}${ctx}`]: { pattern, tabId: sender.tab.id, exp: Date.now() + CTX_TTL_MS },
      });
      sendResponse({ ok: true, ctx });
    })();
    return true;
  }
  if (message?.type === 'whn:prompt-bind') {
    (async () => {
      const found = await readPromptCtx(message.ctx, sender);
      sendResponse(found ? { ok: true, pattern: found.rec.pattern } : { ok: false });
    })();
    return true;
  }
  if (message?.type === 'whn:prompt-decline') {
    (async () => {
      const found = await readPromptCtx(message.ctx, sender);
      if (!found) {
        sendResponse({ ok: false });
        return;
      }
      const stored = await chrome.storage.local.get(DECLINED_KEY);
      const declined = { ...(stored[DECLINED_KEY] || {}), [found.rec.pattern]: Date.now() };
      await chrome.storage.local.set({ [DECLINED_KEY]: declined });
      await chrome.storage.session.remove(found.key);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message?.type === 'whn:prompt-finish') {
    (async () => {
      const found = await readPromptCtx(message.ctx, sender);
      if (found) await chrome.storage.session.remove(found.key);
      sendResponse({ ok: !!found });
    })();
    return true;
  }
  if (message?.type === 'whn:site') {
    // A content script saved notes. Report the site's grant state and register
    // the site if a grant already covers it (for example one kept from 0.1.3).
    (async () => {
      const status = await siteStatus(sender.url || sender.tab?.url || '');
      if (status.granted) await syncAutoScripts();
      sendResponse(status);
    })();
    return true;
  }
  if (message?.type === 'whn:sync') {
    syncAutoScripts().then((matches) => sendResponse({ matches }));
    return true;
  }
  return false;
});
