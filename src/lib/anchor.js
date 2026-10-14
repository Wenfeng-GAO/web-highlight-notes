/** TextQuoteSelector-style anchoring. Pure DOM helpers, no extension APIs. */

export const CONTEXT_LEN = 30;

const SKIP_SELECTOR = 'script, style, noscript, template, #whn-root';

function docOf(root) {
  return root?.ownerDocument || document;
}

/**
 * Concatenate text nodes under root. Offsets are UTF-16 code units and line up
 * with the segments array so matches can cross element boundaries.
 */
export function indexText(root) {
  const doc = docOf(root);
  const segments = [];
  let text = '';
  if (!root) return { text, segments };

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
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
  const indexed = indexText(root);
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
  const indexed = indexText(root);
  const quote = {
    exact: selector?.exact ?? selector?.text ?? '',
    prefix: selector?.prefix || '',
    suffix: selector?.suffix || '',
  };
  const match = findBestMatch(indexed.text, quote);
  if (!match) return null;
  const range = rangeFromOffsets(indexed.segments, match.start, match.end);
  if (!range) return null;
  return { ...match, range };
}
