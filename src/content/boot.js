// Classic entry. Content scripts are not ES modules, so the real script is imported.
// The registered script and a toolbar click can both inject into one page; run once.
(async () => {
  if (globalThis.__whnBooted) return;
  globalThis.__whnBooted = true;
  try {
    await import(chrome.runtime.getURL('src/content/content.js'));
  } catch (error) {
    console.error('web-highlight-notes boot failed', error);
    document.documentElement.dataset.whnReady = 'error';
    document.documentElement.dataset.whnError = error?.stack || String(error);
  }
})();
