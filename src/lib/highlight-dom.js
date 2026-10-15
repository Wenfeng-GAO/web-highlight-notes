const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
// SVG elements whose text is never drawn, or is drawn somewhere else (<use>, masks).
const SVG_SILENT = new Set(['title', 'desc', 'metadata', 'style', 'script']);
const SVG_UNRENDERED = new Set(['defs', 'symbol', 'clipPath', 'mask', 'pattern', 'marker', 'linearGradient', 'radialGradient', 'filter']);
const SVG_PAD = 2;

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

function svgTextElement(parent) {
  for (let element = parent; element && element.namespaceURI === SVG_NS; element = element.parentElement) {
    if (element.localName === 'text') return element;
  }
  return null;
}

/**
 * How a text node can be marked, from its parent's namespace. An HTML <span> only
 * renders under HTML (including <foreignObject>); inside SVG or MathML it hides the text.
 *   html  wrap in <span>
 *   svg   draw a <rect> behind the SVG <text>
 *   skip  text that is never drawn (SVG <title>, whitespace between shapes)
 *   block can't be marked without breaking or misplacing it
 */
export function markKind(textNode) {
  const parent = textNode.parentElement;
  if (!parent) return 'skip';
  if (parent.namespaceURI === HTML_NS) {
    for (let element = parent.parentElement; element; element = element.parentElement) {
      if (element.namespaceURI === HTML_NS) continue;
      if (element.namespaceURI === SVG_NS && element.localName === 'foreignObject') return 'html';
      // HTML nested straight in SVG/MathML is not rendered (e.g. a <span> left by <=0.1.6).
      return 'skip';
    }
    return 'html';
  }
  if (parent.namespaceURI !== SVG_NS) return 'block'; // MathML or another namespace
  for (let element = parent; element && element.namespaceURI === SVG_NS; element = element.parentElement) {
    if (SVG_UNRENDERED.has(element.localName)) return 'block';
  }
  if (SVG_SILENT.has(parent.localName)) return 'skip';
  const text = svgTextElement(parent);
  if (!text) return 'skip';
  for (let element = parent; element; element = element.parentElement) {
    if (element.localName === 'textPath') return 'block';
    if (element.hasAttribute('rotate')) return 'block';
    if (element === text) break;
  }
  return 'svg';
}

/** Offset of textNode inside the addressable characters of its SVG <text>. */
function charOffset(text, textNode) {
  const walker = text.ownerDocument.createTreeWalker(text, NodeFilter.SHOW_TEXT);
  let before = 0;
  let total = 0;
  let found = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === textNode) found = true;
    if (!found) before += node.nodeValue.length;
    total += node.nodeValue.length;
  }
  return { before, total };
}

function union(boxes) {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Bounds of chars [start, end) of textNode in the user space of its <text>. */
function charBox(text, textNode, start, end) {
  if (typeof text.getExtentOfChar !== 'function' || typeof text.getNumberOfChars !== 'function') return null;
  const { before, total } = charOffset(text, textNode);
  const boxes = [];
  if (text.getNumberOfChars() === total) {
    for (let index = before + start; index < before + end; index += 1) {
      try {
        const box = text.getExtentOfChar(index);
        if (box.width || box.height) boxes.push(box);
      } catch {
        return null;
      }
    }
  } else {
    // Collapsed whitespace shifts char indices; measure the DOM range and map it back.
    const range = text.ownerDocument.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    const screen = text.getScreenCTM?.();
    if (!screen) return null;
    const toUser = screen.inverse();
    for (const rect of range.getClientRects()) {
      if (!rect.width && !rect.height) continue;
      const a = new DOMPoint(rect.left, rect.top).matrixTransform(toUser);
      const b = new DOMPoint(rect.right, rect.bottom).matrixTransform(toUser);
      boxes.push({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) });
    }
  }
  return boxes.length ? union(boxes) : null;
}

/**
 * Where the rect goes, in the coordinates of the <text>'s parent (so it scales with the
 * SVG). Null when it can't be placed accurately: not rendered, rotated or skewed.
 */
