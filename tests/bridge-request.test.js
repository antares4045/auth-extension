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
  global.fetch = async (url, options) => ({
    ok: true,
    status: 200,
    text: () => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });

  delete require.cache[require.resolve('../content/content.js')];
  require('../content/content.js');

  const request = global.AuthInjectorBridge.requestJson(
      'REP.GET_VARIABLES',
      {},
      false,
      { timeoutMs: 5 },
    );
  const result = await Promise.race([
    request.then(
      () => ({ settled: true, error: null }),
      (error) => ({ settled: true, error }),
    ),
    new Promise((resolve) => setTimeout(
      () => resolve({ settled: false, error: null }),
      50,
    )),
  ]);

  assert.equal(result.settled, true, 'таймаут не охватил чтение тела ответа');
  assert.match(String(result.error), /превышено время ожидания/);
});

test('просроченное переключение движка не отправляет запрос к отчёту', async () => {
  let messageListener;
  let fetchCalls = 0;
  global.localStorage = {
    getItem: (key) => key === 'token' ? '<TEST_TOKEN>' : null,
    setItem: () => {},
  };
  global.sessionStorage = {
    getItem: (key) => key === 'receiver' || key === 'streamreceiver' ? key : null,
  };
  global.window = { location: { origin: 'https://example.test' } };
  global.document = { addEventListener: () => {} };
  global.chrome = {
    storage: { sync: { get: async () => ({ instances: {} }) } },
    runtime: {
      onMessage: { addListener(listener) { messageListener = listener; } },
      sendMessage: () => {},
    },
  };
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error('fetch не должен вызываться после дедлайна');
  };

  delete require.cache[require.resolve('../content/content.js')];
  require('../content/content.js');

  const response = await new Promise((resolve) => {
    const asynchronous = messageListener(
      { action: 'toggleSetting', deadline: Date.now() - 1 },
      {},
      resolve,
    );
    assert.equal(asynchronous, true);
  });

  assert.equal(response.success, false);
  assert.match(response.error, /Истекло время операции/);
  assert.equal(fetchCalls, 0);
});
