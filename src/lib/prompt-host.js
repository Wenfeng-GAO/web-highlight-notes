import { FILE_PATTERN, isSitePattern } from './url.js';

// A permission card may name one web host. It may not name every file, every
// site, or a wildcard host. The worker stores this pattern; the card does not
// choose it.
export function isPromptHost(pattern) {
  return isSitePattern(pattern) && pattern !== FILE_PATTERN;
}
