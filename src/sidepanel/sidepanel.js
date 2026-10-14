import { downloadFilename, formatDate, toMarkdown } from '../lib/export.js';
import { commentCount, emptyRecord, sortHighlights, toStoredRecord } from '../lib/model.js';
import { pageKey } from '../lib/url.js';

const summaryEl = document.querySelector('#summary');
const titleEl = document.querySelector('#title');
const countsEl = document.querySelector('#counts');
const exportBtn = document.querySelector('#export');
const listEl = document.querySelector('#list');

let record = null;
let tabId = null;
let tabTitle = '';
let storageKey = '';
let copiedTimer = 0;

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

function render() {
  const title = record?.title || tabTitle || '未命名页面';
  titleEl.textContent = title;
  const highlights = record?.highlights || [];
  countsEl.textContent = `${highlights.length} 条划线 · ${commentCount(highlights)} 条评论`;
  if (document.activeElement !== summaryEl) summaryEl.value = record?.summary || '';
  renderList();
}

async function persist() {
  if (!record?.url) return;
  await chrome.storage.local.set({ [record.url]: toStoredRecord(record) });
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
  record.summary = summaryEl.value;
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

function onSummaryBlur() {
  if (!record) return;
  if ((record.summary || '') === summaryEl.value) return;
  record.summary = summaryEl.value;
  persist();
}

async function main() {
  const context = await resolveContext();
  tabId = context.tabId;
  tabTitle = context.tabTitle || '';
  if (!context.url) {
    titleEl.textContent = '未打开页面';
    countsEl.textContent = '0 条划线 · 0 条评论';
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '选中文字即可划线';
    listEl.appendChild(empty);
    return;
  }
  storageKey = pageKey(context.url);
  const stored = await chrome.storage.local.get(storageKey);
  record = stored[storageKey]
    ? { ...emptyRecord(storageKey), ...stored[storageKey], url: storageKey }
    : emptyRecord(storageKey);
  if (!record.title) record.title = tabTitle;
  render();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[storageKey]) return;
    const next = changes[storageKey].newValue;
    record = next
      ? { ...emptyRecord(storageKey), ...next, url: storageKey }
      : emptyRecord(storageKey);
    render();
  });

  summaryEl.addEventListener('blur', onSummaryBlur);
  exportBtn.addEventListener('click', () => {
    onExport();
  });
}

main().catch((error) => {
  console.error(error);
  titleEl.textContent = '加载失败';
});
