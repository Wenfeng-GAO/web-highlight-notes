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

export function isFileUrl(url) {
  try {
    return new URL(url).protocol === 'file:';
  } catch {
    return false;
  }
}

/** Pages the extension can highlight: web pages and local files. */
export function isSupportedUrl(url) {
  return isWebUrl(url) || isFileUrl(url);
}

export const FILE_PATTERN = 'file:///*';

// Host permission pattern for a page site, e.g. "https://example.com/" plus "*". Match patterns ignore ports.
// Local files have no host, so they share one pattern for all files.
export function originPattern(url) {
  if (isFileUrl(url)) return FILE_PATTERN;
  if (!isWebUrl(url)) return null;
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

// True for patterns naming one host; false for wildcard hosts and <all_urls>.
export function isSitePattern(pattern) {
  if (pattern === FILE_PATTERN) return true;
  const match = /^(https?):\/\/([^/]+)\/\*$/.exec(String(pattern || ''));
  return !!match && !match[2].includes('*');
}

/** Chrome's executeScript error for pages no extension may script (chrome://, the Web Store). */
export function isUnsupportedPageError(message) {
  return /Cannot access a chrome|chrome-extension:\/\/|chrome-error:\/\/|extensions gallery cannot be scripted|devtools:\/\//i.test(String(message || ''));
}
