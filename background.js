chrome.webNavigation.onCommitted.addListener(function (details) {
  if (details.frameId === 0 && details.tabId) {
    chrome.tabs.get(details.tabId, (tab) => {
      // Сохраняем исходный URL
      chrome.storage.local.set({ originalUrl: details.url });
    });
  }
});