// Загрузка конфигов
chrome.storage.sync.get(['instances', 'activeInstances'], ({ instances = {}, activeInstances = [] }) => {
  const list = document.getElementById('instances-list');
  
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
  
  // Кнопка добавления
  document.getElementById('add-instance').addEventListener('click', addNewInstance);
});

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
        const response = await chrome.tabs.sendMessage(tabId, {
            action: 'getSetting',
            // Здесь нужные параметры для запроса, читаемые из sessionStorage
            // params: { /* param1: 'value1', param2: 'value2' */ }
        });
        if (response && response.success) {
            stateSpan.textContent = response.value;
            toggleBtn.disabled = false;
        } else {
            stateSpan.textContent = 'Ошибка загрузки';
        }
    } catch (error) {
        console.error("Ошибка при загрузке состояния:", error);
        stateSpan.textContent = 'Ошибка';
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
        const response = await chrome.tabs.sendMessage(tab.id, {
            action: 'toggleSetting',
            // params: { /* param1: 'value1', param2: 'value2' */ }
        });
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

// --- Остальной код (инициализация списка инстансов и т.д.) ---

document.addEventListener('DOMContentLoaded', async () => {
    // Инициализация списка инстансов (как у тебя было)
    chrome.storage.sync.get(['instances', 'activeInstances'], ({ instances = {}, activeInstances = [] }) => {
        const list = document.getElementById('instances-list');
        // ... (твой код для отображения списка) ...
    });

    document.getElementById('add-instance').addEventListener('click', addNewInstance);
    document.getElementById('toggle-state-btn').addEventListener('click', onToggleState);

    // Настройка вкладок
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.addEventListener('click', () => showTab(btn.getAttribute('data-tab')));
    });

    await checkAndSetupReportTab();
});