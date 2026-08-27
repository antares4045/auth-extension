const test = require('node:test');
const assert = require('node:assert/strict');

const Cleanup = require('../content/object-cleanup-core.js');

test('строит параметры REPOS.FIND_OBJECTS с серверной маской и фильтром расположения', () => {
  assert.deepEqual(Cleanup.buildFindParams({
    objectTypes: ['UNV', 'REP'],
    locations: ['REC_BIN'],
    mask: '[tmp]*',
    force: true,
  }, 'REC_BIN'), {
    searchType: 'MASK',
    searchMask: ['[tmp]*'],
    kindsFilter: ['SL', 'REP'],
    folderRoleFilter: {
      rightFilters: ['USER'],
      kindFilters: ['UNV', 'REP'],
      specFilters: ['REC_BIN'],
    },
    sort: { field: 'id', sortDirection: 'ASC' },
    treeResult: 0,
  });
});

test('отделяет виды объектов от видов ролей папок', () => {
  const params = Cleanup.buildFindParams({
    objectTypes: ['UNV', 'CN', 'REP'],
    locations: ['USER'],
    mask: '*',
    force: false,
  }, 'USER');

  assert.deepEqual(params.kindsFilter, ['SL', 'CN', 'REP']);
  assert.deepEqual(params.folderRoleFilter.kindFilters, ['UNV', 'CN', 'REP']);
});

test('собирает найденные файлы, включая вложенный древовидный ответ', async () => {
  const calls = [];
  const requestJson = async (command, params) => {
    calls.push({ command, params });
    return {
      result: 1,
      data: {
        children: [
          {
            id: 3,
            kind: 'FLD',
            name: '[tmp] папка',
            elements: [{ id: 1, kind: 'REP', name: '[tmp] первый', path: '/вложенная' }],
          },
        ],
      },
    };
  };

  const result = await Cleanup.collectCandidates({
    objectTypes: ['REP'],
    locations: ['REC_BIN'],
    mask: '[tmp]*',
    force: true,
  }, requestJson);

  assert.deepEqual(result, {
    items: [{
      id: 1,
      name: '[tmp] первый',
      kind: 'REP',
      location: 'REC_BIN',
      path: '/вложенная',
      force: true,
    }],
    warnings: [],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'REPOS.FIND_OBJECTS');
  assert.deepEqual(calls[0].params.searchMask, ['[tmp]*']);
  assert.deepEqual(calls[0].params.folderRoleFilter, {
    rightFilters: ['USER'],
    kindFilters: ['REP'],
    specFilters: ['REC_BIN'],
  });
});

test('возвращает частичный результат и предупреждение при недоступной папке', async () => {
  const requestJson = async (command, params) => {
    if (params.folderRoleFilter.rightFilters[0] === 'PUBLIC') {
      return { result: 0, errors: [{ text: 'Нет доступа' }] };
    }
    return { result: 1, data: { children: [{ id: 1, kind: 'REP', name: 'test' }] } };
  };

  const result = await Cleanup.collectCandidates({
    objectTypes: ['REP'],
    locations: ['USER', 'PUBLIC'],
    mask: '*',
    force: false,
  }, requestJson);

  assert.equal(result.items.length, 1);
  assert.deepEqual(result.warnings, ['Общие папки: Нет доступа']);
});

test('объединяет результаты разных расположений в глобальном порядке id', async () => {
  const requestJson = async (_command, params) => {
    const isPublic = params.folderRoleFilter.rightFilters[0] === 'PUBLIC';
    return {
      result: 1,
      data: {
        children: [{
          id: isPublic ? 2 : 10,
          kind: 'REP',
          name: isPublic ? 'общий' : 'личный',
        }],
      },
    };
  };

  const result = await Cleanup.collectCandidates({
    objectTypes: ['REP'],
    locations: ['USER', 'PUBLIC'],
    mask: '*',
    force: false,
  }, requestJson);

  assert.deepEqual(result.items.map(({ id }) => id), [2, 10]);
});

test('удаляет последовательно с индивидуальным признаком force и продолжает после ошибки', async () => {
  const calls = [];
  const requestJson = async (command, params) => {
    calls.push({ command, params });
    if (params.id === 2) return { result: 0, errors: [{ reason: 'Заблокирован' }] };
    return { result: 1 };
  };

  const results = await Cleanup.deleteCandidates([
    { id: 1, name: 'навсегда', force: true },
    { id: 2, name: 'в корзину', force: false },
    { id: 3, name: 'тоже в корзину' },
  ], requestJson);

  assert.deepEqual(calls, [
    {
      command: 'REPOS.DEL_USER_OBJ',
      params: { id: 1, force: 1, isFullDelete: 1 },
    },
    {
      command: 'REPOS.DEL_USER_OBJ',
      params: { id: 2, force: 0, isFullDelete: 0 },
    },
    {
      command: 'REPOS.DEL_USER_OBJ',
      params: { id: 3, force: 0, isFullDelete: 0 },
    },
  ]);
  assert.deepEqual(results.map(({ success, error }) => ({ success, error })), [
    { success: true, error: undefined },
    { success: false, error: 'Заблокирован' },
    { success: true, error: undefined },
  ]);
});
