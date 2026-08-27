const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('manifest загружает ядро очистки до content script, а вкладка видима всегда', () => {
  const manifest = require('../manifest.json');
  const scripts = manifest.content_scripts[0].js;
  assert.ok(
    scripts.indexOf('content/object-cleanup-core.js') < scripts.indexOf('content/content.js'),
  );

  const popupHtml = fs.readFileSync(path.join(__dirname, '../popup/popup.html'), 'utf8');
  assert.match(popupHtml, /data-tab="cleanup"/);
  assert.doesNotMatch(popupHtml.match(/<button[^>]+data-tab="cleanup"[^>]*>/)?.[0] || '', /display:\s*none/);
});

test('content script проводит поиск и удаление через API-мост', async () => {
  let messageListener;
  const requests = [];
  global.ObjectCleanupCore = require('../content/object-cleanup-core.js');
  global.localStorage = {
    getItem: (key) => key === 'token' ? '<TEST_TOKEN>' : null,
    setItem() {},
  };
  global.sessionStorage = { getItem: () => null };
  global.window = { location: { origin: 'https://example.test' } };
  global.document = { addEventListener() {} };
  global.chrome = {
    storage: { sync: { get: async () => ({ instances: {} }) } },
    runtime: {
      onMessage: { addListener(listener) { messageListener = listener; } },
      sendMessage() {},
    },
  };
  global.fetch = async (_url, options) => {
    const fields = new URLSearchParams(String(options.body));
    const command = fields.get('code');
    const params = JSON.parse(fields.get('params'));
    requests.push({ command, params });
    const body = command === 'REPOS.FIND_OBJECTS'
      ? { result: 1, data: { children: [{ id: 77, kind: 'REP', name: '[tmp] отчёт' }] } }
      : { result: 1 };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    };
  };

  delete require.cache[require.resolve('../content/content.js')];
  require('../content/content.js');

  const preview = await new Promise((resolve) => {
    assert.equal(messageListener({
      action: 'previewObjectCleanup',
      settings: {
        objectTypes: ['REP'],
        locations: ['REC_BIN'],
        mask: '[tmp]*',
        force: true,
      },
    }, {}, resolve), true);
  });
  assert.equal(preview.success, true);
  assert.equal(preview.items[0].id, 77);

  const deletion = await new Promise((resolve) => {
    assert.equal(messageListener({
      action: 'deleteCleanupObjects',
      items: [{ id: 77, name: '[tmp] отчёт', force: false }],
    }, {}, resolve), true);
  });
  assert.equal(deletion.success, true);
  assert.equal(deletion.results[0].success, true);
  assert.deepEqual(requests.map(({ command }) => command), [
    'REPOS.FIND_OBJECTS',
    'REPOS.DEL_USER_OBJ',
  ]);
  assert.deepEqual(requests[1].params, { id: 77, force: 0, isFullDelete: 0 });
});
