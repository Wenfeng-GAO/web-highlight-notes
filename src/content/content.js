import { offsetsFromRange } from '../lib/anchor.js';
import { applyHighlights, paintCommentState } from '../lib/apply.js';
import { canMarkRange, highlightNodes, unwrapAll } from '../lib/highlight-dom.js';
import { emptyRecord, sameRecord, toStoredRecord } from '../lib/model.js';
import { titleAfterNavigation } from '../lib/title.js';
import { pageKey } from '../lib/url.js';
import { mountOverlay } from './overlay.js';

// The storage key. Single-page sites change it with history.pushState; see watchUrl().
let pageUrl = pageKey(location.href);
// Title adopted for pageUrl. document.title can lag a single-page navigation (#19).
let pageTitle = '';
// Title still showing from the view we just left, until this view renames the document.
let leftoverTitle = '';
// False while a navigation is loading the destination, so a title write in that
// gap is not saved onto the page we are leaving.
let acceptingTitle = true;
let switching = false;
const ui = mountOverlay();

let record = emptyRecord(pageUrl);
let toolbarRange = null;
let pendingQuote = null;
let baseTop = null;
let suppressToolbar = false;
let pointerInUi = false;
let bubbleId = null;
let lastToolbarRect = null;
let promptShown = false;
let promptAnchorId = null;

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
  // Selections inside <input>/<textarea> report the parent element as anchor in
  // Chrome, so also check the focused element.
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    const anchor = elementFromNode(selection.anchorNode);
    const hasTextSelection = active.selectionStart != null && active.selectionStart !== active.selectionEnd;
    if (hasTextSelection && anchor && (anchor === active || anchor.contains(active))) return true;
  }
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

/**
 * Take document.title when it actually belongs to this page.
 * A same-document navigation leaves the previous title in place until the next
 * view renders; that leftover must not replace a title we already stored, and
 * must not be written onto a page that has none yet.
 * Returns true when the stored title changed and callers should publish it.
 */
function adoptDocumentTitle() {
  if (!acceptingTitle || !record) return false;
  const live = document.title || '';
  const chosen = titleAfterNavigation({
    stored: record.title || '',
    leftover: leftoverTitle,
    live,
  });
  if (live && leftoverTitle && live !== leftoverTitle) leftoverTitle = '';
  if (!chosen) return false;
  pageTitle = chosen;
  if (chosen === record.title) return false;
  record.title = chosen;
  return true;
}

function publishTitle() {
  if (!adoptDocumentTitle()) return;
  const title = record.title || '';
  if (!title) return;
  const shouldSave = record.highlights.length > 0 || !!record.summary;
  if (shouldSave) void persist();
  chrome.runtime.sendMessage({ type: 'whn:title', url: pageUrl, title }).catch(() => {});
}

async function reconcile() {
  const before = toStoredRecord(record);
  adoptDocumentTitle();
  renderFromRecord();
  const after = toStoredRecord(record);
  const shouldSave = record.highlights.length > 0 || !!record.summary;
  if (shouldSave && JSON.stringify(before) !== JSON.stringify(after)) await persist();
}

