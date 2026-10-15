import { downloadFilename, formatDate, toMarkdown } from '../lib/export.js';
import { commentCount, emptyRecord, sortHighlights, toStoredRecord } from '../lib/model.js';
import { pageKey } from '../lib/url.js';

const summaryEl = document.querySelector('#summary');
const titleEl = document.querySelector('#title');
const countsEl = document.querySelector('#counts');
const exportBtn = document.querySelector('#export');
const listEl = document.querySelector('#list');

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

  return { tabId: Number.isFinite(id) ? id : null, url, tabTitle: title };
}

function renderList() {
  listEl.replaceChildren();
  const items = sortHighlights(record?.highlights || []);
  if (!items.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '选中文字即可划线';
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
      warn.textContent = '⚠ 未定位';
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

function isEditingSummary() {
  return document.activeElement === summaryEl;
}

function isWebUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function render({ urlChanged = false } = {}) {
  const title = record?.title || tabTitle || '未命名页面';
  titleEl.textContent = title;
  const highlights = record?.highlights || [];
  countsEl.textContent = `${highlights.length} 条划线 · ${commentCount(highlights)} 条评论`;
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
  exportBtn.textContent = '已复制 ✓';
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    exportBtn.textContent = '导出 MD';
  }, 1500);
}

async function onExport() {
  if (!record) return;
  await flushSummarySave();
  if (!record.title) record.title = tabTitle || '未命名页面';
  await persist();
  const markdown = toMarkdown({
    title: record.title,
    url: record.url,
    date: formatDate(new Date()),
    summary: record.summary || '',
    highlights: sortHighlights(record.highlights || []),
  });
  await copyText(markdown);
  downloadMarkdown(downloadFilename(record.title), markdown);
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
  const url = tab?.url || '';
  if (!isWebUrl(url)) return;
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

function showEmpty() {
  record = null;
  storageKey = '';
  tabId = null;
  titleEl.textContent = '未打开页面';
  countsEl.textContent = '0 条划线 · 0 条评论';
  if (!isEditingSummary() && summaryEl.value) summaryEl.value = '';
  listEl.replaceChildren();
  const empty = document.createElement('li');
  empty.className = 'empty';
  empty.textContent = '选中文字即可划线';
  listEl.appendChild(empty);
}

function bindPanelEvents() {
  bindTabEvents();
  chrome.storage.onChanged.addListener((changes, area) => {
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
  if (context.url && isWebUrl(context.url)) {
    await enqueueShow(() => showTab({
      id: context.tabId,
      url: context.url,
      title: context.tabTitle,
    }));
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
  titleEl.textContent = '加载失败';
});
