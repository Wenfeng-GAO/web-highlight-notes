import { downloadFilename, formatDate, toMarkdown } from '../lib/export.js';
import { commentCount, emptyRecord, sortHighlights, toStoredRecord } from '../lib/model.js';
import { t, localize } from '../lib/i18n.js';
import { isFileUrl, isSupportedUrl, isUnsupportedPageError, originPattern, pageKey } from '../lib/url.js';

localize(document);
const DECLINED_KEY = '__whn:declined';

const summaryEl = document.querySelector('#summary');
const titleEl = document.querySelector('#title');
const countsEl = document.querySelector('#counts');
const exportBtn = document.querySelector('#export');
const listEl = document.querySelector('#list');
const statusEl = document.querySelector('#status');
const appEl = document.querySelector('.app');
const noticeEl = document.querySelector('#notice');
const openSettingsEl = document.querySelector('#open-settings');
const TAB_STATE_PREFIX = 'whn:tab:';
let unreadableTabId = null;
const grantEl = document.querySelector('#grant');

const SAVE_DEBOUNCE_MS = 300;

let record = null;
let tabId = null;
let tabTitle = '';
let storageKey = '';
let copiedTimer = 0;
let saveTimer = 0;
let savedSummary = '';
let showGeneration = 0;
let showChain = Promise.resolve();

/** Without the tabs permission tab.url is hidden on sites we cannot access; an injected page can still tell us. */
async function pageInfo(id) {
  try {
    return await chrome.tabs.sendMessage(id, { type: 'whn:info' });
  } catch {
    return null;
  }
}

async function resolveContext() {
  const params = new URLSearchParams(location.search);
  let id = params.get('tabId');
  let url = params.get('url') || '';
  let title = params.get('title') || '';
  if (id) id = Number(id);

  if (chrome.tabs && (!id || !url || !title)) {
    try {
      if (id) {
        const tab = await chrome.tabs.get(id);
        url = url || tab?.url || '';
        title = title || tab?.title || '';
      } else {
        let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || tab.url?.startsWith('chrome')) {
          const [other] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (other) tab = other;
        }
        if (tab) {
          id = tab.id;
          url = url || tab.url || '';
          title = title || tab.title || '';
        }
      }
    } catch {
      // The tab may have closed. The query string can still identify the page.
    }
  }
  if (!url && Number.isFinite(id)) {
    const info = await pageInfo(id);
    url = info?.url || '';
    title = title || info?.title || '';
  }

  return { tabId: Number.isFinite(id) ? id : null, url, tabTitle: title };
}

function renderList() {
  listEl.replaceChildren();
  const items = sortHighlights(record?.highlights || []);
  if (!items.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = t('panelEmpty');
    listEl.appendChild(empty);
    return;
  }
  for (const highlight of items) {
    const item = document.createElement('li');
    item.className = highlight.anchored === false ? 'item unanchored' : 'item';
    item.dataset.id = highlight.id;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');

    if (highlight.anchored === false) {
      const warn = document.createElement('div');
      warn.className = 'warn';
      warn.textContent = t('panelUnanchored');
      item.appendChild(warn);
    }

    const quote = document.createElement('div');
    quote.className = 'quote';
    quote.textContent = highlight.text || '';
    item.appendChild(quote);

    if ((highlight.comment || '').trim()) {
      const comment = document.createElement('div');
      comment.className = 'comment';
      comment.textContent = highlight.comment;
      item.appendChild(comment);
    }
    item.addEventListener('click', () => focusHighlight(highlight.id));
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        focusHighlight(highlight.id);
      }
    });
    listEl.appendChild(item);
  }
}

// chrome.i18n has no plural rules; pick the form here (zh uses one form for both).
function countsText(highlights) {
  const h = highlights.length;
  const c = commentCount(highlights);
  const highlightsText = h === 1 ? t('countHighlightsOne', [String(h)]) : t('countHighlightsOther', [String(h)]);
  const notesText = c === 1 ? t('countNotesOne', [String(c)]) : t('countNotesOther', [String(c)]);
  return `${highlightsText} · ${notesText}`;
}

