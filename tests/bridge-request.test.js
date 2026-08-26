const test = require('node:test');
const assert = require('node:assert/strict');

test('REP.VALIDATE_FORMULA кодирует пробелы в JSON-параметре как %20', async () => {
  let capturedRequest;
  const values = new Map([
    ['token', '<TEST_TOKEN>'],
    ['receiver', 'report'],
    ['streamreceiver', 'stream'],
  ]);

  global.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: () => {},
  };
  global.sessionStorage = {
    getItem: (key) => values.get(key) ?? null,
  };
  global.window = { location: { origin: 'https://example.test' } };
  global.document = { addEventListener: () => {} };
  global.chrome = {
    storage: {
      sync: {
        get: async () => ({ instances: {} }),
      },
    },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: () => {},
    },
  };
  global.fetch = async (url, options) => {
    capturedRequest = { url, options };
    return {
      ok: true,
      status: 200,
      text: async () => '{"result":1,"isValid":1}',
    };
  };

  delete require.cache[require.resolve('../content/content.js')];
  require('../content/content.js');

  await global.AuthInjectorBridge.requestJson(
    'REP.VALIDATE_FORMULA',
    { formula: '=[Доход с НДС (сравн)]+[Доход с НДС услуги (сравн)]' },
    true,
  );

  const body = String(capturedRequest.options.body);
  const encodedParams = body.split('&').find((part) => part.startsWith('params='));
  assert.ok(encodedParams, 'params должен присутствовать в теле запроса');
  assert.match(encodedParams, /%20/);
  assert.doesNotMatch(encodedParams, /\+/);
});

test('API-мост отменяет зависший запрос по таймауту', async () => {
  global.localStorage = {
    getItem: (key) => key === 'token' ? '<TEST_TOKEN>' : null,
    setItem: () => {},
  };
  global.sessionStorage = { getItem: () => null };
  global.window = { location: { origin: 'https://example.test' } };
  global.document = { addEventListener: () => {} };
  global.chrome = {
    storage: { sync: { get: async () => ({ instances: {} }) } },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: () => {},
    },
  };
  global.fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  delete require.cache[require.resolve('../content/content.js')];
  require('../content/content.js');

  await assert.rejects(
    global.AuthInjectorBridge.requestJson(
      'REP.GET_VARIABLES',
      {},
      false,
      { timeoutMs: 5 },
    ),
    /превышено время ожидания/,
  );
});
