// Issue #16: text whose parent is not an HTML element must never be wrapped in an HTML
// <span> (SVG and MathML don't render it, so the text disappears).
import { beforeEach, describe, expect, it } from 'vitest';
import { applyHighlights, svgHostsAwaitingLayout } from '../../src/lib/apply.js';
import { indexText, selectorFromOffsets } from '../../src/lib/anchor.js';
import { canMarkRange, markKind, unwrapAll, wrapRange } from '../../src/lib/highlight-dom.js';

const PAGE = `
  <p id="intro">图前的说明文字。</p>
  <svg id="d" viewBox="0 0 360 100">
    <title>示意图标题</title>
    <defs><text id="def">定义里的文字</text></defs>
    <rect x="6" y="6" width="100" height="30"/><text id="label" x="56" y="26">控制面</text>
    <text id="sentence" x="14" y="60">此后相位具体值 <tspan id="ts" fill="#b26b00">存疑</tspan>（Q2）</text>
    <text id="turned" rotate="20" x="10" y="80">逐字旋转</text>
    <path id="curve" d="M0 90 L 300 90"/><text id="onpath"><textPath href="#curve">沿着曲线</textPath></text>
    <foreignObject x="0" y="0" width="100" height="40"><p id="fo" xmlns="http://www.w3.org/1999/xhtml">嵌入的段落</p></foreignObject>
  </svg>
  <p id="formula">公式 <math id="m"><mi>E</mi><mo>=</mo><mi>m</mi><mtext>能量公式</mtext></math> 结束。</p>
`;

beforeEach(() => {
  document.body.innerHTML = PAGE;
});

const textOf = (css) => document.querySelector(css).firstChild;

function rangeOver(node, quote) {
  const range = document.createRange();
  const start = node.nodeValue.indexOf(quote);
  range.setStart(node, start);
  range.setEnd(node, start + quote.length);
  return range;
}

/** A record saved by <=0.1.6: exact text plus 30 chars of context from indexText. */
function legacyRecord(quote, id, comment = '') {
  const { text } = indexText(document.body);
  const start = text.indexOf(quote);
  const selector = selectorFromOffsets(text, start, start + quote.length);
  return { id, text: selector.exact, prefix: selector.prefix, suffix: selector.suffix, comment, draft: null, createdAt: 1, pos: start, anchored: true };
}

describe('markKind', () => {
  it('classifies text by the namespace it renders in', () => {
    expect(markKind(textOf('#intro'))).toBe('html');
    expect(markKind(textOf('#fo'))).toBe('html');
    expect(markKind(textOf('#label'))).toBe('svg');
    expect(markKind(textOf('#ts'))).toBe('svg');
    expect(markKind(textOf('#sentence'))).toBe('svg');
    expect(markKind(document.querySelector('#onpath textPath').firstChild)).toBe('block');
    expect(markKind(textOf('#turned'))).toBe('block');
    expect(markKind(document.querySelector('#m mtext').firstChild)).toBe('block');
    expect(markKind(document.querySelector('#m mi').firstChild)).toBe('block');
    expect(markKind(textOf('#def'))).toBe('block');
    expect(markKind(document.querySelector('#d title').firstChild)).toBe('skip');
  });

  it('treats an HTML span left inside SVG text by 0.1.6 as not rendered', () => {
    const label = document.querySelector('#label');
    label.innerHTML = '';
    const span = document.createElement('span');
    span.className = 'whn-hl';
    span.textContent = '控制面';
    label.appendChild(span);
    expect(markKind(span.firstChild)).toBe('skip');
    unwrapAll(document.body);
    expect(label.outerHTML).toBe('<text id="label" x="56" y="26">控制面</text>');
  });
});

