import { offsetsFromRange } from '../lib/anchor.js';
import { applyHighlights, paintCommentState } from '../lib/apply.js';
import { highlightNodes } from '../lib/highlight-dom.js';
import { emptyRecord, sameRecord, toStoredRecord } from '../lib/model.js';
import { pageKey } from '../lib/url.js';
import { mountOverlay } from './overlay.js';

const pageUrl = pageKey(location.href);
const ui = mountOverlay();

let record = emptyRecord(pageUrl);
let toolbarRange = null;
let pendingQuote = null;
let baseTop = null;
let suppressToolbar = false;
let pointerInUi = false;
let bubbleId = null;

function elementFromNode(node) {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
}

function isEditableNode(node) {
  const element = elementFromNode(node);
  if (!element) return false;
  if (element.closest('input, textarea, select, #whn-root')) return true;
  if (element.isContentEditable) return true;
  return false;
}

function isEditableSelection(selection) {
  return isEditableNode(selection.anchorNode) || isEditableNode(selection.focusNode);
}

function markSaved() {
  document.documentElement.dataset.whnSaved = String(Date.now());
}

async function persist() {
  await chrome.storage.local.set({ [record.url]: toStoredRecord(record) });
  markSaved();
}

function renderFromRecord() {
  record.highlights = applyHighlights(document.body, record.highlights || []);
}

async function reconcile() {
  const before = toStoredRecord(record);
  if (document.title) record.title = document.title;
  renderFromRecord();
  const after = toStoredRecord(record);
  const shouldSave = record.highlights.length > 0 || !!record.summary;
  if (shouldSave && JSON.stringify(before) !== JSON.stringify(after)) await persist();
}

function hideToolbar() {
  ui.hideToolbar();
  toolbarRange = null;
  baseTop = null;
  if (!pointerInUi) pendingQuote = null;
}

function updateToolbarFromSelection() {
  if (ui.bubbleOpen()) return;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !selection.toString().trim()) {
    hideToolbar();
    return;
  }
  if (isEditableSelection(selection)) {
    hideToolbar();
    return;
  }
  if (suppressToolbar) return;
  const range = selection.getRangeAt(0).cloneRange();
  const info = offsetsFromRange(document.body, range);
  if (!info || !info.exact.trim()) {
    hideToolbar();
    return;
  }
  toolbarRange = range;
  pendingQuote = {
    text: info.exact,
    prefix: info.prefix,
    suffix: info.suffix,
    pos: info.start,
  };
  const placed = ui.placeToolbar(range.getBoundingClientRect());
  baseTop = placed.top;
}

function unionRect(nodes) {
  const rects = nodes.map((node) => node.getBoundingClientRect()).filter((rect) => rect.width || rect.height);
  if (!rects.length) return null;
  const top = Math.min(...rects.map((rect) => rect.top));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  const left = Math.min(...rects.map((rect) => rect.left));
  const right = Math.max(...rects.map((rect) => rect.right));
  return { top, bottom, left, right, width: right - left, height: bottom - top };
}

function positionBubble(id) {
  const rect = unionRect(highlightNodes(document.body, id));
  if (!rect) return;
  ui.placeBubble(rect);
}

function openBubble(id) {
  const highlight = record.highlights.find((item) => item.id === id);
  if (!highlight) return;
  bubbleId = id;
  hideToolbar();
  suppressToolbar = true;
  ui.quoteEl.textContent = highlight.text || '';
  ui.textarea.value = highlight.draft != null ? highlight.draft : (highlight.comment || '');
  positionBubble(id);
  ui.textarea.focus();
}

function closeBubble() {
  bubbleId = null;
  ui.hideBubble();
}

async function createHighlight(withComment) {
  const quote = pendingQuote;
  if (!quote?.text?.trim() || !record) return;
  pendingQuote = null;
  const highlight = {
    id: crypto.randomUUID(),
    text: quote.text,
    prefix: quote.prefix,
    suffix: quote.suffix,
    comment: '',
    draft: null,
    createdAt: Date.now(),
    pos: quote.pos,
    anchored: true,
  };
  record.highlights = [...(record.highlights || []), highlight];
  record.title = document.title || record.title;
  hideToolbar();
  window.getSelection()?.removeAllRanges();
  suppressToolbar = true;
  renderFromRecord();
  await persist();
  if (withComment) openBubble(highlight.id);
}

async function saveBubble() {
  const highlight = record.highlights.find((item) => item.id === bubbleId);
  if (!highlight) return;
  highlight.comment = ui.textarea.value;
  highlight.draft = null;
  paintCommentState(document.body, record.highlights);
  await persist();
  closeBubble();
}

async function deleteBubble() {
  const id = bubbleId;
  if (!id) return;
  record.highlights = (record.highlights || []).filter((item) => item.id !== id);
  closeBubble();
  renderFromRecord();
  await persist();
}

function onMouseUp(event) {
  if (event.button != null && event.button !== 0) return;
  if (ui.eventFromHost(event)) return;
  suppressToolbar = false;
  setTimeout(updateToolbarFromSelection, 0);
}

function onKeyUp(event) {
  if (ui.eventFromHost(event)) return;
  if (event.key === 'Shift' || event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
    suppressToolbar = false;
    updateToolbarFromSelection();
  }
}

