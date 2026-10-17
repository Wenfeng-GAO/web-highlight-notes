import { beforeEach, describe, expect, it } from 'vitest';
import { applyHighlights } from '../../src/lib/apply.js';
import { indexText, selectorFromOffsets, selectorFromRange } from '../../src/lib/anchor.js';
import { unwrapAll, wrapRange } from '../../src/lib/highlight-dom.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

function quote(text, start, end, id, comment = '') {
  const selector = selectorFromOffsets(text, start, end);
  return {
    id,
    text: selector.exact,
    prefix: selector.prefix,
    suffix: selector.suffix,
    comment,
    draft: null,
    createdAt: 1,
    pos: start,
    anchored: null,
  };
}

describe('applyHighlights', () => {
  it('wraps repeated phrases according to context and drops lost quotes', () => {
    document.body.innerHTML = `
      <p id="a">前言阿尔法重复短语后续一。</p>
      <p id="b">前言贝塔重复短语后续二。</p>
    `;
    const indexed = indexText(document.body).text;
    const firstAt = indexed.indexOf('重复短语');
    const secondAt = indexed.indexOf('重复短语', firstAt + 1);
    const highlights = [
      quote(indexed, secondAt, secondAt + 4, 'beta', ''),
      quote(indexed, firstAt, firstAt + 4, 'alpha', '有评论'),
    ];

    const applied = applyHighlights(document.body, highlights);
    const alpha = document.querySelector('[data-whn-id="alpha"]');
    const beta = document.querySelector('[data-whn-id="beta"]');
    expect(alpha.textContent).toBe('重复短语');
    expect(beta.textContent).toBe('重复短语');
    expect(alpha.closest('p').id).toBe('a');
    expect(beta.closest('p').id).toBe('b');
    expect(alpha.classList.contains('whn-has-comment')).toBe(true);
    expect(beta.classList.contains('whn-has-comment')).toBe(false);
    expect(applied.find((item) => item.id === 'alpha').anchored).toBe(true);
    expect(applied.map((item) => item.id)).toEqual(['alpha', 'beta']);

    document.body.querySelector('#a').textContent = '这段被改写了';
    document.body.querySelector('#b').textContent = '这里也不再有原文';
    const missing = applyHighlights(document.body, applied);
    expect(missing.every((item) => item.anchored === false)).toBe(true);
    expect(missing).toHaveLength(2);
    expect(document.querySelector('.whn-hl')).toBeNull();
  });

  it('anchors one quote across element boundaries and keeps page text intact', () => {
    document.body.innerHTML = '<p id="p">你好<b>世界</b>和平</p>';
    const indexed = indexText(document.body).text;
    const start = indexed.indexOf('好世界和');
    const [applied] = applyHighlights(document.body, [
      quote(indexed, start, start + '好世界和'.length, 'cross', '注'),
    ]);
    expect(applied.anchored).toBe(true);
    const marked = [...document.querySelectorAll('.whn-hl')].map((node) => node.textContent).join('');
    expect(marked).toBe('好世界和');
    expect(document.getElementById('p').textContent).toBe('你好世界和平');
    expect(document.querySelector('.whn-hl-end.whn-has-comment')).toBeTruthy();
  });
});

describe('unselected text inside a range', () => {
  it('does not paint hidden text or a user-select:none line number', () => {
    document.body.innerHTML = `
      <p id="a">可见开头</p>
      <div hidden>隐藏广告</div>
      <span class="ln" style="user-select: none">9</span>
      <p id="b">可见结尾</p>
    `;
    const range = document.createRange();
    range.setStart(document.querySelector('#a').firstChild, 0);
    range.setEnd(document.querySelector('#b').firstChild, '可见结尾'.length);
    const selector = selectorFromRange(document.body, range);
    const [applied] = applyHighlights(document.body, [{
      id: 'span',
      text: selector.exact,
      prefix: selector.prefix,
      suffix: selector.suffix,
      comment: '',
      draft: null,
      createdAt: 1,
      pos: 0,
      anchored: null,
    }]);
    expect(applied.anchored).toBe(true);
    const painted = [...document.querySelectorAll('.whn-hl')].map((node) => node.textContent).join('');
    expect(painted).toContain('可见开头');
    expect(painted).toContain('可见结尾');
    expect(painted).not.toContain('隐藏广告');
    expect(painted).not.toContain('9');
    expect(document.querySelector('.ln').closest('.whn-hl')).toBeNull();
  });
});

describe('wrapRange', () => {
  it('wraps part of a text node and can unwrap it', () => {
    document.body.innerHTML = '<p id="p">AAA 春天的花园 BBB</p>';
    const paragraph = document.getElementById('p');
    const node = paragraph.firstChild;
    const start = node.nodeValue.indexOf('春天的花园');
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + '春天的花园'.length);
    wrapRange(range, { id: 'h1', hasComment: false });
    expect(paragraph.querySelector('.whn-hl').textContent).toBe('春天的花园');
    expect(paragraph.textContent).toBe('AAA 春天的花园 BBB');
    unwrapAll(document.body);
    expect(paragraph.querySelector('.whn-hl')).toBeNull();
    expect(paragraph.textContent).toBe('AAA 春天的花园 BBB');
  });
});
