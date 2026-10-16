import { describe, expect, it } from 'vitest';
import { titleAfterNavigation } from '../../src/lib/title.js';

describe('title after a same-document navigation', () => {
  it('does not keep the previous view once document.title has moved on', () => {
    expect(titleAfterNavigation({
      stored: '',
      leftover: 'SPA /spa/a',
      live: 'SPA /spa/b',
    })).toBe('SPA /spa/b');
  });

  it('does not write the previous view onto a page that has no stored title yet', () => {
    // document.title is still the page we left (the view renames itself later).
    expect(titleAfterNavigation({
      stored: '',
      leftover: 'SPA /spa/a',
      live: 'SPA /spa/a',
    })).toBe('');
  });

  it('keeps a stored title while the document still shows the previous view', () => {
    expect(titleAfterNavigation({
      stored: 'SPA /spa/b',
      leftover: 'SPA /spa/a',
      live: 'SPA /spa/a',
    })).toBe('SPA /spa/b');
  });

  it('adopts a title the view set before or during pushState, replaceState, or popstate', () => {
    expect(titleAfterNavigation({
      stored: '旧的乙',
      leftover: 'SPA /spa/a',
      live: 'SPA /spa/b',
    })).toBe('SPA /spa/b');
  });

  it('uses the document title on a normal load, where nothing was left over', () => {
    expect(titleAfterNavigation({
      stored: '昨天的标题',
      leftover: '',
      live: '测试文章：阅读与笔记',
    })).toBe('测试文章：阅读与笔记');
  });
});
