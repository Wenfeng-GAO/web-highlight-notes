import { describe, expect, it } from 'vitest';
import { isSitePattern, isWebUrl, originPattern, pageKey } from '../../src/lib/url.js';

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
  it('tells site patterns from wildcards', () => {
    expect(isSitePattern('https://a.example/*')).toBe(true);
    expect(isSitePattern('https://*/*')).toBe(false);
    expect(isSitePattern('<all_urls>')).toBe(false);
    expect(isSitePattern('https://*.example.com/*')).toBe(false);
  });
});
