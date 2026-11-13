import { describe, expect, it } from 'vitest';
import { downloadFilename, formatDate, toMarkdown } from '../../src/lib/export.js';

describe('toMarkdown', () => {
  it('formats title, source, summary, and highlights in order', () => {
    const markdown = toMarkdown({
      title: '测试文章：阅读与笔记',
      url: 'https://example.com/article',
      date: '2026-10-14',
      summary: '一篇关于阅读与城市的测试文章',
      highlights: [
        { text: '春天的花园里开满了黄色的花', comment: '' },
        { text: '研究者在图书馆发现了一份手稿', comment: '这份手稿很关键' },
        { text: '城市在黄昏时分慢慢亮起灯火', comment: '黄昏的光线' },
      ],
    });

    expect(markdown).toBe(`# 测试文章：阅读与笔记
来源：https://example.com/article · 2026-10-14
## 摘要
一篇关于阅读与城市的测试文章
## 划线
> 春天的花园里开满了黄色的花
> 研究者在图书馆发现了一份手稿
评论：这份手稿很关键
> 城市在黄昏时分慢慢亮起灯火
评论：黄昏的光线
`);
  });

  it('omits the comment line when there is no comment and keeps unanchored quotes', () => {
    const markdown = toMarkdown({
      title: '标题',
      url: 'https://example.com/a',
      date: '2026-01-02',
      summary: '',
      highlights: [
        { text: '仍在页面上', comment: '   ', anchored: true },
        { text: '已经找不到', comment: '保留下来', anchored: false },
      ],
    });

    expect(markdown).toBe(`# 标题
来源：https://example.com/a · 2026-01-02
## 摘要

## 划线
> 仍在页面上
> 已经找不到
评论：保留下来
`);
  });

  it('turns multiline quotes into blockquote lines', () => {
    const markdown = toMarkdown({
      title: 'T',
      url: 'https://a.test',
      date: '2026-03-04',
      summary: '摘要',
      highlights: [{ text: '第一行\n第二行', comment: '' }],
    });
    expect(markdown).toContain('> 第一行\n> 第二行\n');
    expect(markdown).not.toContain('评论：');
  });
});

describe('formatDate and filename', () => {
  it('formats a local calendar date', () => {
    expect(formatDate(new Date(2026, 9, 14))).toBe('2026-10-14');
  });

  it('sanitizes the download filename', () => {
    expect(downloadFilename('a/b:c')).toBe('a_b_c.md');
    expect(downloadFilename('')).toBe('划线笔记.md');
  });
});

describe('markdown format contract', () => {
  it('matches the published examples, including raw characters and empty sections', () => {
    const labels = { source: '来源：', summary: '摘要', highlights: '划线', comment: '评论：' };
    expect(toMarkdown({
      title: '标题 *不是* 转义',
      url: 'https://example.com/a?q=1',
      date: '2026-11-13',
      summary: '摘要第一行\n摘要第二行，保留 *星号* 与 [链接](https://example.com)。',
      highlights: [
        { text: '第一行\n\n第三行 > 原样', comment: '  ' },
        { text: '引用', comment: '评论一行\n评论第二行' },
      ],
      labels,
    })).toBe(`# 标题 *不是* 转义
来源：https://example.com/a?q=1 · 2026-11-13
## 摘要
摘要第一行
摘要第二行，保留 *星号* 与 [链接](https://example.com)。
## 划线
> 第一行
> 
> 第三行 > 原样
> 引用
评论：评论一行
评论第二行
`);
    expect(toMarkdown({
      title: 'Only summary',
      url: 'https://example.com/s',
      date: '2026-11-13',
      summary: '正文摘要',
      highlights: [],
      labels,
    })).toBe('# Only summary\n来源：https://example.com/s · 2026-11-13\n## 摘要\n正文摘要\n## 划线\n');
    expect(toMarkdown({
      title: 'Only highlight',
      url: 'https://example.com/h',
      date: '2026-11-13',
      summary: '',
      highlights: [{ text: '仅划线', comment: '一条评论' }],
      labels,
    })).toBe('# Only highlight\n来源：https://example.com/h · 2026-11-13\n## 摘要\n\n## 划线\n> 仅划线\n评论：一条评论\n');
    expect(toMarkdown({
      title: 'T',
      url: 'https://example.com/a',
      date: '2026-10-15',
      summary: 'S',
      highlights: [{ text: 'quote', comment: 'note' }],
      labels: { source: 'Source: ', summary: 'Summary', highlights: 'Highlights', comment: 'Note: ' },
    })).toBe('# T\nSource: https://example.com/a · 2026-10-15\n## Summary\nS\n## Highlights\n> quote\nNote: note\n');
    expect(toMarkdown({
      title: 'T',
      url: 'https://example.com/a',
      date: '2026-01-02',
      summary: '   ',
      highlights: [],
      labels,
    })).toBe('# T\n来源：https://example.com/a · 2026-01-02\n## 摘要\n   \n## 划线\n');
  });
});

describe('toMarkdown labels', () => {
  it('uses the given labels for an English export', () => {
    const markdown = toMarkdown({
      title: 'T',
      url: 'https://example.com/a',
      date: '2026-10-15',
      summary: 'S',
      highlights: [{ text: 'quote', comment: 'note' }],
      labels: { source: 'Source: ', summary: 'Summary', highlights: 'Highlights', comment: 'Note: ' },
    });
    expect(markdown).toBe('# T\nSource: https://example.com/a · 2026-10-15\n## Summary\nS\n## Highlights\n> quote\nNote: note\n');
    expect(downloadFilename('', 'highlight-notes')).toBe('highlight-notes.md');
  });
});
