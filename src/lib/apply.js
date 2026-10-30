import { findBestMatch, indexText, matchLegacyQuote, rangeFromOffsets, selectorFromOffsets } from './anchor.js';
import { highlightNodes, setCommentMarker, unmeasuredSvgHosts, unwrapAll, wrapRange } from './highlight-dom.js';
import { compareHighlights, hasComment } from './model.js';

/**
 * Clear existing marks and re-wrap every highlight that can still be found.
 * Unanchored items stay in the returned list with anchored=false and their last pos.
 */
function anchorExact(highlight) {
  return highlight.exact || highlight.text || '';
}

function documentPos(root, hide, indexed, start, end) {
  if (!hide) return start;
  // Sort by document order. Offsets in the selection index skip hidden nodes,
  // so they are not comparable with offsets in the full index.
  const range = rangeFromOffsets(indexed.segments, start, end);
  if (range?.startContainer?.nodeType === Node.TEXT_NODE) {
    const full = indexText(root, { hide: false });
    const segment = full.segments.find((item) => item.node === range.startContainer);
    if (segment) return segment.start + range.startOffset;
  }
  return start;
}

function locateHighlight(root, highlight) {
  const quote = {
    exact: anchorExact(highlight),
    prefix: highlight.prefix || '',
    suffix: highlight.suffix || '',
  };
  // Full text first, so a quote inside display:none is found (#18). Then the
  // selection index, which omits hidden nodes a drag crossed (#26).
  for (const hide of [false, true]) {
    const indexed = indexText(root, { hide });
    const match = findBestMatch(indexed.text, quote);
    if (!match || indexed.text.slice(match.start, match.end) !== quote.exact) continue;
    return {
      hide,
      start: match.start,
      end: match.end,
      pos: documentPos(root, hide, indexed, match.start, match.end),
    };
  }
  // A note saved before #27 still has gutter digits in its quote. Try once
  // against the new index, and return a locator in that index (#29).
  // Notes that already have a rewritten exact do not try again.
  if (highlight.exact) return null;
  const indexed = indexText(root, { hide: true });
  const legacy = matchLegacyQuote(indexed.text, {
    exact: highlight.text || '',
    prefix: highlight.prefix || '',
    suffix: highlight.suffix || '',
  });
  if (!legacy) return null;
  const selector = selectorFromOffsets(indexed.text, legacy.start, legacy.end);
  if (!selector) return null;
  return {
    hide: true,
    start: legacy.start,
    end: legacy.end,
    pos: documentPos(root, true, indexed, legacy.start, legacy.end),
    migrated: true,
    exact: selector.exact,
    prefix: selector.prefix,
    suffix: selector.suffix,
  };
}

export function applyHighlights(root, highlights) {
  unwrapAll(root);
  const result = (highlights || []).map((highlight) => ({ ...highlight }));
  const plan = [];

  for (const highlight of result) {
    const match = locateHighlight(root, highlight);
    if (!match) {
      highlight.anchored = false;
      continue;
    }
    if (match.migrated) {
      // Locator only. The saved quote and the comment stay byte for byte.
      highlight.exact = match.exact;
      highlight.prefix = match.prefix;
      highlight.suffix = match.suffix;
    }
    highlight.anchored = true;
    highlight.pos = match.pos;
    plan.push({ highlight, start: match.start, end: match.end, hide: match.hide });
  }

  plan.sort((a, b) => b.start - a.start);
  for (const item of plan) {
    const fresh = indexText(root, { hide: item.hide });
    if (fresh.text.slice(item.start, item.end) !== anchorExact(item.highlight)) {
      item.highlight.anchored = false;
      continue;
    }
    const range = rangeFromOffsets(fresh.segments, item.start, item.end);
    if (!range) {
      item.highlight.anchored = false;
      continue;
    }
    try {
      const spans = wrapRange(range, { id: item.highlight.id, hasComment: hasComment(item.highlight) });
      if (!spans.length) item.highlight.anchored = false;
    } catch {
      item.highlight.anchored = false;
    }
  }

  result.sort(compareHighlights);
  return result;
}

/**
 * SVGs that contain a saved quote we could not measure. Empty for quotes that are
 * gone, or that can never be marked (MathML, textPath, per-glyph rotate).
 */
export function svgHostsAwaitingLayout(root, highlights) {
  const indexed = indexText(root);
  const hosts = new Set();
  for (const highlight of highlights || []) {
    if (highlight.anchored !== false) continue;
    const exact = highlight.exact || highlight.text || '';
    const match = findBestMatch(indexed.text, {
      exact,
      prefix: highlight.prefix || '',
      suffix: highlight.suffix || '',
    });
    if (!match || indexed.text.slice(match.start, match.end) !== exact) continue;
    const range = rangeFromOffsets(indexed.segments, match.start, match.end);
    if (!range) continue;
    for (const host of unmeasuredSvgHosts(range)) hosts.add(host);
  }
  return [...hosts];
}

export function paintCommentState(root, highlights) {
  for (const highlight of highlights || []) {
    if (!highlightNodes(root, highlight.id).length) continue;
    setCommentMarker(root, highlight.id, hasComment(highlight));
  }
}