function svgRectFor(textNode, start, end) {
  const text = svgTextElement(textNode.parentElement);
  const holder = text?.parentElement;
  // <switch> renders only its first valid child; a rect there would replace the text.
  if (!holder || holder.localName === 'switch' || typeof text.getCTM !== 'function' || typeof holder.getCTM !== 'function') return null;
  const textCtm = text.getCTM();
  const holderCtm = holder.getCTM();
  if (!textCtm || !holderCtm) return null;
  const m = DOMMatrix.fromMatrix(holderCtm).inverse().multiply(DOMMatrix.fromMatrix(textCtm));
  if (Math.abs(m.b) > 1e-6 || Math.abs(m.c) > 1e-6 || !m.a || !m.d) return null;
  const box = charBox(text, textNode, start, end);
  if (!box) return null;
  const x1 = m.a * box.x + m.e;
  const x2 = m.a * (box.x + box.width) + m.e;
  const y1 = m.d * box.y + m.f;
  const y2 = m.d * (box.y + box.height) + m.f;
  return {
    text,
    x: Math.min(x1, x2),
    y: Math.min(y1, y2) - SVG_PAD,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1) + SVG_PAD * 2,
  };
}

function collectPortions(range) {
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
      if (end > start) portions.push({ node: current, start, end, kind: markKind(current) });
    }
    current = walker.nextNode();
  }
  return portions;
}

/**
 * Work out every mark for a range without touching the DOM. Null when any visible part
 * can't be marked; then the selection gets no toolbar and a saved note stays unanchored.
 */
export function planMarks(range) {
  const plan = [];
  for (const portion of collectPortions(range)) {
    if (portion.kind === 'block') return null;
    if (portion.kind === 'skip') continue;
    if (portion.kind === 'html') {
      plan.push(portion);
      continue;
    }
    const rect = svgRectFor(portion.node, portion.start, portion.end);
    if (rect) {
      plan.push({ ...portion, rect });
      continue;
    }
    // Collapsed whitespace has no glyphs; anything else we can't place is a stop.
    if (!portion.node.nodeValue.slice(portion.start, portion.end).trim()) continue;
    return null;
  }
  return plan.length ? plan : null;
}

export function canMarkRange(range) {
  return !!planMarks(range);
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

/** A <rect> right before the <text>, so the text paints on top and is never modified. */
function drawSvgRect({ rect }, id) {
  const doc = rect.text.ownerDocument;
  const shape = doc.createElementNS(SVG_NS, 'rect');
  shape.setAttribute('class', 'whn-hl whn-svg-hl');
  shape.setAttribute('data-whn-id', id);
  shape.setAttribute('x', String(rect.x));
  shape.setAttribute('y', String(rect.y));
  shape.setAttribute('width', String(rect.width));
  shape.setAttribute('height', String(rect.height));
  shape.setAttribute('rx', '2');
  shape.setAttribute('fill', 'rgba(250, 204, 21, 0.4)');
  shape.setAttribute('aria-hidden', 'true');
  rect.text.parentNode.insertBefore(shape, rect.text);
  return shape;
}

function isSvgMark(node) {
  return node.namespaceURI === SVG_NS && node.localName === 'rect';
}

function setSvgDot(shape, show) {
  const next = shape.nextElementSibling;
  const existing = next?.classList?.contains('whn-svg-dot') ? next : null;
  if (!show) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const dot = shape.ownerDocument.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('class', 'whn-svg-dot');
  dot.setAttribute('cx', String(Number(shape.getAttribute('x')) + Number(shape.getAttribute('width'))));
  dot.setAttribute('cy', shape.getAttribute('y'));
  dot.setAttribute('r', '3');
  dot.setAttribute('fill', '#CA8A04');
  dot.setAttribute('aria-hidden', 'true');
  shape.after(dot);
}

function markEnd(node, isEnd, commented) {
  node.classList.toggle('whn-hl-end', isEnd);
  node.classList.toggle('whn-has-comment', isEnd && commented);
  if (isSvgMark(node)) setSvgDot(node, isEnd && commented);
}

export function unwrapAll(root) {
  if (!root) return;
  for (const node of root.querySelectorAll('rect.whn-svg-hl, circle.whn-svg-dot')) node.remove();
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
  const plan = planMarks(range);
  if (!plan) return [];
  // All geometry is measured above, before any text node is split.
  const marks = plan.map((item) => (item.rect ? drawSvgRect(item, id) : wrapPortion(item.node, item.start, item.end, id)));
  marks.forEach((node, index) => markEnd(node, index === marks.length - 1, !!hasComment));
  return marks;
}

export function setCommentMarker(root, id, commented) {
  if (!root || !id) return;
  const nodes = [...root.querySelectorAll(`[data-whn-id="${cssEscape(id)}"]`)];
  nodes.forEach((node, index) => markEnd(node, index === nodes.length - 1, commented));
}

export function highlightNodes(root, id) {
  if (!root || !id) return [];
  return [...root.querySelectorAll(`[data-whn-id="${cssEscape(id)}"]`)];
}