function closestHighlight(target) {
  const element = elementFromNode(target);
  return element?.closest?.('.whn-hl') || null;
}

function onClick(event) {
  if (ui.eventFromHost(event)) return;
  const highlight = closestHighlight(event.target);
  if (!highlight) return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.toString().trim()) return;
  const id = highlight.dataset.whnId;
  if (!id) return;
  event.preventDefault();
  event.stopPropagation();
  openBubble(id);
}

function onMouseDown(event) {
  if (!ui.bubbleOpen()) return;
  if (ui.eventFromHost(event)) return;
  const highlight = closestHighlight(event.target);
  if (highlight && highlight.dataset.whnId === bubbleId) return;
  closeBubble();
}

function onKeyDown(event) {
  if (event.key !== 'Escape') return;
  if (ui.bubbleOpen()) {
    event.preventDefault();
    event.stopPropagation();
    closeBubble();
    return;
  }
  if (ui.toolbarOpen()) {
    event.preventDefault();
    suppressToolbar = true;
    hideToolbar();
  }
}

function onScroll() {
  if (ui.toolbarOpen() && toolbarRange && baseTop != null) {
    const top = toolbarRange.getBoundingClientRect().top;
    if (Math.abs(top - baseTop) > 40) {
      suppressToolbar = true;
      hideToolbar();
    }
  }
  if (ui.bubbleOpen() && bubbleId) positionBubble(bubbleId);
}

function onStorage(changes, area) {
  if (area !== 'local') return;
  const change = changes[record.url];
  if (!change || !change.newValue) return;
  const next = change.newValue;
  if (sameRecord(next, record)) return;
  const previous = record;
  record = {
    ...emptyRecord(pageUrl),
    ...next,
    url: pageUrl,
    highlights: next.highlights || [],
  };
  const signature = (list) => (list || []).map((item) => `${item.id}|${item.text}|${item.prefix}|${item.suffix}`).join('\n');
  if (signature(previous.highlights) !== signature(record.highlights)) {
    const before = JSON.stringify(toStoredRecord(record));
    renderFromRecord();
    if (JSON.stringify(toStoredRecord(record)) !== before) persist();
    if (bubbleId && !record.highlights.some((item) => item.id === bubbleId)) closeBubble();
    return;
  }
  paintCommentState(document.body, record.highlights);
  if (bubbleId && ui.shadow.activeElement !== ui.textarea) {
    const highlight = record.highlights.find((item) => item.id === bubbleId);
    if (highlight) {
      ui.quoteEl.textContent = highlight.text || '';
      ui.textarea.value = highlight.draft != null ? highlight.draft : (highlight.comment || '');
    }
  }
}

function scrollToHighlight(id) {
  const nodes = highlightNodes(document.body, id);
  if (!nodes.length) return false;
  nodes[0].scrollIntoView({ behavior: 'auto', block: 'center' });
  for (const node of nodes) {
    node.classList.add('whn-flash');
    setTimeout(() => node.classList.remove('whn-flash'), 600);
  }
  return true;
}

function bindUi() {
  for (const button of [ui.highlightBtn, ui.commentBtn]) {
    button.addEventListener('mousedown', (event) => {
      pointerInUi = true;
      event.preventDefault();
      event.stopPropagation();
    });
  }
  for (const button of [ui.saveBtn, ui.deleteBtn]) {
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  }
  ui.highlightBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    pointerInUi = true;
    createHighlight(false).finally(() => {
      pointerInUi = false;
    });
  });
  ui.commentBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    pointerInUi = true;
    createHighlight(true).finally(() => {
      pointerInUi = false;
    });
  });
  ui.saveBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    saveBubble();
  });
  ui.deleteBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deleteBubble();
  });
  ui.textarea.addEventListener('input', () => {
    const highlight = record.highlights.find((item) => item.id === bubbleId);
    if (!highlight) return;
    highlight.draft = ui.textarea.value;
    persist();
  });
  ui.textarea.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      saveBubble();
    }
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'whn:scroll') {
    sendResponse({ ok: scrollToHighlight(message.id) });
    return false;
  }
  return undefined;
});

async function announceTab() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'whn:hello' });
      if (response?.tabId) {
        document.documentElement.dataset.whnTab = String(response.tabId);
        return;
      }
    } catch {
      // Service worker may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function bindPage() {
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('keyup', onKeyUp, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('scroll', onScroll, true);
  document.addEventListener('selectionchange', () => {
    if (pointerInUi || ui.bubbleOpen()) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      if (ui.toolbarOpen()) hideToolbar();
    }
  });
  window.addEventListener('blur', () => {
    suppressToolbar = true;
    hideToolbar();
  });
  chrome.storage.onChanged.addListener(onStorage);
}

async function init() {
  bindUi();
  bindPage();
  await announceTab();
  const stored = await chrome.storage.local.get(pageUrl);
  record = stored[pageUrl]
    ? { ...emptyRecord(pageUrl), ...stored[pageUrl], url: pageUrl }
    : emptyRecord(pageUrl);
  await reconcile();
  document.documentElement.dataset.whnReady = '1';
}

init().catch((error) => {
  console.error('web-highlight-notes init failed', error);
  document.documentElement.dataset.whnReady = 'error';
  document.documentElement.dataset.whnError = error?.stack || String(error);
});
