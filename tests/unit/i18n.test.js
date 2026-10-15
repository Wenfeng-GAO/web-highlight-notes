import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (locale) => JSON.parse(fs.readFileSync(path.join(root, '_locales', locale, 'messages.json'), 'utf8'));
const zh = load('zh_CN');
const en = load('en');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(js|html)$/.test(entry.name) ? [full] : [];
  });
}

function usedKeys() {
  const keys = new Set();
  const texts = [fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'), ...sourceFiles(path.join(root, 'src')).map((file) => fs.readFileSync(file, 'utf8'))];
  for (const text of texts) {
    for (const match of text.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)) keys.add(match[1]);
    for (const match of text.matchAll(/data-i18n(?:-placeholder|-aria-label)?="([A-Za-z0-9_]+)"/g)) keys.add(match[1]);
    for (const match of text.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) keys.add(match[1]);
  }
  return keys;
}

describe('locales', () => {
  it('zh_CN and en have the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it('every message is non-empty and has matching placeholders', () => {
    for (const key of Object.keys(zh)) {
      expect(zh[key].message.trim(), `zh_CN ${key}`).not.toBe('');
      expect(en[key].message.trim(), `en ${key}`).not.toBe('');
      const names = (message) => [...message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => m[1].toLowerCase()).sort();
      expect(names(en[key].message), key).toEqual(names(zh[key].message));
      expect(Object.keys(en[key].placeholders || {}).sort(), key).toEqual(Object.keys(zh[key].placeholders || {}).sort());
    }
  });

  it('every key used in code and manifest exists, and none is unused', () => {
    const used = usedKeys();
    for (const key of used) expect(zh, `missing ${key}`).toHaveProperty(key);
    const unused = Object.keys(zh).filter((key) => !used.has(key));
    expect(unused).toEqual([]);
  });

  it('no hard-coded CJK UI strings remain outside export defaults', () => {
    const offenders = [];
    for (const file of sourceFiles(path.join(root, 'src'))) {
      if (file.endsWith(path.join('lib', 'export.js'))) continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (/[\u4e00-\u9fff]/.test(code)) offenders.push(`${path.relative(root, file)}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
