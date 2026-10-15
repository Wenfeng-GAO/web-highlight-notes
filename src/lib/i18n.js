/** chrome.i18n wrapper. Falls back to the key so missing messages are visible, not blank. */
export function t(key, substitutions) {
  const getMessage = globalThis.chrome?.i18n?.getMessage;
  const message = getMessage ? getMessage(key, substitutions) : '';
  return message || key;
}

/** Fill [data-i18n], [data-i18n-placeholder], [data-i18n-aria-label] in a root. */
export function localize(root) {
  for (const element of root.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of root.querySelectorAll('[data-i18n-placeholder]')) {
    element.setAttribute('placeholder', t(element.dataset.i18nPlaceholder));
  }
  for (const element of root.querySelectorAll('[data-i18n-aria-label]')) {
    element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
  }
}
