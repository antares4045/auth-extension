const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createElement() {
  return {
    textContent: '',
    disabled: false,
    checked: false,
    style: {},
    className: '',
    classList: { add() {}, remove() {} },
    addEventListener() {},
    appendChild() {},
    setAttribute() {},
    getAttribute() { return null; },
  };
}

function loadPopup(sendMessage) {
  const elements = new Map();
  const createdTabs = [];
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, createElement());
    return elements.get(id);
  };
  const context = {
    URL,
    console: { log() {}, error() {} },
    location: { reload() {} },
    prompt() { return null; },
    window: { close() {} },
    setTimeout(callback) {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
    document: {
      getElementById: element,
      createElement,
      createTextNode(text) { return { textContent: text }; },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      addEventListener() {},
    },
    chrome: {
      storage: {
        sync: {
          get(keys, callback) {
            const result = Array.isArray(keys)
              ? { instances: {}, activeInstances: [] }
              : {};
            if (callback) callback(result);
            return Promise.resolve(result);
          },
          set() { return Promise.resolve(); },
        },
      },
      tabs: {
        query: async () => [{ id: 7, url: 'https://example.test/report/1' }],
        sendMessage,
        async create(options) { createdTabs.push(options); },
      },
      commands: {
        getAll: async () => [{ name: 'open-formula-browser', shortcut: 'Alt+V' }],
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../popup/popup.js'), 'utf8'),
    context,
    { filename: 'popup/popup.js' },
  );
  return { context, createdTabs, element };
}

test('кнопка открытия восстанавливается, если вкладка не отвечает', async () => {
  const { context, element } = loadPopup(() => new Promise(() => {}));

  const opening = context.onOpenFormulaBrowser();
  const settled = await Promise.race([
    opening.then(() => true),
    new Promise((resolve) => setImmediate(() => resolve(false))),
  ]);

  assert.equal(settled, true, 'обработчик открытия завис на неответившей вкладке');
  assert.equal(element('open-formula-browser-btn').disabled, false);
  assert.equal(element('open-formula-browser-btn').textContent, 'Открыть браузер формул');
  assert.match(element('formula-browser-status').textContent, /Не удалось открыть/);
});

test('переключатель движка разблокируется, если вкладка не отвечает', async () => {
  const { context, element } = loadPopup(() => new Promise(() => {}));

  const loading = context.loadCurrentState(7);
  const settled = await Promise.race([
    loading.then(() => true),
    new Promise((resolve) => setImmediate(() => resolve(false))),
  ]);

  assert.equal(settled, true, 'загрузка версии движка зависла на неответившей вкладке');
  assert.equal(element('toggle-state-btn').disabled, false);
  assert.equal(element('current-state').textContent, 'Ошибка');
});

test('popup показывает назначенный хоткей и открывает экран его настройки', async () => {
  const { context, createdTabs, element } = loadPopup(async () => ({ success: true }));

  await context.loadFormulaBrowserShortcut();
  await context.openShortcutSettings();

  assert.equal(element('formula-browser-shortcut').textContent, 'Хоткей: Alt+V');
  assert.equal(createdTabs.length, 1);
  assert.equal(createdTabs[0].url, 'chrome://extensions/shortcuts');
});

test('операции с настройкой отчёта получают дедлайн раньше popup-таймаута', async () => {
  const messages = [];
  const { context } = loadPopup(async (_tabId, message) => {
    messages.push(message);
    return message.action === 'getSetting'
      ? { success: true, value: 'ФД 4' }
      : { success: true, newValue: 'ФД 3' };
  });
  const before = Date.now();

  await context.loadCurrentState(7);
  await context.onToggleState();

  assert.deepEqual(messages.map(({ action }) => action), ['getSetting', 'toggleSetting']);
  for (const message of messages) {
    assert.equal(Number.isFinite(message.deadline), true);
    assert.ok(message.deadline >= before + 9000);
    assert.ok(message.deadline <= Date.now() + 10000);
  }
});
