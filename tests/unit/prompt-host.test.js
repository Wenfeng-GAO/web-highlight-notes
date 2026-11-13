import { describe, expect, it } from 'vitest';
import { isPromptHost } from '../../src/lib/prompt-host.js';

describe('prompt host patterns', () => {
  it('accepts one web host and rejects wildcards and files', () => {
    expect(isPromptHost('https://a.example/*')).toBe(true);
    expect(isPromptHost('http://127.0.0.1/*')).toBe(true);
    expect(isPromptHost('https://*/*')).toBe(false);
    expect(isPromptHost('http://*/*')).toBe(false);
    expect(isPromptHost('https://*.example.com/*')).toBe(false);
    expect(isPromptHost('file:///*')).toBe(false);
    expect(isPromptHost('<all_urls>')).toBe(false);
    expect(isPromptHost('')).toBe(false);
  });
});
