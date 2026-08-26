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
