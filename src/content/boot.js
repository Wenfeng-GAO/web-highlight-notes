// Classic entry. Content scripts are not ES modules, so the real script is imported.
(async () => {
  try {
    await import(chrome.runtime.getURL('src/content/content.js'));
  } catch (error) {
    console.error('web-highlight-notes boot failed', error);
    document.documentElement.dataset.whnReady = 'error';
    document.documentElement.dataset.whnError = error?.stack || String(error);
  }
})();
