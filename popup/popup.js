// Загрузка конфигов
async function loadInstances() {
  const { instances = {}, activeInstances = [] } = await chrome.storage.sync.get(['instances', 'activeInstances']);
  const list = document.getElementById('instances-list');
  list.textContent = '';

  // Отображение списка инстансов
  Object.entries(instances).forEach(([url, config]) => {
    const div = document.createElement('div');
    div.className = 'instance-item material-list-item';
    
    const instanceName = document.createElement('span');
    instanceName.className = "material-instance-name";
    instanceName.appendChild(document.createTextNode(url));

    const materialSwitch = document.createElement('label');
    materialSwitch.className = "material-switch";
    
    const checkbox = document.createElement('input');
    const slider = document.createElement('span');
    slider.className = "material-slider";

    checkbox.type = 'checkbox';
    checkbox.checked = activeInstances.includes(url);
    checkbox.addEventListener('change', () => toggleInstance(url, checkbox.checked));

    materialSwitch.appendChild(checkbox);
    materialSwitch.appendChild(slider);
    div.appendChild(instanceName);
    div.appendChild(materialSwitch);

    // const checkbox = document.createElement('input');
    // checkbox.type = 'checkbox';
    // checkbox.className = "material-slider";
    // checkbox.checked = activeInstances.includes(url);
    // checkbox.addEventListener('change', () => toggleInstance(url, checkbox.checked));
    
    // div.appendChild(checkbox);
    // div.appendChild(document.createTextNode(url));
    list.appendChild(div);
  });
}

// Переключение инстанса
async function toggleInstance(url, isActive) {
  const { activeInstances = [] } = await chrome.storage.sync.get('activeInstances');
  const updated = isActive
    ? [...new Set([...activeInstances, url])]  // Уникальные URL
    : activeInstances.filter(u => u !== url);
  
  await chrome.storage.sync.set({ activeInstances: updated });
}

// Добавление нового инстанса
function addNewInstance() {
  const url = prompt('URL инстанса (например, http://localhost:3000):');
  if (!url) return;
  
  const login = prompt('Логин:');
  const password = prompt('Пароль:');
  const authMethod = prompt('Метод (пока есть только aes-ecb):');
  
  chrome.storage.sync.get(['instances'], ({ instances = {} }) => {
    instances[url] = { login, password, authMethod };
    chrome.storage.sync.set({ instances });
    location.reload();  // Обновляем popup
  });
}




// --- Логика для вкладок (tab) ---
let currentTab = 'instances';
const POPUP_MESSAGE_TIMEOUT_MS = 12000;
const REPORT_OPERATION_BUDGET_MS = 10000;
const CLEANUP_STORAGE_KEY = 'cleanupSettings';
const CLEANUP_PREVIEW_TIMEOUT_MS = 120000;
const CLEANUP_DELETE_TIMEOUT_MS = 10 * 60 * 1000;
let cleanupPreviewItems = [];
let cleanupPreviewTabId = null;

function withTimeout(promise, timeoutMs = POPUP_MESSAGE_TIMEOUT_MS) {
    let timer;
    return Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
            timer = setTimeout(
                () => reject(new Error('Вкладка не ответила вовремя')),
                timeoutMs,
            );
        }),
    ]).finally(() => clearTimeout(timer));
}

function createReportOperationDeadline() {
    return Date.now() + REPORT_OPERATION_BUDGET_MS;
}

function showTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));

    document.getElementById(`${tabId}-tab`).classList.add('active');
    const activeButton = document.querySelector(`.tab-button[data-tab="${tabId}"]`);
    if (activeButton) activeButton.classList.add('active');
    currentTab = tabId;
}

// --- Проверка URL и показ вкладки "Управление" ---
async function checkAndSetupReportTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;

    const url = new URL(tab.url);
    if (url.pathname.match(/^\/report((\/.*)|())$/)) //.startsWith('/report/') || url.pathname == "/report"
    {
        document.getElementById('reportTabBtn').style.display = 'inline-block';
        // Загружаем текущее состояние настройки при открытии попапа
        await loadCurrentState(tab.id);

        // if (currentTab !== 'report') 
            showTab('report');
    } else {
        document.getElementById('reportTabBtn').style.display = 'none';
        // Если мы не на странице отчёта, но вкладка "Управление" активна, переключаем на "Настройки"
        // if (currentTab === 'report') 
            showTab('instances');
    }

    
}