function hideToolbar() {
  if (ui.toolbarOpen()) lastToolbarRect = ui.toolbar.getBoundingClientRect();
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
  // Like input boxes: no toolbar where a mark can't be drawn (MathML, SVG textPath,
  // rotated SVG text). Better not to offer it than to break the page (#16).
  if (!canMarkRange(range)) {
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

// crypto.randomUUID only exists in secure contexts; plain http:// pages lack it.
function newId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function createHighlight(withComment) {
  const quote = pendingQuote;
  if (!quote?.text?.trim() || !record) return;
  pendingQuote = null;
  const highlight = {
    id: newId(),
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
  if (record.title) {
    pageTitle = record.title;
    if (leftoverTitle && pageTitle !== leftoverTitle) leftoverTitle = '';
  }
  hideToolbar();
  window.getSelection()?.removeAllRanges();
  suppressToolbar = true;
  renderFromRecord();
  await persist();
  if (withComment) openBubble(highlight.id);
  checkSite(highlight.id);
}

/**
 * After a highlight is saved, ask the worker whether this site may auto-restore.
 * Unpermitted sites keep their notes in storage; they only need a click to show.
 * Offer the grant once per page load, and never again after the user declines.
 */
async function checkSite(highlightId) {
  let status = null;
  try {
    status = await chrome.runtime.sendMessage({ type: 'whn:site' });
  } catch {
    return;
  }
  document.documentElement.dataset.whnSite = status?.granted ? 'granted' : (status?.declined ? 'declined' : 'ask');
  if (!status?.pattern || status.granted || status.declined || promptShown) return;
  promptShown = true;
  const src = `${chrome.runtime.getURL('src/prompt/prompt.html')}?origin=${encodeURIComponent(status.pattern)}`;
  promptAnchorId = highlightId;
  const placement = promptPlacement();
  ui.showPrompt(src, placement.anchor, placement.obstacles);
}

/** Where the card goes: under the new highlight, clear of the last toolbar spot and an open bubble. */
function promptPlacement() {
  const anchor = promptAnchorId ? unionRect(highlightNodes(document.body, promptAnchorId)) : null;
  const obstacles = [];
  if (lastToolbarRect) obstacles.push(lastToolbarRect);
  if (ui.bubbleOpen()) obstacles.push(ui.bubble.getBoundingClientRect());
  return { anchor: anchor || lastToolbarRect, obstacles };
}

function placePromptAgain() {
  if (!ui.promptOpen()) return;
  const placement = promptPlacement();
  ui.placePrompt(placement.anchor, placement.obstacles);
}

window.addEventListener('message', (event) => {
  if (!ui.promptOpen() || event.source !== ui.prompt.contentWindow || !event.data?.whnPrompt) return;
  if (event.data.type === 'size') {
    ui.setPromptHeight(Number(event.data.height));
    placePromptAgain();
  }
  if (event.data.type === 'done') {
    promptAnchorId = null;
    ui.hidePrompt();
    document.documentElement.dataset.whnSite = event.data.granted ? 'granted' : 'declined';
  }
});

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

function closestHighlight(target, event) {
  const element = elementFromNode(target);
  const found = element?.closest?.('.whn-hl');
  if (found) return found;
  // SVG marks are <rect>s painted under the <text>, so the text gets the pointer.
  if (!event || !element?.closest?.('svg')) return null;
  return document.elementsFromPoint(event.clientX, event.clientY).find((node) => node.classList?.contains('whn-svg-hl')) || null;
}

let hoveredSvgMark = null;

function onMouseMove(event) {
  const element = elementFromNode(event.target);
  const mark = element?.closest?.('svg') ? closestHighlight(event.target, event) : null;
  if (mark === hoveredSvgMark) return;
  hoveredSvgMark?.classList.remove('whn-hover');
  hoveredSvgMark = mark?.classList.contains('whn-svg-hl') ? mark : null;
  hoveredSvgMark?.classList.add('whn-hover');
}

function onClick(event) {
  if (ui.eventFromHost(event)) return;
  const highlight = closestHighlight(event.target, event);
  if (!highlight) return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.toString().trim()) return;
  const id = highlight.getAttribute('data-whn-id');
  if (!id) return;
  event.preventDefault();
  event.stopPropagation();
  openBubble(id);
}

function onMouseDown(event) {
  if (!ui.bubbleOpen()) return;
  if (ui.eventFromHost(event)) return;
  const highlight = closestHighlight(event.target, event);
  if (highlight && highlight.getAttribute('data-whn-id') === bubbleId) return;
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
  if (ui.promptOpen()) {
    // The toolbar spot is in viewport coordinates and no longer lines up after a scroll.
    lastToolbarRect = null;
    placePromptAgain();
  }
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
  if (message?.type === 'whn:info') {
    // Lets the side panel identify this page without the tabs permission.
    // record.title is the name adopted for this page. document.title is only a
    // fallback while a single-page view has not renamed the document yet.
    sendResponse({ url: pageUrl, title: record.title || document.title || '' });
    return false;
  }
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
  document.addEventListener('mousemove', onMouseMove, { capture: true, passive: true });
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

let switchGeneration = 0;

/**
 * The address changed without a new document (pushState, replaceState, back/forward
 * within a single-page site). Notes belong to the new URL now: drop the old page's
 * marks and load the new key, the same as a reload at that URL would.
 */
async function switchPage(next) {
  const generation = ++switchGeneration;
  switching = true;
  acceptingTitle = false;
  // Snapshot the view we left if the navigate event did not (poll backup).
  if (!leftoverTitle) leftoverTitle = pageTitle || '';
  closeBubble();
  hideToolbar();
  if (ui.promptOpen()) ui.hidePrompt();
  pageUrl = next;
  unwrapAll(document.body);
  record = emptyRecord(next);
  try {
    const stored = await chrome.storage.local.get(next);
    if (generation !== switchGeneration) return;
    record = stored[next] ? { ...emptyRecord(next), ...stored[next], url: next } : emptyRecord(next);
    acceptingTitle = true;
    await reconcile();
    if (generation !== switchGeneration) return;
    // A title already adopted for this page (stored, or set in the same turn).
    // One that arrives later is published from the <title> observer.
    if (record.title && record.title !== leftoverTitle) {
      chrome.runtime.sendMessage({ type: 'whn:title', url: pageUrl, title: record.title }).catch(() => {});
    }
    chrome.runtime.sendMessage({ type: 'whn:navigated', url: next }).catch(() => {});
  } finally {
    if (generation === switchGeneration) {
      switching = false;
      acceptingTitle = true;
    }
  }
  if (generation === switchGeneration) await settle(generation);
}

function marksMissing() {
  if (document.title && document.title !== record.title && record.highlights.length) return true;
  return record.highlights.some((item) => !item.anchored || !highlightNodes(document.body, item.id).length);
}

/** The site may render its view after the URL changes; anchor again while it settles. */
async function settle(generation) {
  for (const delay of [300, 1000, 2500]) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (generation !== switchGeneration) return;
    // The view may rename the document after the URL changes, with or without notes.
    publishTitle();
    if (marksMissing()) await reconcile();
  }
}

function checkUrl(event) {
  const next = pageKey(location.href);
  if (next !== pageUrl) {
    switchPage(next);
    return;
  }
  if (switching) return;
  acceptingTitle = true;
  // Same page (a hash change, or a history entry with the same URL), but the site may
  // still re-render the view and drop our marks — or rename the document.
  if (!event) return;
  publishTitle();
  settle(switchGeneration);
}

function watchTitle() {
  // document.title writes through the <title> element. Head replacement is covered
  // by childList; a late text change by characterData. The poll in watchUrl() is
  // the backup if a page sets the title without touching this tree.
  const root = document.head || document.documentElement;
  const observer = new MutationObserver(() => publishTitle());
  observer.observe(root, { subtree: true, childList: true, characterData: true });
}

function watchUrl() {
  // Content scripts cannot hook the page's history.pushState. The Navigation API
  // reports same-document navigations where Chrome supports it; a short poll covers the rest.
  // `navigate` fires inside pushState/replaceState/popstate, before the app renames the document.
  globalThis.navigation?.addEventListener?.('navigate', (event) => {
    if (event.destination?.sameDocument === false) return;
    leftoverTitle = document.title || pageTitle || '';
    acceptingTitle = false;
  });
  globalThis.navigation?.addEventListener?.('navigateerror', () => {
    if (!switching) acceptingTitle = true;
  });
  globalThis.navigation?.addEventListener?.('navigatesuccess', checkUrl);
  window.addEventListener('popstate', checkUrl);
  setInterval(() => {
    checkUrl(null);
    if (!switching && acceptingTitle) publishTitle();
  }, 500);
  // Restored from the back/forward cache: storage may have changed while the page was away.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) switchPage(pageKey(location.href));
  });
}

async function init() {
  bindUi();
  bindPage();
  watchUrl();
  await announceTab();
  acceptingTitle = false;
  const stored = await chrome.storage.local.get(pageUrl);
  record = stored[pageUrl]
    ? { ...emptyRecord(pageUrl), ...stored[pageUrl], url: pageUrl }
    : emptyRecord(pageUrl);
  acceptingTitle = true;
  await reconcile();
  pageTitle = record.title || document.title || '';
  watchTitle();
  document.documentElement.dataset.whnReady = '1';
}

init().catch((error) => {
  console.error('web-highlight-notes init failed', error);
  document.documentElement.dataset.whnReady = 'error';
  document.documentElement.dataset.whnError = error?.stack || String(error);
});
