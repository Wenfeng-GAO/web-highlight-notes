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