describe('never wraps non-HTML text in a span', () => {
  it('refuses MathML, textPath and rotated SVG text, leaving the DOM unchanged', () => {
    const before = document.body.innerHTML;
    for (const [node, quote] of [
      [document.querySelector('#m mtext').firstChild, '能量'],
      [document.querySelector('#onpath textPath').firstChild, '沿着'],
      [textOf('#turned'), '旋转'],
    ]) {
      const range = rangeOver(node, quote);
      expect(canMarkRange(range)).toBe(false);
      expect(wrapRange(range, { id: 'x', hasComment: false })).toEqual([]);
    }
    expect(document.body.innerHTML).toBe(before);
  });

  it('refuses a selection that runs from HTML into MathML as a whole', () => {
    const before = document.body.innerHTML;
    const range = document.createRange();
    range.setStart(textOf('#formula'), 0);
    range.setEnd(document.querySelector('#m mtext').firstChild, 2);
    expect(canMarkRange(range)).toBe(false);
    expect(wrapRange(range, { id: 'x', hasComment: true })).toEqual([]);
    expect(document.body.innerHTML).toBe(before);
  });

  it('still wraps HTML inside <foreignObject>', () => {
    const spans = wrapRange(rangeOver(textOf('#fo'), '段落'), { id: 'fo', hasComment: false });
    expect(spans).toHaveLength(1);
    expect(spans[0].namespaceURI).toBe('http://www.w3.org/1999/xhtml');
    expect(document.querySelector('#fo').textContent).toBe('嵌入的段落');
  });

  it('SVG text with no measurable glyphs (not laid out) is left alone, never wrapped', () => {
    // jsdom has no SVG layout, like a diagram that is not rendered: no mark, no damage.
    const before = document.querySelector('#d').outerHTML;
    expect(wrapRange(rangeOver(textOf('#label'), '控制面'), { id: 'l', hasComment: false })).toEqual([]);
    expect(document.querySelector('#d').outerHTML).toBe(before);
  });
});

describe('restore path with records saved by <=0.1.6', () => {
  it('keeps SVG and MathML text intact and reports them unanchored when no mark can be drawn', () => {
    const records = [
      legacyRecord('控制面', 'svg-label', '旧评论'),
      legacyRecord('存疑', 'svg-tspan'),
      legacyRecord('能量公式', 'math'),
      legacyRecord('沿着曲线', 'path'),
      legacyRecord('图前的说明', 'html'),
    ];
    const svg = document.querySelector('#d').outerHTML;
    const math = document.querySelector('#m').outerHTML;
    const applied = applyHighlights(document.body, records);
    expect(document.querySelector('#d').outerHTML).toBe(svg);
    expect(document.querySelector('#m').outerHTML).toBe(math);
    expect(document.querySelectorAll('svg span, math span')).toHaveLength(0);
    const state = Object.fromEntries(applied.map((item) => [item.id, item.anchored]));
    expect(state).toEqual({ 'svg-label': false, 'svg-tspan': false, math: false, path: false, html: true });
    expect(applied.find((item) => item.id === 'svg-label').comment).toBe('旧评论');
    expect(document.querySelector('#intro .whn-hl').textContent).toBe('图前的说明');
  });

  it('unwrapAll removes SVG rect marks and comment dots', () => {
    const ns = 'http://www.w3.org/2000/svg';
    const label = document.querySelector('#label');
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('class', 'whn-hl whn-svg-hl');
    rect.setAttribute('data-whn-id', 'a');
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('class', 'whn-svg-dot');
    label.before(rect, dot);
    unwrapAll(document.body);
    expect(document.querySelectorAll('.whn-svg-hl, .whn-svg-dot')).toHaveLength(0);
    expect(document.querySelectorAll('#d rect')).toHaveLength(1);
  });
});

// jsdom has no SVG layout and no DOMMatrix. These stand in for getCTM()/getExtentOfChar().
class MatrixShim {
  constructor(parts) {
    this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
    if (parts) Object.assign(this, parts);
  }

  static fromMatrix(source) {
    return new MatrixShim(source);
  }

