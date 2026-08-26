const test = require('node:test');
const assert = require('node:assert/strict');

test('команда хоткея открывает браузер формул в активной вкладке', async () => {
  let commandListener;
  const sent = [];
  global.chrome = {
    storage: {
      sync: { get(key, callback) { callback({ activeInstances: [] }); } },
      session: { set() {}, get() {}, remove() {} },
      onChanged: { addListener() {} },
    },
    webNavigation: { onCommitted: { addListener() {} } },
    tabs: {
      onRemoved: { addListener() {} },
      query: async () => [{ id: 42 }],
      async sendMessage(tabId, message) { sent.push({ tabId, message }); },
    },
    commands: { onCommand: { addListener(listener) { commandListener = listener; } } },
    runtime: { onMessage: { addListener() {} } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  };

  delete require.cache[require.resolve('../background.js')];
  require('../background.js');

  assert.equal(typeof commandListener, 'function');
  await commandListener('open-formula-browser');
  assert.deepEqual(sent, [{
    tabId: 42,
    message: { action: 'openFormulaBrowser' },
  }]);
});

test('manifest назначает Alt+V командой открытия по умолчанию', () => {
  const manifest = require('../manifest.json');
  assert.equal(
    manifest.commands?.['open-formula-browser']?.suggested_key?.default,
    'Alt+V',
  );
});

test('service worker завершает импорт после закрытия popup', async () => {
  let messageListener;
  let stored = { obsolete: true };
  const shortcutUpdates = [];
  global.SettingsTransfer = require('../popup/settings-transfer.js');
  global.chrome = {
    storage: {
      sync: {
        get(key, callback) {
          if (callback) {
            callback({ activeInstances: [] });
            return undefined;
          }
          return Promise.resolve(structuredClone(stored));
        },
        async set(value) { stored = { ...stored, ...structuredClone(value) }; },
        async remove(keys) { for (const key of keys) delete stored[key]; },
      },
      session: { set() {}, get() {}, remove() {} },
      onChanged: { addListener() {} },
    },
    webNavigation: { onCommitted: { addListener() {} } },
    tabs: { onRemoved: { addListener() {} } },
    commands: {
      async getAll() { return [{ name: 'open-formula-browser', shortcut: 'Ctrl+X' }]; },
      async update(value) { shortcutUpdates.push(value); },
      onCommand: { addListener() {} },
    },
    runtime: {
      onMessage: { addListener(listener) { messageListener = listener; } },
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  };

  delete require.cache[require.resolve('../background.js')];
  require('../background.js');

  const backup = global.SettingsTransfer.createBackup(
    { instances: { new: true } },
    [{ name: 'open-formula-browser', shortcut: 'Alt+V' }],
    '2026-08-26T10:00:00.000Z',
  );
  const response = await new Promise((resolve) => {
    const keepsWorkerAlive = messageListener(
      { action: 'import-settings-backup', backup },
      {},
      resolve,
    );
    assert.equal(keepsWorkerAlive, true);
  });

  assert.deepEqual(response, {
    success: true,
    result: { manualShortcuts: [], skippedShortcuts: [] },
  });
  assert.deepEqual(stored, { instances: { new: true } });
  assert.deepEqual(shortcutUpdates, [{ name: 'open-formula-browser', shortcut: 'Alt+V' }]);
});
