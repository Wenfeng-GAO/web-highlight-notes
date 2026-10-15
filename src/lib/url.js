/** Storage key: page URL with the fragment removed. */
export function pageKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return String(url || '').split('#')[0];
  }
}

export function isWebUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// Host permission pattern for a page site, e.g. "https://example.com/" plus "*". Match patterns ignore ports.
export function originPattern(url) {
  if (!isWebUrl(url)) return null;
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

// True for patterns naming one host; false for wildcard hosts and <all_urls>.
export function isSitePattern(pattern) {
  const match = /^(https?):\/\/([^/]+)\/\*$/.exec(String(pattern || ''));
  return !!match && !match[2].includes('*');
}