// --- Загрузка текущего значения настройки ---
async function loadCurrentState(tabId) {
    const stateSpan = document.getElementById('current-state');
    const toggleBtn = document.getElementById('toggle-state-btn');
    stateSpan.textContent = 'Загрузка...';
    toggleBtn.disabled = true;

    try {
      console.log("load state", tabId);
        // Отправляем запрос в контентный скрипт
        const response = await withTimeout(chrome.tabs.sendMessage(tabId, {
            action: 'getSetting',
            deadline: createReportOperationDeadline(),
            // Здесь нужные параметры для запроса, читаемые из sessionStorage
            // params: { /* param1: 'value1', param2: 'value2' */ }
        }));
        if (response && response.success) {
            stateSpan.textContent = response.value;
            toggleBtn.disabled = false;
        } else {
            stateSpan.textContent = 'Ошибка загрузки';
        }
    } catch (error) {
        console.error("Ошибка при загрузке состояния:", error);
        stateSpan.textContent = 'Ошибка';
    } finally {
        toggleBtn.disabled = false;
    }
}

// --- Обработчик переключения ---
async function onToggleState() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    const toggleBtn = document.getElementById('toggle-state-btn');
    const stateSpan = document.getElementById('current-state');
    toggleBtn.disabled = true;
    stateSpan.textContent = 'Отправка...';

    try {
        const response = await withTimeout(chrome.tabs.sendMessage(tab.id, {
            action: 'toggleSetting',
            deadline: createReportOperationDeadline(),
            // params: { /* param1: 'value1', param2: 'value2' */ }
        }));
        if (response && response.success) {
            stateSpan.textContent = response.newValue;
        } else {
            stateSpan.textContent = 'Ошибка при переключении';
        }
    } catch (error) {
        console.error("Ошибка при переключении:", error);
        stateSpan.textContent = 'Ошибка';
    } finally {
        toggleBtn.disabled = false;
    }
}

async function onOpenFormulaBrowser() {
    const button = document.getElementById('open-formula-browser-btn');
    const status = document.getElementById('formula-browser-status');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
        status.textContent = 'Активная вкладка не найдена';
        return;
    }

    button.disabled = true;
    button.textContent = 'Открытие...';
    status.textContent = '';

    try {
        const response = await withTimeout(chrome.tabs.sendMessage(tab.id, {
            action: 'openFormulaBrowser',
        }));
        if (!response?.success) {
            throw new Error(response?.error || 'Контентный скрипт не ответил');
        }
        window.close();
    } catch (error) {
        console.error('Ошибка открытия браузера формул:', error);
        status.textContent = 'Не удалось открыть. Обновите страницу отчёта.';
    } finally {
        button.disabled = false;
        button.textContent = 'Открыть браузер формул';
    }
}

async function loadFormulaBrowserShortcut() {
    const label = document.getElementById('formula-browser-shortcut');
    try {
        const commands = await chrome.commands.getAll();
        const command = commands.find((item) => item.name === 'open-formula-browser');
        label.textContent = `Хоткей: ${command?.shortcut || 'не назначен'}`;
    } catch {
        label.textContent = 'Хоткей настраивается в браузере';
    }
}

async function openShortcutSettings() {
    try {
        if (typeof chrome.commands.openShortcutSettings === 'function') {
            await chrome.commands.openShortcutSettings();
            window.close();
            return;
        }
        await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
        window.close();
    } catch {
        document.getElementById('formula-browser-shortcut').textContent =
            'Откройте chrome://extensions/shortcuts';
    }
}

function setSettingsTransferBusy(isBusy) {
    document.getElementById('export-settings-btn').disabled = isBusy;
    document.getElementById('import-settings-btn').disabled = isBusy;
}

function showSettingsTransferStatus(message, isError = false) {
    const status = document.getElementById('settings-transfer-status');
    status.textContent = message;
    status.classList.toggle('is-error', isError);
}