let statusGeneration = 0;
/**
 * Sites without a host grant keep their notes in storage and list them here,
 * but the page only shows them after a toolbar click. Say so, and offer the grant.
 */
async function updateStatus() {
  const generation = ++statusGeneration;
  const pattern = storageKey ? originPattern(storageKey) : null;
  let show = false;
  // Local files never use the per-site grant; the file-access card covers them.
  if (pattern && !isFileUrl(storageKey)) {
    const [granted, stored] = await Promise.all([
      chrome.permissions.contains({ origins: [pattern] }).catch(() => false),
      chrome.storage.local.get(DECLINED_KEY),
    ]);
    const declined = !!stored[DECLINED_KEY]?.[pattern];
    show = !granted && (declined || (record?.highlights || []).length > 0);
  }
  if (generation !== statusGeneration) return;
  statusEl.hidden = !show;
  document.documentElement.dataset.whnStatus = show ? 'need-click' : 'ok';
}

async function onGrant(event) {
  event.preventDefault();
  const pattern = storageKey ? originPattern(storageKey) : null;
  if (!pattern) return;
  try {
    await chrome.permissions.request({ origins: [pattern] });
  } catch {
    // Dismissed or not allowed for this URL.
  }
  updateStatus();
}

function isEditingSummary() {
  return document.activeElement === summaryEl;
}

function render({ urlChanged = false } = {}) {
  const title = record?.title || tabTitle || t('panelUntitled');
  titleEl.textContent = title;
  const highlights = record?.highlights || [];
  countsEl.textContent = countsText(highlights);
  updateStatus();
  const nextSummary = record?.summary || '';
  const focused = isEditingSummary();
  // Keep the same textarea node while it is focused. Assign value only when the
  // page changed, or when the field is idle and storage actually differs.
  if (urlChanged || (!focused && summaryEl.value !== nextSummary)) {
    summaryEl.value = nextSummary;
  }
  renderList();
}

async function persist() {
  if (!record?.url) return;
  const key = record.url;
  const payload = toStoredRecord(record);
  await chrome.storage.local.set({ [key]: payload });
}

function syncSummaryFromDom() {
  if (!record) return;
  record.summary = summaryEl.value;
}

async function flushSummarySave() {
  if (!record?.url) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  syncSummaryFromDom();
  const next = record.summary || '';
  if (next === savedSummary) return;
  savedSummary = next;
  const key = record.url;
  const payload = toStoredRecord(record);
  await chrome.storage.local.set({ [key]: payload });
}

function scheduleSummarySave() {
  if (!record) return;
  syncSummaryFromDom();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = 0;
    flushSummarySave();
  }, SAVE_DEBOUNCE_MS);
}

async function focusHighlight(id) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'whn:scroll', id });
  } catch {
    // The content script is not on this tab.
  }
}

function fallbackCopy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

async function copyText(text) {
  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 800)),
    ]);
    return true;
  } catch {
    return fallbackCopy(text);
  }
}

function downloadMarkdown(filename, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function showCopied() {
  exportBtn.textContent = t('panelCopied');
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    exportBtn.textContent = t('panelExport');
  }, 1500);
}

async function onExport() {
  if (!record) return;
  await flushSummarySave();
  if (!record.title) record.title = tabTitle || t('panelUntitled');
  await persist();
  const markdown = toMarkdown({
    labels: {
      source: t('exportSource'),
      summary: t('exportSummary'),
      highlights: t('exportHighlights'),
      comment: t('exportComment'),
    },
    title: record.title,
    url: record.url,
    date: formatDate(new Date()),
    summary: record.summary || '',
    highlights: sortHighlights(record.highlights || []),
  });
  await copyText(markdown);
  downloadMarkdown(downloadFilename(record.title, t('exportDefaultName')), markdown);
  showCopied();
}

