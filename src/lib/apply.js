import { findBestMatch, indexText, rangeFromOffsets } from './anchor.js';
import { highlightNodes, setCommentMarker, unmeasuredSvgHosts, unwrapAll, wrapRange } from './highlight-dom.js';
import { compareHighlights, hasComment } from './model.js';

/**
 * Clear existing marks and re-wrap every highlight that can still be found.
 * Unanchored items stay in the returned list with anchored=false and their last pos.
 */
function locateHighlight(root, highlight) {
  const quote = {
    exact: highlight.text || '',
    prefix: highlight.prefix || '',
    suffix: highlight.suffix || '',
  };
  // Full text first, so a quote inside display:none is found (#18). Then the
  // selection index, which omits hidden nodes a drag crossed (#26).
  for (const hide of [false, true]) {
    const indexed = indexText(root, { hide });
    const match = findBestMatch(indexed.text, quote);
    if (!match || indexed.text.slice(match.start, match.end) !== quote.exact) continue;
    let pos = match.start;
    if (hide) {
      // Sort by document order. Offsets in the selection index skip hidden
      // nodes, so they are not comparable with offsets in the full index.
      const range = rangeFromOffsets(indexed.segments, match.start, match.end);
      if (range?.startContainer?.nodeType === Node.TEXT_NODE) {
        const full = indexText(root, { hide: false });
        const segment = full.segments.find((item) => item.node === range.startContainer);
        if (segment) pos = segment.start + range.startOffset;
      }
    }
    return { hide, start: match.start, end: match.end, pos };
  }
  return null;
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
    highlight.anchored = true;
    highlight.pos = match.pos;
    plan.push({ highlight, start: match.start, end: match.end, hide: match.hide });
  }

  plan.sort((a, b) => b.start - a.start);
  for (const item of plan) {
    const fresh = indexText(root, { hide: item.hide });
    if (fresh.text.slice(item.start, item.end) !== item.highlight.text) {
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
    const match = findBestMatch(indexed.text, {
      exact: highlight.text || '',
      prefix: highlight.prefix || '',
      suffix: highlight.suffix || '',
    });
    if (!match || indexed.text.slice(match.start, match.end) !== highlight.text) continue;
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
