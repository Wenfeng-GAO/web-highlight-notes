/** TextQuoteSelector-style anchoring. Pure DOM helpers, no extension APIs. */

export const CONTEXT_LEN = 30;

const SKIP_SELECTOR = 'script, style, noscript, template, #whn-root';
// SVG <title>/<desc> are in the DOM but never drawn. indexText and the painter
// both have to skip them, or a selection that crosses an icon stores the title.
const SILENT_PARENT = new Set(['title', 'desc', 'metadata']);

/**
 * Which text nodes belong in an index.
 * `hide` drops text the user did not select (display:none, hidden, visibility).
 * The restore index leaves that text in, so a quote inside a display:none SVG
 * can still be found and drawn when the diagram is shown (#18). Line numbers
 * (user-select: none) and SVG <title> are never part of a quote.
 * Closed <details> is display:block in Chrome; checkVisibility() is false for it
 * and must not be used here.
 */
export function textFilter({ hide = false } = {}) {
  const displayCache = new WeakMap();

  function displayHidden(element) {
    if (displayCache.has(element)) return displayCache.get(element);
    let hidden = !!element.hidden;
    if (!hidden && typeof getComputedStyle === 'function') {
      try {
        hidden = getComputedStyle(element).display === 'none';
      } catch {
        hidden = false;
      }
    }
    if (!hidden && element.parentElement) hidden = displayHidden(element.parentElement);
    displayCache.set(element, hidden);
    return hidden;
  }

  return function include(node) {
    const parent = node.parentElement;
    if (!parent || !node.nodeValue) return false;
    if (parent.closest(SKIP_SELECTOR)) return false;
    if (SILENT_PARENT.has(parent.localName)) return false;
    // Diff tables: formatting whitespace between structural rows is not part of a quote.
    // Keep whitespace inside code cells (td/th/pre/code parents stay).
    if (!node.nodeValue.trim() && parent.closest('table') && /^(TABLE|TBODY|THEAD|TFOOT|TR)$/.test(parent.tagName)) {
      return false;
    }
    if (typeof getComputedStyle !== 'function') return !hide;
    let cs;
    try {
      cs = getComputedStyle(parent);
    } catch {
      return true;
    }
    const select = String(cs.userSelect || cs.webkitUserSelect || '').toLowerCase();
    if (select === 'none') return false;
    if (!hide) return true;
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (displayHidden(parent)) return false;
    return true;
  };
}

function docOf(root) {
  return root?.ownerDocument || document;
}

/**
 * Concatenate text nodes under root. Offsets are UTF-16 code units and line up
 * with the segments array so matches can cross element boundaries.
 */
export function indexText(root, { hide = false } = {}) {
  const doc = docOf(root);
  const segments = [];
  let text = '';
  if (!root) return { text, segments };

  const include = textFilter({ hide });
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return include(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  let node = walker.nextNode();
  while (node) {
    const value = node.nodeValue || '';
    const start = text.length;
    text += value;
    segments.push({ node, start, end: text.length });
    node = walker.nextNode();
  }
  return { text, segments };
}

function commonPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

function commonSuffixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[a.length - 1 - index] === b[b.length - 1 - index]) index += 1;
  return index;
}

export function scoreContext(text, start, end, prefix, suffix) {
  let score = 0;
  if (prefix) {
    const before = text.slice(Math.max(0, start - prefix.length), start);
    score += commonSuffixLength(before, prefix);
  }
  if (suffix) {
    const after = text.slice(end, end + suffix.length);
    score += commonPrefixLength(after, suffix);
  }
  return score;
}

/**
 * Find the occurrence of selector.exact whose prefix/suffix best matches.
 * Returns null when the exact quote is no longer in the text.
 */
export function findBestMatch(text, selector) {
  const exact = selector?.exact ?? selector?.text ?? '';
  if (!exact) return null;
  const prefix = selector.prefix || '';
  const suffix = selector.suffix || '';
  let from = 0;
  let best = null;
  while (from <= text.length) {
    const index = text.indexOf(exact, from);
    if (index === -1) break;
    const start = index;
    const end = index + exact.length;
    const score = scoreContext(text, start, end, prefix, suffix);
    if (!best || score > best.score) best = { start, end, score };
    from = index + 1;
  }
  return best;
}

/**
 * A quote saved before line numbers were excluded (#26). Gutter digits sat at
 * the start of a line in that index (`\n        2const beta`). Strip those
 * digits, then collapse whitespace so the quote can be searched in the new index.
 * Digits inside a line (`alpha = 1;`) stay.
 */
export function normalizeLegacyQuote(value) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n');
  const stripped = text.replace(/(^|\n)[ \t]*\d+[ \t]*(?=\n|$|\S)/g, '$1');
  return stripped.replace(/\s+/g, ' ').trim();
}

function collapseWithMap(text) {
  let norm = '';
  const map = [];
  let pending = false;
  let started = false;
  for (let index = 0; index < text.length; index += 1) {
    if (/\s/.test(text[index])) {
      if (started) pending = true;
      continue;
    }
    if (pending) {
      norm += ' ';
      map.push(index);
    }
    pending = false;
    started = true;
    norm += text[index];
    map.push(index);
  }
  return { norm, map };
}

