import { findBestMatch, indexText, rangeFromOffsets } from './anchor.js';
import { highlightNodes, setCommentMarker, unmeasuredSvgHosts, unwrapAll, wrapRange } from './highlight-dom.js';
import { compareHighlights, hasComment } from './model.js';

/**
 * Clear existing marks and re-wrap every highlight that can still be found.
 * Unanchored items stay in the returned list with anchored=false and their last pos.
 */
export function applyHighlights(root, highlights) {
  unwrapAll(root);
  const indexed = indexText(root);
  const result = (highlights || []).map((highlight) => ({ ...highlight }));
  const plan = [];

  for (const highlight of result) {
    const match = findBestMatch(indexed.text, {
      exact: highlight.text || '',
      prefix: highlight.prefix || '',
      suffix: highlight.suffix || '',
    });
    if (!match || indexed.text.slice(match.start, match.end) !== highlight.text) {
      highlight.anchored = false;
      continue;
    }
    highlight.anchored = true;
    highlight.pos = match.start;
    plan.push({ highlight, start: match.start, end: match.end });
  }

  plan.sort((a, b) => b.start - a.start);
  for (const item of plan) {
    const fresh = indexText(root);
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
