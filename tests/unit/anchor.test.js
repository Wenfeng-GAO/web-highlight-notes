import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONTEXT_LEN,
  findBestMatch,
  indexText,
  locateQuote,
  selectorFromOffsets,
  selectorFromRange,
} from '../../src/lib/anchor.js';

function mount(html) {
  document.body.innerHTML = `<div id="root">${html}</div>`;
  return document.getElementById('root');
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('findBestMatch', () => {
  it('returns null when the exact quote was removed', () => {
    const text = '春天的花园里开满了黄色的花';
    const selector = selectorFromOffsets(text, 0, text.length, CONTEXT_LEN);
    expect(findBestMatch('这段文字已经被完全改写', selector)).toBeNull();
    expect(findBestMatch(text.replace('黄色', '红色'), selector)).toBeNull();
  });

  it('picks the occurrence whose prefix and suffix match', () => {
    const text = '前言阿尔法重复短语后续一。前言贝塔重复短语后续二。';
    const first = text.indexOf('重复短语');
    const second = text.indexOf('重复短语', first + 1);
    const alpha = selectorFromOffsets(text, first, first + '重复短语'.length, 8);
    const beta = selectorFromOffsets(text, second, second + '重复短语'.length, 8);

    expect(findBestMatch(text, alpha).start).toBe(first);
    expect(findBestMatch(text, beta).start).toBe(second);
    expect(findBestMatch(text, { exact: '重复短语', prefix: '贝塔', suffix: '后续二' }).start).toBe(second);
  });

  it('still anchors a unique quote when the surrounding context changed', () => {
    const match = findBestMatch('全新前言 hello 全新后语', {
      exact: 'hello',
      prefix: '过时的前缀',
      suffix: '过时的后缀',
    });
    expect(match).not.toBeNull();
    expect(match.start).toBe('全新前言 '.length);
  });

  it('keeps about 30 characters of prefix and suffix', () => {
    const exact = '目标文字';
    const full = `${'甲'.repeat(50)}${exact}${'乙'.repeat(50)}`;
    const start = 50;
    const selector = selectorFromOffsets(full, start, start + exact.length);
    expect(selector.exact).toBe(exact);
    expect(selector.prefix).toBe('甲'.repeat(CONTEXT_LEN));
    expect(selector.suffix).toBe('乙'.repeat(CONTEXT_LEN));
    expect(CONTEXT_LEN).toBe(30);
  });
});

describe('locateQuote', () => {
  it('disambiguates repeated text in the DOM by context', () => {
    const root = mount(`
      <p>前言阿尔法重复短语后续一。</p>
      <p>前言贝塔重复短语后续二。</p>
    `);
    const text = indexText(root).text;
    const start = text.indexOf('前言贝塔重复短语') + '前言贝塔'.length;
    const selector = selectorFromOffsets(text, start, start + '重复短语'.length, 6);
    const located = locateQuote(root, selector);
    expect(located).not.toBeNull();
    expect(text.slice(located.start, located.end)).toBe('重复短语');
    expect(text.slice(located.start - 2, located.start)).toBe('贝塔');
    expect(located.range.cloneContents().textContent).toBe('重复短语');
  });

  it('fails when the quoted text changed', () => {
    const root = mount('<p>研究者在图书馆发现了一份手稿。这是后文。</p>');
    const text = indexText(root).text;
    const start = text.indexOf('研究者在图书馆发现了一份手稿');
    const selector = selectorFromOffsets(text, start, start + '研究者在图书馆发现了一份手稿'.length);
    root.textContent = '这段文字已经被完全改写，原句不在了。';
    expect(locateQuote(root, selector)).toBeNull();
  });

  it('matches a quote that crosses text nodes', () => {
    const root = mount('<p>你好<b>世界</b>和平</p>');
    const text = indexText(root).text;
    expect(text).toBe('你好世界和平');
    const start = text.indexOf('好世界和');
    const selector = selectorFromOffsets(text, start, start + '好世界和'.length);
    const located = locateQuote(root, selector);
    expect(located).not.toBeNull();
    expect(located.range.cloneContents().textContent).toBe('好世界和');

    const paragraph = root.querySelector('p');
    const range = paragraph.ownerDocument.createRange();
    range.setStart(paragraph.firstChild, 1);
    range.setEnd(paragraph.lastChild, 1);
    expect(selectorFromRange(root, range)).toMatchObject({
      exact: '好世界和',
      prefix: '你',
      suffix: '平',
    });
  });

  it('ignores script and style text', () => {
    const root = mount('<p>可见正文</p><script>秘密</script><style>.x{color:red}</style>');
    expect(indexText(root).text).toBe('可见正文');
  });

  // Issue #26: the saved quote matches the selection. Hidden text stays in the
  // full index so a diagram that is display:none can still be found (#18).
  it('omits unselectable and hidden text from a new quote, and still locates hidden text', () => {
    const root = mount(`
      <p id="a">可见开头</p>
      <div hidden>隐藏广告</div>
      <span style="user-select: none">9</span>
      <div style="display: none"><p>折叠广告</p></div>
      <div style="visibility: hidden">看不见</div>
      <div style="user-select: none"><span style="user-select: text">重新可选</span></div>
      <svg><title>示意图标题</title><desc>示意图说明</desc><text>控制面</text></svg>
      <p id="b">可见结尾</p>
    `);
    const text = indexText(root).text;
    expect(text).toContain('可见开头');
    expect(text).toContain('隐藏广告');
    expect(text).toContain('折叠广告');
    expect(text).toContain('重新可选');
    expect(text).toContain('控制面');
    expect(text).not.toContain('示意图标题');
    expect(text).not.toContain('示意图说明');
    expect(text).not.toContain('9');

    const range = root.ownerDocument.createRange();
    range.setStart(root.querySelector('#a').firstChild, 0);
    range.setEnd(root.querySelector('#b').firstChild, '可见结尾'.length);
    const selector = selectorFromRange(root, range);
    expect(selector.exact).toContain('可见开头');
    expect(selector.exact).toContain('可见结尾');
    expect(selector.exact).not.toContain('隐藏广告');
    expect(selector.exact).not.toContain('折叠广告');
    expect(selector.exact).not.toContain('看不见');
    expect(selector.exact).not.toContain('9');
    expect(selector.exact).not.toContain('示意图标题');

    expect(locateQuote(root, selector)).not.toBeNull();
    // The quote itself may sit inside display:none; that has to stay locatable
    // so a hidden diagram can be drawn when it is shown.
    expect(locateQuote(root, { exact: '折叠广告', prefix: '', suffix: '' })).not.toBeNull();
  });
});
