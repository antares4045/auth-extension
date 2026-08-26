if (typeof importScripts === 'function') {
    importScripts('popup/settings-transfer.js');
}

let activeInstancesCache = []; // Или {}, зависит от того, как ты их хранишь

// 2. Загружаем кэш при старте Service Worker
chrome.storage.sync.get('activeInstances', (result) => {
    activeInstancesCache = result.activeInstances || [];
});

// 3. Обновляем кэш, если пользователь изменил настройки (например, через popup)
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' && changes.activeInstances!== undefined) {
        activeInstancesCache = changes.activeInstances.newValue ?? [];
    }
});


// Фильтр: считаем навигацию "редиректом", если фронтенд/сервер нас перенаправил
function isRedirect(details) {
    const q = details.transitionQualifiers || [];
    return q.includes('client_redirect') || q.includes('server_redirect');
}

chrome.webNavigation.onCommitted.addListener(function (details) {
    if (details.frameId === 0 && details.tabId > 0 && !isRedirect(details)) {
        // Ключ привязан к вкладке — вкладки больше не мешают друг другу
        const currentOrigin = new URL(details.url).origin;
        const isAllowed = activeInstancesCache.includes(currentOrigin);

        if (isAllowed) {
          const key = `originalUrl_${details.tabId}`;
          chrome.storage.session.set({ [key]: details.url });
        }
    }
});

// На случай, если фронтенд — это SPA и переходит по истории (pushState)
// chrome.webNavigation.onHistoryStateUpdated.addListener(function (details) {
//     if (details.frameId === 0 && details.tabId > 0) {
//         chrome.storage.session.set({ [`originalUrl_${details.tabId}`]: details.url });
//     }
// });

// Убираем хвосты при закрытии вкладки
chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.session.remove(`originalUrl_${tabId}`);
});

chrome.commands.onCommand.addListener(async (command, commandTab) => {
    if (command !== 'open-formula-browser') return;
    const [activeTab] = commandTab?.id
        ? [commandTab]
        : await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = activeTab;
    if (!tab?.id) return;
    try {
        await chrome.tabs.sendMessage(tab.id, { action: 'openFormulaBrowser' });
    } catch (error) {
        console.warn('[Auth Injector] Не удалось открыть браузер формул по хоткею:', error);
    }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    if (msg.action === 'import-settings-backup') {
        SettingsTransfer.importBackup(msg.backup, {
            storageArea: chrome.storage.sync,
            commandsApi: chrome.commands,
        }).then(
            (result) => sendResponse({ success: true, result }),
            (error) => sendResponse({
                success: false,
                error: error?.message || String(error),
                rollbackError: Boolean(error?.rollbackError),
                shortcutRollbackErrors: error?.shortcutRollbackErrors || [],
            }),
        );
        return true;
    }

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
        chrome.storage.session.get(key, (result) => {
            sendResponse({ originalUrl: result[key] || null });
            // Одноразовый билетик: забрали — удалили, чтобы при следующем логине не сработало повторно
            chrome.storage.session.remove(key);
        });
        return true; // важно: отвечаем асинхронно
    }
});