/**
 * Find a pre-#27 quote in text from the new index. Offsets point into `text`,
 * not the collapsed copy. Null when the normalized quote is not there.
 */
function stripWithMap(text) {
  let norm = '';
  const map = [];
  for (let index = 0; index < text.length; index += 1) {
    if (/\s/.test(text[index])) continue;
    norm += text[index];
    map.push(index);
  }
  return { norm, map };
}

export function matchLegacyQuote(text, selector) {
  // Structural table whitespace may be absent from the post-#30 index while a
  // pre-#27 quote still carries it. Strip ALL whitespace on both sides so gutter
  // digits (already removed by normalizeLegacyQuote) and formatting gaps align.
  const exact = normalizeLegacyQuote(selector?.exact ?? selector?.text ?? '').replace(/\s+/g, '');
  if (!exact) return null;
  const collapsed = stripWithMap(String(text ?? ''));
  const match = findBestMatch(collapsed.norm, {
    exact,
    prefix: normalizeLegacyQuote(selector?.prefix || '').replace(/\s+/g, ''),
    suffix: normalizeLegacyQuote(selector?.suffix || '').replace(/\s+/g, ''),
  });
  if (!match || collapsed.norm.slice(match.start, match.end) !== exact) return null;
  const start = collapsed.map[match.start];
  const end = collapsed.map[match.end - 1] + 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return null;
  if (normalizeLegacyQuote(text.slice(start, end)).replace(/\s+/g, '') !== exact) return null;
  return { start, end };
}

export function selectorFromOffsets(text, start, end, contextLen = CONTEXT_LEN) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end > text.length || end <= start) return null;
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - contextLen), start),
    suffix: text.slice(end, Math.min(text.length, end + contextLen)),
  };
}

function mapPoint(segments, container, offset) {
  if (!container) return null;
  if (container.nodeType === Node.TEXT_NODE) {
    const segment = segments.find((item) => item.node === container);
    if (!segment) return null;
    const clamped = Math.max(0, Math.min(offset, container.nodeValue?.length || 0));
    return segment.start + clamped;
  }
  if (container.nodeType !== Node.ELEMENT_NODE) return null;

  if (offset <= 0) {
    const segment = segments.find((item) => container.contains(item.node));
    return segment ? segment.start : null;
  }
  const child = container.childNodes[offset - 1] || container;
  let last = null;
  for (const segment of segments) {
    if (child === segment.node || (child.contains && child.contains(segment.node))) last = segment;
  }
  return last ? last.end : null;
}

export function offsetsFromRange(root, range, contextLen = CONTEXT_LEN) {
  if (!root || !range) return null;
  // New quotes follow the selection: no line numbers, no hidden interstitial text.
  const indexed = indexText(root, { hide: true });
  const start = mapPoint(indexed.segments, range.startContainer, range.startOffset);
  const end = mapPoint(indexed.segments, range.endContainer, range.endOffset);
  if (start == null || end == null || end <= start) return null;
  const selector = selectorFromOffsets(indexed.text, start, end, contextLen);
  if (!selector) return null;
  return { ...indexed, start, end, ...selector };
}

export function selectorFromRange(root, range, contextLen = CONTEXT_LEN) {
  const located = offsetsFromRange(root, range, contextLen);
  if (!located) return null;
  return { exact: located.exact, prefix: located.prefix, suffix: located.suffix };
}

function pointFromOffset(segments, offset, isEnd) {
  if (!segments.length) return null;
  if (!isEnd) {
    for (const segment of segments) {
      if (offset >= segment.start && offset < segment.end) {
        return { node: segment.node, offset: offset - segment.start };
      }
    }
    const last = segments[segments.length - 1];
    if (offset === last.end) return { node: last.node, offset: last.node.nodeValue.length };
    return null;
  }
  for (const segment of segments) {
    if (offset > segment.start && offset <= segment.end) {
      return { node: segment.node, offset: offset - segment.start };
    }
  }
  if (offset === segments[0].start) return { node: segments[0].node, offset: 0 };
  return null;
}

export function rangeFromOffsets(segments, start, end) {
  const startPoint = pointFromOffset(segments, start, false);
  const endPoint = pointFromOffset(segments, end, true);
  if (!startPoint || !endPoint) return null;
  const doc = startPoint.node.ownerDocument || document;
  const range = doc.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

/** Locate a quote in a DOM root. Returns null when the exact text is gone. */
export function locateQuote(root, selector) {
  const quote = {
    exact: selector?.exact ?? selector?.text ?? '',
    prefix: selector?.prefix || '',
    suffix: selector?.suffix || '',
  };
  // Full index first (quotes inside display:none). Then the selection index,
  // whose exact text skips hidden nodes a drag crossed.
  for (const hide of [false, true]) {
    const indexed = indexText(root, { hide });
    const match = findBestMatch(indexed.text, quote);
    if (!match || indexed.text.slice(match.start, match.end) !== quote.exact) continue;
    const range = rangeFromOffsets(indexed.segments, match.start, match.end);
    if (!range) continue;
    return { ...match, range };
  }
  return null;
}