  multiply(other) {
    return new MatrixShim({
      a: this.a * other.a + this.c * other.b,
      b: this.b * other.a + this.d * other.b,
      c: this.a * other.c + this.c * other.d,
      d: this.b * other.c + this.d * other.d,
      e: this.a * other.e + this.c * other.f + this.e,
      f: this.b * other.e + this.d * other.f + this.f,
    });
  }

  inverse() {
    const det = this.a * this.d - this.b * this.c;
    if (!det) return new MatrixShim({ a: NaN, b: NaN, c: NaN, d: NaN, e: NaN, f: NaN });
    return new MatrixShim({
      a: this.d / det,
      b: -this.b / det,
      c: -this.c / det,
      d: this.a / det,
      e: (this.c * this.f - this.d * this.e) / det,
      f: (this.b * this.e - this.a * this.f) / det,
    });
  }

  toString() {
    return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`;
  }
}

const ROTATE = { a: 0.866, b: 0.5, c: -0.5, d: 0.866, e: 12, f: -4 };

function mockLayout(css, textCtm, holderCtm = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) {
  const text = document.querySelector(css);
  text.getCTM = () => textCtm;
  text.parentElement.getCTM = () => holderCtm;
  text.getNumberOfChars = () => text.textContent.length;
  text.getExtentOfChar = (index) => ({ x: 10 + index * 8, y: 20, width: 8, height: 12 });
  return text;
}

describe('SVG text transform (#20)', () => {
  beforeEach(() => {
    globalThis.DOMMatrix = MatrixShim;
  });

  it('draws a rect in the text’s own transform, same as a rotation on the parent', () => {
    const own = mockLayout('#label', ROTATE);
    const marks = wrapRange(rangeOver(own.firstChild, '控制'), { id: 'own', hasComment: true });
    expect(marks).toHaveLength(1);
    const rect = marks[0];
    expect(rect.getAttribute('transform')).toBe(new MatrixShim(ROTATE).toString());
    // Coordinates stay in the text’s user space; the transform rotates them.
    expect(rect.getAttribute('x')).toBe('10');
    expect(rect.getAttribute('y')).toBe('18');
    expect(rect.getAttribute('width')).toBe('16');
    const dot = rect.nextElementSibling;
    expect(dot.getAttribute('class')).toBe('whn-svg-dot');
    expect(dot.getAttribute('transform')).toBe(rect.getAttribute('transform'));
    expect(own.outerHTML.startsWith('<text id="label"')).toBe(true);
    expect(own.textContent).toBe('控制面');
  });

  it('keeps a parent rotation on the ancestor and does not copy it onto the rect', () => {
    const text = mockLayout('#label', ROTATE, ROTATE);
    const [rect] = wrapRange(rangeOver(text.firstChild, '控制'), { id: 'g', hasComment: false });
    expect(rect.getAttribute('transform')).toBeNull();
    expect(rect.getAttribute('x')).toBe('10');
    expect(rect.getAttribute('y')).toBe('18');
  });

  it('still bakes an axis-aligned translate into the rect coordinates', () => {
    const text = mockLayout('#label', { a: 1, b: 0, c: 0, d: 1, e: 10, f: 0 });
    const [rect] = wrapRange(rangeOver(text.firstChild, '控制'), { id: 't', hasComment: false });
    expect(rect.getAttribute('transform')).toBeNull();
    expect(rect.getAttribute('x')).toBe('20');
    expect(rect.getAttribute('y')).toBe('18');
    expect(rect.getAttribute('width')).toBe('16');
  });
});

describe('SVG layout retry (#18)', () => {
  it('points an unmeasured SVG highlight at its svg, and ignores text that can never be marked', () => {
    const records = [
      legacyRecord('控制面', 'svg-label'),
      legacyRecord('沿着曲线', 'path'),
      legacyRecord('能量公式', 'math'),
      legacyRecord('逐字旋转', 'spin'),
    ];
    const applied = applyHighlights(document.body, records);
    expect(applied.find((item) => item.id === 'svg-label').anchored).toBe(false);
    expect(svgHostsAwaitingLayout(document.body, applied).map((node) => node.id)).toEqual(['d']);
  });
});