async function onExportSettings() {
    setSettingsTransferBusy(true);
    showSettingsTransferStatus('Подготовка файла...');
    document.getElementById('apply-imported-shortcut-btn').hidden = true;

    try {
        const [storageSync, commands] = await Promise.all([
            chrome.storage.sync.get(null),
            chrome.commands.getAll(),
        ]);
        const backup = SettingsTransfer.createBackup(storageSync, commands);
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = `universal-auth-injector-settings-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(objectUrl);
        showSettingsTransferStatus('Настройки экспортированы.');
    } catch (error) {
        console.error('Ошибка экспорта настроек:', error);
        showSettingsTransferStatus(`Не удалось экспортировать: ${error.message}`, true);
    } finally {
        setSettingsTransferBusy(false);
    }
}

function onChooseImportFile() {
    const input = document.getElementById('import-settings-file');
    input.value = '';
    input.click();
}

async function onImportSettings(event) {
    const [file] = event.target.files || [];
    if (!file) return;

    setSettingsTransferBusy(true);
    showSettingsTransferStatus('Импорт настроек...');
    const shortcutButton = document.getElementById('apply-imported-shortcut-btn');
    shortcutButton.hidden = true;

    try {
        if (file.size > 5 * 1024 * 1024) {
            throw new Error('файл слишком большой');
        }
        const backup = SettingsTransfer.parseBackup(await file.text());
        const response = await chrome.runtime.sendMessage({
            action: 'import-settings-backup',
            backup,
        });
        if (!response?.success) {
            const importError = new Error(response?.error || 'service worker не ответил');
            importError.rollbackError = response?.rollbackError;
            importError.shortcutRollbackErrors = response?.shortcutRollbackErrors;
            throw importError;
        }
        const result = response.result;

        await loadInstances();
        await loadFormulaBrowserShortcut();
        await loadCleanupSettings();

        const pendingShortcut = result.manualShortcuts[0];
        if (pendingShortcut) {
            const shortcutInstruction = pendingShortcut.shortcut
                ? `Хоткей ${pendingShortcut.shortcut} назначьте вручную.`
                : 'Хоткей снимите вручную.';
            showSettingsTransferStatus(`Настройки импортированы. ${shortcutInstruction}`);
            shortcutButton.hidden = false;
        } else if (result.skippedShortcuts.length > 0) {
            showSettingsTransferStatus('Настройки импортированы. Хоткей из файла не найден в этой версии расширения.', true);
        } else if (Object.keys(backup.shortcuts).length === 0) {
            showSettingsTransferStatus('Настройки импортированы. В файле нет хоткея.');
        } else {
            showSettingsTransferStatus('Настройки и хоткей импортированы.');
        }
    } catch (error) {
        console.error('Ошибка импорта настроек:', error);
        const rollbackNote = error.rollbackError
            ? ' Не удалось также вернуть прежние настройки.'
            : '';
        const shortcutRollbackNote = error.shortcutRollbackErrors?.length
            ? ' Не удалось также вернуть прежний хоткей.'
            : '';
        showSettingsTransferStatus(
            `Не удалось импортировать: ${error.message}.${rollbackNote}${shortcutRollbackNote}`.trim(),
            true,
        );
    } finally {
        setSettingsTransferBusy(false);
    }
}

function readCleanupSettingsFromForm() {
    return {
        objectTypes: [...document.querySelectorAll('[data-cleanup-object-type]:checked')]
            .map((input) => input.dataset.cleanupObjectType),
        locations: [...document.querySelectorAll('[data-cleanup-location]:checked')]
            .map((input) => input.dataset.cleanupLocation),
        mask: document.getElementById('cleanup-mask').value,
        force: document.getElementById('cleanup-force').checked,
    };
}

function applyCleanupSettingsToForm(settingsValue) {
    const settings = ObjectCleanupCore.normalizeSettings(settingsValue);
    document.querySelectorAll('[data-cleanup-object-type]').forEach((input) => {
        input.checked = settings.objectTypes.includes(input.dataset.cleanupObjectType);
    });
    document.querySelectorAll('[data-cleanup-location]').forEach((input) => {
        input.checked = settings.locations.includes(input.dataset.cleanupLocation);
    });
    document.getElementById('cleanup-mask').value = settings.mask;
    document.getElementById('cleanup-force').checked = settings.force;
}

async function loadCleanupSettings() {
    const result = await chrome.storage.sync.get(CLEANUP_STORAGE_KEY);
    applyCleanupSettingsToForm(result[CLEANUP_STORAGE_KEY]);
}

async function saveCleanupSettings() {
    const settings = readCleanupSettingsFromForm();
    await chrome.storage.sync.set({ [CLEANUP_STORAGE_KEY]: settings });
    return settings;
}

function onCleanupSettingsChanged() {
    saveCleanupSettings().catch((error) => {
        showCleanupStatus(`Не удалось сохранить параметры: ${error.message}`, true);
    });
}

function showCleanupStatus(message, isError = false) {
    const status = document.getElementById('cleanup-status');
    status.textContent = message;
    status.classList.toggle('is-error', isError);
}

function cleanupLocationLabel(location) {
    return ObjectCleanupCore.LOCATIONS[location] || location;
}

function updateCleanupPreviewSummary() {
    const forcedCount = cleanupPreviewItems.filter(({ force }) => force).length;
    document.getElementById('cleanup-preview-summary').textContent =
        `Объектов: ${cleanupPreviewItems.length}. Безвозвратно: ${forcedCount}.`;
    document.getElementById('cleanup-confirm-btn').disabled = cleanupPreviewItems.length === 0;
}

function renderCleanupPreview() {
    const list = document.getElementById('cleanup-preview-list');
    list.textContent = '';
    if (cleanupPreviewItems.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'cleanup-empty';
        empty.textContent = 'В списке не осталось объектов.';
        list.appendChild(empty);
        updateCleanupPreviewSummary();
        return;
    }

    cleanupPreviewItems.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'cleanup-preview-item';

        const name = document.createElement('div');
        name.className = 'cleanup-preview-name';
        name.textContent = item.name || `Объект #${item.id}`;
        name.title = name.textContent;

        const meta = document.createElement('div');
        meta.className = 'cleanup-preview-meta';
        meta.textContent = [
            item.kind,
            cleanupLocationLabel(item.location),
            `id ${item.id}`,
            item.path,
        ].filter(Boolean).join(' · ');
        meta.title = meta.textContent;

        const controls = document.createElement('div');
        controls.className = 'cleanup-item-controls';
        const forceLabel = document.createElement('label');
        forceLabel.className = 'cleanup-option cleanup-item-force';
        const forceInput = document.createElement('input');
        forceInput.type = 'checkbox';
        forceInput.checked = item.force === true;
        forceInput.addEventListener('change', () => {
            item.force = forceInput.checked;
            updateCleanupPreviewSummary();
        });
        forceLabel.append(forceInput, document.createTextNode('Безвозвратно'));

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'cleanup-remove-button';
        removeButton.title = 'Убрать из списка';
        removeButton.setAttribute('aria-label', `Убрать ${name.textContent} из списка`);
        removeButton.textContent = '×';
        removeButton.addEventListener('click', () => {
            if (removeButton.disabled) return;
            const itemIndex = cleanupPreviewItems.indexOf(item);
            if (itemIndex < 0) return;
            removeButton.disabled = true;
            removeButton.classList.add('is-loading');
            removeButton.setAttribute('aria-busy', 'true');
            removeButton.textContent = '';
            row.classList.add('is-removing');
            cleanupPreviewItems.splice(itemIndex, 1);
            if (cleanupPreviewItems.length === 0) {
                document.getElementById('cleanup-confirm-btn').disabled = true;
            }

            const removeItem = () => {
                row.remove();
                if (cleanupPreviewItems.length === 0) renderCleanupPreview();
                else updateCleanupPreviewSummary();
            };
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => setTimeout(removeItem, 0));
            } else {
                setTimeout(removeItem, 0);
            }
        });

        controls.append(forceLabel, removeButton);
        row.append(name, controls, meta);
        list.appendChild(row);
    });
    updateCleanupPreviewSummary();
}

