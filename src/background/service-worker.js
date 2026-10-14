function enablePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

enablePanel();
chrome.runtime.onInstalled.addListener(() => enablePanel());
chrome.runtime.onStartup.addListener(() => enablePanel());

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'whn:hello') {
    sendResponse({ tabId: sender.tab?.id ?? null });
  }
});
