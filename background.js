chrome.webNavigation.onCommitted.addListener(function (details) {
  if (details.frameId === 0 && details.tabId) {
    chrome.tabs.get(details.tabId, (tab) => {
      // Сохраняем исходный URL
      chrome.storage.local.set({ originalUrl: details.url });
    });
  }
});





chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'set-badge') {
    if(msg.text !== undefined)
      chrome.action.setBadgeText({ text: msg.text });
    if(msg.color !== undefined)
      chrome.action.setBadgeBackgroundColor({ color: msg.color });
  }
});