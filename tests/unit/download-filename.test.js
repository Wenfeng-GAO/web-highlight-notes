import { describe, expect, it } from 'vitest';
import { downloadFilename } from '../../src/lib/export.js';

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function stem(filename) {
  expect(filename.endsWith('.md')).toBe(true);
  return filename.slice(0, -3);
}

describe('downloadFilename unicode truncation', () => {
  it('keeps a long emoji title inside 80 code units without splitting a pair', () => {
    const aligned = stem(downloadFilename('🙂'.repeat(50)));
    expect(aligned).toBe('🙂'.repeat(40));
    expect(aligned.length).toBe(80);
    expect(aligned).not.toMatch(LONE);

    const skewed = stem(downloadFilename(`a${'🙂'.repeat(50)}`));
    expect(skewed).toBe(`a${'🙂'.repeat(39)}`);
    expect(skewed.length).toBe(79);
    expect(skewed).not.toMatch(LONE);

    const flag = '🇺🇸';
    expect(flag.length).toBe(4);
    expect(stem(downloadFilename(`${'n'.repeat(76)}${flag}`))).toBe(`${'n'.repeat(76)}${flag}`);
    expect(stem(downloadFilename(`${'n'.repeat(77)}${flag}`))).toBe('n'.repeat(77));
  });

  it('drops an emoji that would be cut in half at the 80-unit boundary', () => {
    const filename = downloadFilename(`${'a'.repeat(79)}🙂尾`);
    const body = stem(filename);
    expect(body).toBe('a'.repeat(79));
    expect(body.length).toBeLessThanOrEqual(80);
    expect(body).not.toMatch(LONE);
    expect(body.includes('🙂')).toBe(false);
  });

  it('keeps a combining mark with its base, or drops both when they do not fit', () => {
    const accent = `e${String.fromCodePoint(0x0301)}`;
    const cut = downloadFilename(`${'a'.repeat(79)}${accent}`);
    expect(stem(cut)).toBe('a'.repeat(79));
    expect(stem(cut).endsWith('e')).toBe(false);

    const fitted = downloadFilename(`${'a'.repeat(78)}${accent}`);
    expect(stem(fitted)).toBe(`${'a'.repeat(78)}${accent}`);
    expect(stem(fitted).length).toBe(80);

    const stacked = `a${String.fromCodePoint(0x0301)}${String.fromCodePoint(0x0327)}`;
    const dropped = downloadFilename(`${'b'.repeat(78)}${stacked}`);
    expect(stem(dropped)).toBe('b'.repeat(78));
    expect(stem(dropped)).not.toMatch(/\u0301|\u0327/);
  });

  it('keeps a ZWJ sequence whole when it fits and drops it when it straddles the limit', () => {
    const family = '👨‍👩‍👧‍👦';
    expect(family.length).toBe(11);
    const fitted = downloadFilename(`${'x'.repeat(69)}${family}`);
    expect(stem(fitted)).toBe(`${'x'.repeat(69)}${family}`);
    expect(stem(fitted).length).toBe(80);
    expect(stem(fitted)).not.toMatch(LONE);

    const dropped = downloadFilename(`${'x'.repeat(70)}${family}`);
    expect(stem(dropped)).toBe('x'.repeat(70));
    expect(stem(dropped).includes('\u200D')).toBe(false);
    expect(stem(dropped)).not.toMatch(LONE);
  });

  it('uses the fallback when the only grapheme is longer than 80 code units', () => {
    const cluster = `e${String.fromCodePoint(0x0301).repeat(80)}`;
    expect(cluster.length).toBe(81);
    expect(downloadFilename(cluster)).toBe('划线笔记.md');
  });

  it('without Intl.Segmenter only keeps a surrogate pair intact and caps ASCII', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
    expect(typeof Intl.Segmenter).toBe('function');
    try {
      Object.defineProperty(Intl, 'Segmenter', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      expect(typeof Intl.Segmenter).not.toBe('function');

      const boundary = stem(downloadFilename(`${'a'.repeat(79)}🙂尾`));
      expect(boundary).toBe('a'.repeat(79));
      expect(boundary.length).toBe(79);
      expect(boundary).not.toMatch(LONE);

      expect(stem(downloadFilename('c'.repeat(80)))).toBe('c'.repeat(80));
      expect(stem(downloadFilename('c'.repeat(81)))).toBe('c'.repeat(80));

      // This path is a code-unit cut plus one surrogate check. It is not grapheme-safe:
      // the base letter stays and its combining mark is dropped.
      const accent = `e${String.fromCodePoint(0x0301)}`;
      const split = stem(downloadFilename(`${'a'.repeat(79)}${accent}`));
      expect(split).toBe(`${'a'.repeat(79)}e`);
      expect(split.endsWith(String.fromCodePoint(0x0301))).toBe(false);
    } finally {
      Object.defineProperty(Intl, 'Segmenter', descriptor);
    }
    expect(typeof Intl.Segmenter).toBe('function');
    const accent = `e${String.fromCodePoint(0x0301)}`;
    expect(stem(downloadFilename(`${'a'.repeat(79)}${accent}`))).toBe('a'.repeat(79));
  });

  it('keeps empty, unsafe, and ordinary names on the existing contract', () => {
    expect(downloadFilename('')).toBe('划线笔记.md');
    expect(downloadFilename('   ')).toBe('划线笔记.md');
    expect(downloadFilename('', 'highlight-notes')).toBe('highlight-notes.md');
    expect(downloadFilename('a/b:c')).toBe('a_b_c.md');
    expect(downloadFilename('a/b:c*?"<>|')).toBe('a_b_c______.md');
    expect(downloadFilename('a\u0000b\u001f')).toBe('a_b_.md');
    expect(downloadFilename('///')).toBe('___.md');
    expect(downloadFilename('hello world')).toBe('hello world.md');
    expect(downloadFilename('a   b')).toBe('a b.md');
    expect(downloadFilename('笔记🙂')).toBe('笔记🙂.md');
    expect(downloadFilename('b'.repeat(80))).toBe(`${'b'.repeat(80)}.md`);
    expect(downloadFilename('b'.repeat(81))).toBe(`${'b'.repeat(80)}.md`);
    expect(stem(downloadFilename('b'.repeat(81))).length).toBe(80);
  });
});
