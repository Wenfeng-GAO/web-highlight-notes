function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function depth(node) {
  let count = 0;
  let current = node;
  while (current) {
    count += 1;
    current = current.parentElement;
  }
  return count;
}

function intersects(range, node) {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function wrapPortion(node, start, end, id) {
  let textNode = node;
  if (start > 0) textNode = textNode.splitText(start);
  const length = end - start;
  if (textNode.length > length) textNode.splitText(length);
  const span = textNode.ownerDocument.createElement('span');
  span.className = 'whn-hl';
  span.dataset.whnId = id;
  textNode.parentNode.insertBefore(span, textNode);
  span.appendChild(textNode);
  return span;
}

export function unwrapAll(root) {
  if (!root) return;
  const spans = [...root.querySelectorAll('span.whn-hl')];
  spans.sort((a, b) => depth(b) - depth(a));
  for (const span of spans) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  }
  root.normalize?.();
}

export function wrapRange(range, { id, hasComment }) {
  const ancestor = range.commonAncestorContainer;
  const scope = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement;
  if (!scope) return [];
  const doc = scope.ownerDocument || document;
  const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const portions = [];
  let current = walker.nextNode();
  while (current) {
    const parent = current.parentElement;
    if (parent?.closest('script, style, noscript, template, #whn-root')) {
      current = walker.nextNode();
      continue;
    }
    if (intersects(range, current)) {
      const start = current === range.startContainer ? range.startOffset : 0;
      const end = current === range.endContainer ? range.endOffset : current.nodeValue.length;
      if (end > start) portions.push({ node: current, start, end });
    }
    current = walker.nextNode();
  }

  const spans = portions.map((portion) => wrapPortion(portion.node, portion.start, portion.end, id));
  if (spans.length) {
    const endSpan = spans[spans.length - 1];
    endSpan.classList.add('whn-hl-end');
    if (hasComment) endSpan.classList.add('whn-has-comment');
  }
  return spans;
}

export function setCommentMarker(root, id, commented) {
  if (!root || !id) return;
  const nodes = [...root.querySelectorAll(`[data-whn-id="${cssEscape(id)}"]`)];
  nodes.forEach((node, index) => {
    const isEnd = index === nodes.length - 1;
    node.classList.toggle('whn-hl-end', isEnd);
    node.classList.toggle('whn-has-comment', isEnd && commented);
  });
}

export function highlightNodes(root, id) {
  if (!root || !id) return [];
  return [...root.querySelectorAll(`[data-whn-id="${cssEscape(id)}"]`)];
}
