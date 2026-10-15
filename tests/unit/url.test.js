import { describe, expect, it } from 'vitest';
import { isFileUrl, isSitePattern, isSupportedUrl, isUnsupportedPageError, isWebUrl, originPattern, pageKey } from '../../src/lib/url.js';

describe('url helpers', () => {
  it('drops the hash for the storage key', () => {
    expect(pageKey('https://a.example/p?q=1#x')).toBe('https://a.example/p?q=1');
  });
  it('builds a per-site host pattern without the port', () => {
    expect(originPattern('http://127.0.0.1:4173/article.html')).toBe('http://127.0.0.1/*');
    expect(originPattern('https://news.example.com/a/b#c')).toBe('https://news.example.com/*');
    expect(originPattern('chrome://extensions')).toBeNull();
    expect(isWebUrl('file:///tmp/a.html')).toBe(false);
  });
  it('supports local files with one shared pattern', () => {
    expect(isFileUrl('file:///Users/w/notes/a.html')).toBe(true);
    expect(isSupportedUrl('file:///Users/w/notes/a.html')).toBe(true);
    expect(isSupportedUrl('https://a.example/')).toBe(true);
    expect(isSupportedUrl('chrome://newtab/')).toBe(false);
    expect(isSupportedUrl('https://chromewebstore.google.com/') && isSupportedUrl('about:blank')).toBe(false);
    expect(originPattern('file:///Users/w/notes/a.html#x')).toBe('file:///*');
    expect(pageKey('file:///Users/w/a.html#x')).toBe('file:///Users/w/a.html');
    expect(isSitePattern('file:///*')).toBe(true);
  });
  it('recognises the executeScript errors of pages no extension may touch', () => {
    // Messages observed from Chrome (see tests/e2e/file-urls.spec.js).
    expect(isUnsupportedPageError('Cannot access a chrome:// URL')).toBe(true);
    expect(isUnsupportedPageError('The extensions gallery cannot be scripted.')).toBe(true);
    expect(isUnsupportedPageError('Cannot access contents of url "chrome-error://chromewebdata/". Extension manifest must request permission to access this host.')).toBe(true);
    expect(isUnsupportedPageError('Cannot access contents of the page. Extension manifest must request permission to access the respective host.')).toBe(false);
  });
  it('tells site patterns from wildcards', () => {
    expect(isSitePattern('https://a.example/*')).toBe(true);
    expect(isSitePattern('https://*/*')).toBe(false);
    expect(isSitePattern('<all_urls>')).toBe(false);
    expect(isSitePattern('https://*.example.com/*')).toBe(false);
  });
});