function applyStorageRecord(next, { urlChanged = false } = {}) {
  const pageChanged = urlChanged || !record?.url || record.url !== storageKey;
  const keepLocalSummary = isEditingSummary() && !pageChanged;
  const localSummary = summaryEl.value;
  const storedSummary = next?.summary || '';
  record = next
    ? { ...emptyRecord(storageKey), ...next, url: storageKey }
    : emptyRecord(storageKey);
  if (!record.title) record.title = tabTitle;
  if (keepLocalSummary) {
    // The open textarea is the source of truth. A highlight save or our own
    // storage echo must not replace it, but a stale stored summary has to be
    // written back or the latest keystrokes never land.
    record.summary = localSummary;
    render({ urlChanged: false });
    if (storedSummary !== localSummary) {
      savedSummary = storedSummary;
      scheduleSummarySave();
    } else {
      savedSummary = localSummary;
    }
    return;
  }
  savedSummary = record.summary || '';
  render({ urlChanged: pageChanged });
}

function enqueueShow(task) {
  const run = showChain.then(task);
  showChain = run.then(() => undefined, (error) => {
    console.error(error);
  });
  return run;
}

async function currentWindowId() {
  const current = await chrome.windows.getCurrent();
  return current?.id ?? null;
}

async function showTab(tab) {
  let url = tab?.url || '';
  if (Number.isFinite(tab?.id)) {
    // Ask the page first: it knows its URL even when tab.url is hidden, and its key
    // is the one it saves under (tab.url moves on with history.pushState, the page does not).
    const info = await pageInfo(tab.id);
    if (info?.unsupported) {
      showUnsupported(tab.id);
      return;
    }
    if (info?.url) {
      tab = { ...tab, url: info.url, title: tab.title || info.title };
      url = info.url;
    }
    if (!url) {
      await showUnreadable(tab.id);
      return;
    }
  }
  // Our own pages (only seen when the panel is opened as a tab) keep the current view.
  if (url.startsWith(chrome.runtime.getURL(''))) return;
  if (!isSupportedUrl(url)) {
    showUnsupported(tab?.id);
    return;
  }
  unreadableTabId = null;
  setMode('page');
  if (isFileUrl(url)) {
    // A click still works on a local file, but nothing restores on reload until file access is on.
    noticeEl.hidden = await chrome.extension.isAllowedFileSchemeAccess();
  }
  const nextKey = pageKey(url);
  const nextId = Number.isFinite(tab.id) ? tab.id : null;
  const nextTitle = tab.title || '';
  const urlChanged = !record?.url || record.url !== nextKey;

  if (urlChanged) {
    clearTimeout(saveTimer);
    saveTimer = 0;
    await flushSummarySave();
    clearTimeout(saveTimer);
    saveTimer = 0;
  }

  const generation = ++showGeneration;
  tabId = nextId;
  tabTitle = nextTitle;
  storageKey = nextKey;
  const stored = await chrome.storage.local.get(storageKey);
  if (generation !== showGeneration) return;

  const next = stored[storageKey]
    ? { ...emptyRecord(storageKey), ...stored[storageKey], url: storageKey }
    : emptyRecord(storageKey);
  if (!next.title) next.title = tabTitle;
  applyStorageRecord(next, { urlChanged });
}

function bindTabEvents() {
  if (!chrome.tabs?.onActivated || !chrome.tabs?.onUpdated || !chrome.windows?.getCurrent) return;

  chrome.tabs.onActivated.addListener((info) => {
    enqueueShow(async () => {
      const windowId = await currentWindowId();
      if (windowId != null && info.windowId !== windowId) return;
      const tab = await chrome.tabs.get(info.tabId);
      await showTab(tab);
    });
  });

  chrome.tabs.onUpdated.addListener((updatedId, changeInfo, tab) => {
    if (!changeInfo.url && changeInfo.status !== 'complete') return;
    enqueueShow(async () => {
      const windowId = await currentWindowId();
      if (windowId != null && tab.windowId !== windowId) return;
      const [active] = await chrome.tabs.query({ active: true, windowId: windowId ?? tab.windowId });
      if (!active || active.id !== updatedId) return;
      await showTab({
        id: active.id,
        url: changeInfo.url || active.url || tab.url || '',
        title: active.title || tab.title || '',
      });
    });
  });
}

function showEmpty(message = t('panelEmpty'), title = t('panelNoPage'), mode = 'page') {
  setMode(mode);
  record = null;
  storageKey = '';
  tabId = null;
  titleEl.textContent = title;
  countsEl.textContent = countsText([]);
  if (!isEditingSummary() && summaryEl.value) summaryEl.value = '';
  listEl.replaceChildren();
  const empty = document.createElement('li');
  empty.className = 'empty';
  empty.textContent = message;
  listEl.appendChild(empty);
  updateStatus();
}