function closeCleanupPreview() {
    document.getElementById('cleanup-preview-modal').hidden = true;
}

async function onPreviewCleanup(event) {
    event.preventDefault();
    const button = document.getElementById('cleanup-preview-btn');
    button.disabled = true;
    button.textContent = 'Поиск...';
    showCleanupStatus('Ищу объекты на текущем инстансе...');

    try {
        const settings = await saveCleanupSettings();
        ObjectCleanupCore.validateSettings(settings);
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error('Активная вкладка не найдена');
        const response = await withTimeout(
            chrome.tabs.sendMessage(tab.id, {
                action: 'previewObjectCleanup',
                settings,
            }),
            CLEANUP_PREVIEW_TIMEOUT_MS,
        );
        if (!response?.success) {
            throw new Error(response?.error || 'Контентный скрипт не ответил');
        }

        cleanupPreviewTabId = tab.id;
        cleanupPreviewItems = response.items.map((item) => ({ ...item }));
        renderCleanupPreview();
        const warning = document.getElementById('cleanup-preview-warning');
        warning.textContent = (response.warnings || []).join('\n');
        warning.hidden = !warning.textContent;
        document.getElementById('cleanup-delete-result').textContent = '';
        document.getElementById('cleanup-delete-result').classList.remove('is-error');
        document.getElementById('cleanup-preview-modal').hidden = false;
        showCleanupStatus(`Найдено объектов: ${cleanupPreviewItems.length}.`);
    } catch (error) {
        console.error('Ошибка подготовки очистки:', error);
        showCleanupStatus(`Не удалось выполнить поиск: ${error.message}`, true);
    } finally {
        button.disabled = false;
        button.textContent = 'Найти объекты';
    }
}

