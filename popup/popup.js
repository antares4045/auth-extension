// Загрузка конфигов
chrome.storage.sync.get(['instances', 'activeInstances'], ({ instances = {}, activeInstances = [] }) => {
  const list = document.getElementById('instances-list');
  
  // Отображение списка инстансов
  Object.entries(instances).forEach(([url, config]) => {
    const div = document.createElement('div');
    div.className = 'instance-item';
    
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = activeInstances.includes(url);
    checkbox.addEventListener('change', () => toggleInstance(url, checkbox.checked));
    
    div.appendChild(checkbox);
    div.appendChild(document.createTextNode(url));
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