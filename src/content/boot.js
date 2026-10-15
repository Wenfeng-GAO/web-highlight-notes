// Classic entry. Content scripts are not ES modules, so the real script is imported.
// The registered script and a toolbar click can both inject into one page; run once.
(async () => {
  if (globalThis.__whnBooted) return;
  globalThis.__whnBooted = true;
  if (document.contentType === 'application/pdf') {
    // Chrome's PDF viewer: the text lives in the viewer, not this document. Say so to the panel.
    document.documentElement.dataset.whnReady = 'unsupported';
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== 'whn:info') return undefined;
      sendResponse({ url: location.href.split('#')[0], title: document.title || '', unsupported: true });
      return false;
    });
    return;
  }
  try {
    await import(chrome.runtime.getURL('src/content/content.js'));
  } catch (error) {
    console.error('web-highlight-notes boot failed', error);
    document.documentElement.dataset.whnReady = 'error';
    document.documentElement.dataset.whnError = error?.stack || String(error);
  }
})();