async function onConfirmCleanup() {
    if (cleanupPreviewItems.length === 0) return;
    const button = document.getElementById('cleanup-confirm-btn');
    const cancelButton = document.getElementById('cleanup-cancel-btn');
    const resultStatus = document.getElementById('cleanup-delete-result');
    button.disabled = true;
    cancelButton.disabled = true;
    button.textContent = 'Удаление...';
    resultStatus.textContent = `Удалено 0 из ${cleanupPreviewItems.length}...`;
    resultStatus.classList.remove('is-error');

    const requestedItems = cleanupPreviewItems.map(({ id, name, force }) => ({ id, name, force }));
    try {
        if (!cleanupPreviewTabId) throw new Error('Исходная вкладка поиска не найдена');
        const response = await withTimeout(
            chrome.tabs.sendMessage(cleanupPreviewTabId, {
                action: 'deleteCleanupObjects',
                items: requestedItems,
            }),
            CLEANUP_DELETE_TIMEOUT_MS,
        );
        if (!response?.success) throw new Error(response?.error || 'Контентный скрипт не ответил');

        const failedById = new Map(
            response.results.filter(({ success }) => !success).map((result) => [String(result.id), result]),
        );
        const deletedCount = response.results.length - failedById.size;
        cleanupPreviewItems = cleanupPreviewItems.filter((item) => failedById.has(String(item.id)));
        renderCleanupPreview();

        if (failedById.size > 0) {
            const firstErrors = [...failedById.values()].slice(0, 3)
                .map((result) => `${result.name || result.id}: ${result.error}`)
                .join('\n');
            resultStatus.textContent = `Удалено: ${deletedCount}. Ошибок: ${failedById.size}.\n${firstErrors}`;
            resultStatus.classList.add('is-error');
            showCleanupStatus(`Удалено: ${deletedCount}, ошибок: ${failedById.size}.`, true);
        } else {
            resultStatus.textContent = `Успешно удалено: ${deletedCount}.`;
            showCleanupStatus(`Успешно удалено: ${deletedCount}.`);
        }
    } catch (error) {
        console.error('Ошибка выполнения очистки:', error);
        resultStatus.textContent = `Удаление не завершено: ${error.message}`;
        resultStatus.classList.add('is-error');
    } finally {
        button.textContent = 'Удалить выбранное';
        button.disabled = cleanupPreviewItems.length === 0;
        cancelButton.disabled = false;
    }
}

// --- Остальной код (инициализация списка инстансов и т.д.) ---

document.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('add-instance').addEventListener('click', addNewInstance);
    document.getElementById('toggle-state-btn').addEventListener('click', onToggleState);
    document.getElementById('open-formula-browser-btn').addEventListener('click', onOpenFormulaBrowser);
    document.getElementById('configure-shortcuts-btn').addEventListener('click', openShortcutSettings);
    document.getElementById('export-settings-btn').addEventListener('click', onExportSettings);
    document.getElementById('import-settings-btn').addEventListener('click', onChooseImportFile);
    document.getElementById('import-settings-file').addEventListener('change', onImportSettings);
    document.getElementById('apply-imported-shortcut-btn').addEventListener('click', openShortcutSettings);
    document.getElementById('cleanup-form').addEventListener('submit', onPreviewCleanup);
    document.getElementById('cleanup-form').addEventListener('change', onCleanupSettingsChanged);
    document.getElementById('cleanup-mask').addEventListener('input', onCleanupSettingsChanged);
    document.getElementById('cleanup-preview-close').addEventListener('click', closeCleanupPreview);
    document.getElementById('cleanup-cancel-btn').addEventListener('click', closeCleanupPreview);
    document.getElementById('cleanup-confirm-btn').addEventListener('click', onConfirmCleanup);

    // Настройка вкладок
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.addEventListener('click', () => showTab(btn.getAttribute('data-tab')));
    });

    await Promise.all([loadInstances(), checkAndSetupReportTab(), loadCleanupSettings()]);
    await loadFormulaBrowserShortcut();
});
