// Фильтр: считаем навигацию "редиректом", если фронтенд/сервер нас перенаправил
function isRedirect(details) {
    const q = details.transitionQualifiers || [];
    return q.includes('client_redirect') || q.includes('server_redirect');
}

chrome.webNavigation.onCommitted.addListener(function (details) {
    if (details.frameId === 0 && details.tabId > 0 && !isRedirect(details)) {
        // Ключ привязан к вкладке — вкладки больше не мешают друг другу
        chrome.storage.local.set({ [`originalUrl_${details.tabId}`]: details.url });
    }
});

// На случай, если фронтенд — это SPA и переходит по истории (pushState)
// chrome.webNavigation.onHistoryStateUpdated.addListener(function (details) {
//     if (details.frameId === 0 && details.tabId > 0) {
//         chrome.storage.local.set({ [`originalUrl_${details.tabId}`]: details.url });
//     }
// });

// Убираем хвосты при закрытии вкладки
chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.local.remove(`originalUrl_${tabId}`);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    if (msg.action === 'set-badge') {
        if (msg.text !== undefined)   chrome.action.setBadgeText({ text: msg.text });
        if (msg.color !== undefined)  chrome.action.setBadgeBackgroundColor({ color: msg.color });
    }

    if (msg.action === 'get-original-url') {
        const tabId = sender.tab?.id;
        if (!tabId) {
            sendResponse({ originalUrl: null });
            return;
        }
        const key = `originalUrl_${tabId}`;
        chrome.storage.local.get(key, (result) => {
            sendResponse({ originalUrl: result[key] || null });
            // Одноразовый билетик: забрали — удалили, чтобы при следующем логине не сработало повторно
            chrome.storage.local.remove(key);
        });
        return true; // важно: отвечаем асинхронно
    }
});