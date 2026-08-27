const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BACKUP_SCHEMA,
  BACKUP_VERSION,
  createBackup,
  parseBackup,
  importBackup,
} = require('../popup/settings-transfer.js');

test('экспорт сохраняет все данные storage.sync и назначенные хоткеи', () => {
  const backup = createBackup(
    {
      instances: { 'https://example.test': { login: 'user', password: 'secret' } },
      activeInstances: ['https://example.test'],
      formulaBrowserSettings: { maxDepth: 3 },
      cleanupSettings: {
        objectTypes: ['REP'],
        locations: ['REC_BIN'],
        mask: '[tmp]*',
        force: true,
      },
    },
    [{ name: 'open-formula-browser', shortcut: 'Alt+V' }],
    '2026-08-26T10:00:00.000Z',
  );

  assert.deepEqual(backup, {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    exportedAt: '2026-08-26T10:00:00.000Z',
    storageSync: {
      instances: { 'https://example.test': { login: 'user', password: 'secret' } },
      activeInstances: ['https://example.test'],
      formulaBrowserSettings: { maxDepth: 3 },
      cleanupSettings: {
        objectTypes: ['REP'],
        locations: ['REC_BIN'],
        mask: '[tmp]*',
        force: true,
      },
    },
    shortcuts: { 'open-formula-browser': 'Alt+V' },
  });
});

test('парсер отклоняет файл другого формата до изменения настроек', () => {
  assert.throws(
    () => parseBackup(JSON.stringify({ schema: 'other-extension', version: 1 })),
    /не является резервной копией Universal Auth Injector/,
  );
});

test('импорт полностью заменяет storage.sync и восстанавливает хоткей, когда API это умеет', async () => {
  let stored = { obsolete: true, instances: { old: true } };
  const updates = [];
  const storageArea = {
    async get() { return structuredClone(stored); },
    async set(value) { stored = { ...stored, ...structuredClone(value) }; },
    async remove(keys) { for (const key of keys) delete stored[key]; },
  };
  const commandsApi = {
    async getAll() { return [{ name: 'open-formula-browser', shortcut: 'Ctrl+X' }]; },
    async update(value) { updates.push(value); },
  };
  const backup = createBackup(
    { instances: { new: true }, activeInstances: ['new'] },
    [{ name: 'open-formula-browser', shortcut: 'Alt+V' }],
    '2026-08-26T10:00:00.000Z',
  );

  const result = await importBackup(backup, { storageArea, commandsApi });

  assert.deepEqual(stored, {
    instances: { new: true },
    activeInstances: ['new'],
  });
  assert.deepEqual(updates, [{ name: 'open-formula-browser', shortcut: 'Alt+V' }]);
  assert.deepEqual(result, { manualShortcuts: [], skippedShortcuts: [] });
});

test('импорт сообщает хоткей для ручного назначения в Chromium', async () => {
  let stored = {};
  const backup = createBackup(
    { activeInstances: [] },
    [{ name: 'open-formula-browser', shortcut: 'Alt+V' }],
    '2026-08-26T10:00:00.000Z',
  );

  const result = await importBackup(backup, {
    storageArea: {
      async get() { return stored; },
      async set(value) { stored = { ...stored, ...value }; },
      async remove(keys) { for (const key of keys) delete stored[key]; },
    },
    commandsApi: {
      async getAll() { return [{ name: 'open-formula-browser', shortcut: '' }]; },
    },
  });

  assert.deepEqual(result, {
    manualShortcuts: [{ name: 'open-formula-browser', shortcut: 'Alt+V' }],
    skippedShortcuts: [],
  });
});

test('импорт явно сообщает о хоткее неизвестной команды', async () => {
  const backup = createBackup(
    { activeInstances: [] },
    [{ name: 'future-command', shortcut: 'Alt+F' }],
    '2026-08-26T10:00:00.000Z',
  );

  const result = await importBackup(backup, {
    storageArea: {
      async get() { return {}; },
      async set() {},
      async remove() {},
    },
    commandsApi: {
      async getAll() { return [{ name: 'open-formula-browser', shortcut: 'Alt+V' }]; },
    },
  });

  assert.deepEqual(result, {
    manualShortcuts: [],
    skippedShortcuts: [{ name: 'future-command', shortcut: 'Alt+F' }],
  });
});

test('при ошибке записи импорт возвращает прежнее содержимое storage.sync', async () => {
  const original = { instances: { old: true } };
  let stored = structuredClone(original);
  let shouldFail = true;
  const backup = createBackup(
    { instances: { new: true } },
    [],
    '2026-08-26T10:00:00.000Z',
  );

  await assert.rejects(
    importBackup(backup, {
      storageArea: {
        async get() { return structuredClone(stored); },
        async set(value) {
          if (shouldFail) {
            shouldFail = false;
            throw new Error('quota exceeded');
          }
          stored = { ...stored, ...structuredClone(value) };
        },
        async remove(keys) { for (const key of keys) delete stored[key]; },
      },
      commandsApi: { async getAll() { return []; } },
    }),
    /quota exceeded/,
  );

  assert.deepEqual(stored, original);
});

test('ошибка восстановления хоткея не изменяет storage.sync', async () => {
  const original = { instances: { old: true } };
  let stored = structuredClone(original);
  const backup = createBackup(
    { instances: { new: true } },
    [{ name: 'open-formula-browser', shortcut: 'Alt+V' }],
    '2026-08-26T10:00:00.000Z',
  );

  await assert.rejects(
    importBackup(backup, {
      storageArea: {
        async get() { return structuredClone(stored); },
        async set(value) { stored = { ...stored, ...structuredClone(value) }; },
        async remove(keys) { for (const key of keys) delete stored[key]; },
      },
      commandsApi: {
        async getAll() { return [{ name: 'open-formula-browser', shortcut: 'Ctrl+X' }]; },
        async update() { throw new Error('shortcut conflict'); },
      },
    }),
    /shortcut conflict/,
  );

  assert.deepEqual(stored, original);
});