function setMode(mode) {
  appEl.dataset.mode = mode;
  noticeEl.hidden = true;
}

function leavePage(id) {
  clearTimeout(saveTimer);
  saveTimer = 0;
  flushSummarySave();
  showGeneration += 1;
  unreadableTabId = Number.isFinite(id) ? id : null;
}

/** chrome://, the new tab page, the Web Store and other pages extensions may not touch. */
function showUnsupported(id) {
  leavePage(id);
  showEmpty(t('panelUnsupported'), '', 'unsupported');
  tabId = unreadableTabId;
}

/**
 * A tab whose URL we may not read. Chrome's error names chrome:// pages and the Web
 * Store; the worker notes tabs a click could not open (about:blank, data:, blob:);
 * anything else is a web page that just needs a toolbar click.
 */
async function classifyUnreadable(id) {
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => location.href });
    return isSupportedUrl(result?.result) ? 'click' : 'unsupported';
  } catch (error) {
    if (isUnsupportedPageError(error?.message || error)) return 'unsupported';
  }
  const key = `${TAB_STATE_PREFIX}${id}`;
  const stored = await chrome.storage.session.get(key).catch(() => ({}));
  return stored[key] === 'unsupported' ? 'unsupported' : 'click';
}

async function showUnreadable(id) {
  if (await classifyUnreadable(id) === 'unsupported') {
    showUnsupported(id);
    return;
  }
  leavePage(id);
  showEmpty(t('panelClickToUse'), t('panelUntitled'));
  tabId = unreadableTabId;
}

function openExtensionSettings() {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
}

function bindPanelEvents() {
  bindTabEvents();
  chrome.permissions?.onAdded?.addListener(() => updateStatus());
  chrome.permissions?.onRemoved?.addListener(() => updateStatus());
  grantEl.addEventListener('click', onGrant);
  openSettingsEl.addEventListener('click', openExtensionSettings);
  chrome.runtime.onMessage.addListener((message, sender) => {
    // The page moved to a new URL without reloading (single-page sites); follow its key.
    if (message?.type !== 'whn:navigated' || sender.tab?.id == null || sender.tab.id !== tabId) return;
    enqueueShow(() => showTab({ id: sender.tab.id }));
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    // The worker learned why the current unreadable tab is unreadable (after a click).
    if (area === 'session' && unreadableTabId != null && changes[`${TAB_STATE_PREFIX}${unreadableTabId}`]) {
      const id = unreadableTabId;
      enqueueShow(() => showTab({ id }));
      return;
    }
    if (area === 'local' && changes[DECLINED_KEY]) updateStatus();
    if (area !== 'local' || !storageKey || !changes[storageKey]) return;
    // Drop an in-flight tab read so it cannot paint a record older than this write.
    showGeneration += 1;
    applyStorageRecord(changes[storageKey].newValue);
  });
  summaryEl.addEventListener('input', scheduleSummarySave);
  summaryEl.addEventListener('blur', () => {
    flushSummarySave();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSummarySave();
  });
  window.addEventListener('pagehide', () => {
    flushSummarySave();
  });
  exportBtn.addEventListener('click', () => {
    onExport();
  });
}

async function main() {
  bindPanelEvents();
  const context = await resolveContext();
  if (context.url && isSupportedUrl(context.url)) {
    await enqueueShow(() => showTab({
      id: context.tabId,
      url: context.url,
      title: context.tabTitle,
    }));
    return;
  }
  if (Number.isFinite(context.tabId)) {
    await enqueueShow(() => showTab({ id: context.tabId, url: context.url, title: context.tabTitle }));
    return;
  }
  showEmpty();
  if (!chrome.tabs?.query || !chrome.windows?.getCurrent) return;
  await enqueueShow(async () => {
    const windowId = await currentWindowId();
    if (windowId == null) return;
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (active) await showTab(active);
  });
}

main().catch((error) => {
  console.error(error);
  titleEl.textContent = t('panelLoadFailed');
});
