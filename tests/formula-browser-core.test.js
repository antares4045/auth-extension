const test = require('node:test');
const assert = require('node:assert/strict');

const FormulaBrowserCore = require('../content/formula-browser-core.js');

test('показывает прямые зависимости в порядке формулы без повторов', () => {
  const variables = [
    {
      id: 'root',
      name: 'Итого',
      parsedFormula: {
        root: {
          nodeType: 'function',
          args: [
            { nodeType: 'var', varId: 'a', literal: 'Продажи' },
            { nodeType: 'var', varId: 'b', literal: 'Возвраты' },
            { nodeType: 'var', varId: 'a', literal: 'Продажи' },
          ],
        },
      },
    },
    { id: 'a', name: 'Продажи' },
    { id: 'b', name: 'Возвраты' },
  ];

  const model = FormulaBrowserCore.createModel(variables, []);

  assert.deepEqual(
    model.getDependencies('root').map((variable) => variable.id),
    ['a', 'b'],
  );
});

test('полностью раскрывает пользовательские переменные до DP-листьев', () => {
  const variables = [
    {
      id: 'root',
      name: 'Итого',
      formula: '=[Промежуточная]+[Источник B]',
      parsedFormula: {
        root: {
          nodeType: 'function',
          args: [
            { nodeType: 'var', varId: 'middle', literal: 'Промежуточная' },
            { nodeType: 'var', varId: 'dp-b', literal: 'Источник B' },
          ],
        },
      },
    },
    {
      id: 'middle',
      name: 'Промежуточная',
      formula: '=[Источник A]*2',
      parsedFormula: {
        root: {
          nodeType: 'function',
          args: [{ nodeType: 'var', varId: 'dp-a', literal: 'Источник A' }],
        },
      },
    },
    { id: 'dp-a', name: 'Источник A', varType: 'DP', formula: '=[Источник A]' },
    { id: 'dp-b', name: 'Источник B', varType: 'DP', formula: '=[Источник B]' },
  ];

  const model = FormulaBrowserCore.createModel(variables, []);

  assert.deepEqual(model.expandFormula('root'), {
    formula: '=([Источник A]*2)+[Источник B]',
    warnings: [],
  });
});

test('останавливает раскрытие циклической ссылки и сообщает путь цикла', () => {
  const variables = [
    {
      id: 'a',
      name: 'A',
      formula: '=[B]+1',
      parsedFormula: { root: { nodeType: 'var', varId: 'b', literal: 'B' } },
    },
    {
      id: 'b',
      name: 'B',
      formula: '=[A]+2',
      parsedFormula: { root: { nodeType: 'var', varId: 'a', literal: 'A' } },
    },
  ];

  const model = FormulaBrowserCore.createModel(variables, []);

  assert.deepEqual(model.expandFormula('a'), {
    formula: '=(([A])+2)+1',
    warnings: ['Циклическая ссылка: A → B → A'],
  });
});

test('связывает DP и Merge переменные с названиями источников', () => {
  const variables = [
    {
      id: 'DP1.42',
      name: 'Продажи.Сумма',
      varType: 'DP',
      dp_id: 'DP1',
    },
    {
      id: 'merge',
      name: 'Общая дата',
      varType: 'Merge',
      merge: [
        { dp_id: 'DP1', dpObject_id: 'DP1.7' },
        { dp_id: 'DP2', dpObject_id: 'DP2.9' },
      ],
    },
  ];
  const dps = [
    { dp_id: 'DP1', dpName: 'Продажи' },
    { dp_id: 'DP2', dpName: 'Возвраты' },
  ];

  const model = FormulaBrowserCore.createModel(variables, dps);

  assert.deepEqual(model.getSourceInfo('DP1.42'), {
    kind: 'DP',
    sources: [{ dpId: 'DP1', dpName: 'Продажи', objectId: 'DP1.42' }],
  });
  assert.deepEqual(model.getSourceInfo('merge'), {
    kind: 'Merge',
    sources: [
      { dpId: 'DP1', dpName: 'Продажи', objectId: 'DP1.7' },
      { dpId: 'DP2', dpName: 'Возвраты', objectId: 'DP2.9' },
    ],
  });
});

test('раскрывает ссылки из проверенной произвольной формулы', () => {
  const variables = [
    {
      id: 'total',
      name: 'Итого',
      formula: '=[Источник]*2',
      parsedFormula: {
        root: { nodeType: 'var', varId: 'dp', literal: 'Источник' },
      },
    },
    { id: 'dp', name: 'Источник', varType: 'DP', formula: '=[Источник]' },
  ];
  const expressionTree = {
    nodeType: 'function',
    args: [{ nodeType: 'var', varId: 'total', literal: 'Итого' }],
  };

  const model = FormulaBrowserCore.createModel(variables, []);

  assert.deepEqual(model.expandExpression('=[Итого]*100', expressionTree), {
    formula: '=([Источник]*2)*100',
    warnings: [],
  });
});

test('ограничивает глубину раскрытия длинной цепочки', () => {
  const variables = [
    {
      id: 'v0', name: 'V0', formula: '=[V1]',
      parsedFormula: { root: { nodeType: 'var', varId: 'v1', literal: 'V1' } },
    },
    {
      id: 'v1', name: 'V1', formula: '=[V2]',
      parsedFormula: { root: { nodeType: 'var', varId: 'v2', literal: 'V2' } },
    },
    {
      id: 'v2', name: 'V2', formula: '=[Источник]',
      parsedFormula: { root: { nodeType: 'var', varId: 'dp', literal: 'Источник' } },
    },
    { id: 'dp', name: 'Источник', varType: 'DP', formula: '=[Источник]' },
  ];

  const model = FormulaBrowserCore.createModel(variables, []);

  assert.deepEqual(model.expandFormula('v0', { maxDepth: 2 }), {
    formula: '=(([V2]))',
    warnings: ['Достигнут предел раскрытия (2): V2'],
  });
});

test('не подставляет имя переменной внутри строковой константы', () => {
  const variables = [
    {
      id: 'a',
      name: 'A',
      formula: '=[Источник]',
      parsedFormula: {
        root: { nodeType: 'var', varId: 'dp', literal: 'Источник', start: 1, length: 10 },
      },
    },
    { id: 'dp', name: 'Источник', varType: 'DP', formula: '=[Источник]' },
  ];
  const expression = "=if([A]='[A]',[A],0)";
  const tree = {
    nodeType: 'function',
    args: [
      { nodeType: 'var', varId: 'a', literal: 'A', start: 4, length: 3 },
      { nodeType: 'var', varId: 'a', literal: 'A', start: 14, length: 3 },
    ],
  };

  const model = FormulaBrowserCore.createModel(variables, []);

  assert.equal(
    model.expandExpression(expression, tree).formula,
    "=if(([Источник])='[A]',([Источник]),0)",
  );
});

test('считает техническую самоссылку Merge терминальным узлом, а не циклом', () => {
  const variables = [
    {
      id: 'merge',
      name: 'merge.Name',
      varType: 'Merge',
      formula: '=[merge.Name]',
      parsedFormula: {
        root: {
          nodeType: 'var',
          varId: 'merge',
          literal: 'merge.Name',
          start: 1,
          length: 12,
        },
      },
    },
  ];

  const model = FormulaBrowserCore.createModel(variables, []);

  assert.deepEqual(model.expandFormula('merge'), {
    formula: '=[merge.Name]',
    warnings: [],
  });
});

test('сохраняет неизвестную ссылку при полном раскрытии', () => {
  const tree = {
    nodeType: 'var',
    varId: 'missing-id',
    literal: 'Удалённая переменная',
    start: 1,
    length: 21,
  };
  const model = FormulaBrowserCore.createModel([], []);

  assert.deepEqual(model.expandExpression('=[Удалённая переменная]', tree), {
    formula: '=[Удалённая переменная]',
    warnings: ['Переменная не найдена: Удалённая переменная (missing-id)'],
  });
});

test('различает одноимённые ссылки с разными varId без координат AST', () => {
  const variables = [
    { id: 'first', name: 'X', formula: '=1', parsedFormula: { root: null } },
    { id: 'second', name: 'X', formula: '=2', parsedFormula: { root: null } },
  ];
  const tree = {
    nodeType: 'function',
    args: [
      { nodeType: 'var', varId: 'first', literal: 'X' },
      { nodeType: 'var', varId: 'second', literal: 'X' },
    ],
  };
  const model = FormulaBrowserCore.createModel(variables, []);

  assert.equal(model.expandExpression('=[X]+[X]', tree).formula, '=(1)+(2)');
});

test('ограничивает общее число подстановок в разветвлённой формуле', () => {
  const variables = [
    {
      id: 'root', name: 'Root', formula: '=[Child]+[Child]',
      parsedFormula: {
        root: {
          nodeType: 'function',
          args: [
            { nodeType: 'var', varId: 'child', literal: 'Child' },
            { nodeType: 'var', varId: 'child', literal: 'Child' },
          ],
        },
      },
    },
    { id: 'child', name: 'Child', formula: '=1', parsedFormula: { root: null } },
  ];
  const model = FormulaBrowserCore.createModel(variables, []);

  assert.deepEqual(model.expandFormula('root', { maxNodes: 1 }), {
    formula: '=(1)+([Child])',
    warnings: ['Достигнут предел раскрытия по количеству узлов (1)'],
  });
});

test('не падает на пустом Merge, неизвестном varType и повреждённых элементах ответа', () => {
  const model = FormulaBrowserCore.createModel(
    [
      null,
      { id: 'future', name: 'Future', varType: 'FutureType', parsedFormula: null },
      {
        id: 'empty-merge',
        name: 'Empty merge',
        varType: 'Merge',
        merge: [null, { dp_id: '   ', dpObject_id: 'broken' }],
      },
      { id: 'empty-dp', name: 'Empty DP', varType: 'DP', dp_id: '   ' },
      { name: 'Без идентификатора' },
    ],
    [null],
  );

  assert.deepEqual(model.getDependencies('future'), []);
  assert.deepEqual(model.expandFormula('future'), {
    formula: '',
    warnings: ['У переменной Future (future) отсутствует формула'],
  });
  assert.deepEqual(model.getSourceInfo('empty-merge'), {
    kind: 'Merge',
    sources: [],
  });
  assert.deepEqual(model.getSourceInfo('empty-dp'), {
    kind: 'DP',
    sources: [],
  });
});

test('ограничивает прямую и трёхзвенную рекурсию формул', () => {
  const direct = {
    id: 'self', name: 'Self', formula: '=[Self]',
    parsedFormula: { root: { nodeType: 'var', varId: 'self', literal: 'Self' } },
  };
  const chain = [
    {
      id: 'a', name: 'A', formula: '=[B]',
      parsedFormula: { root: { nodeType: 'var', varId: 'b', literal: 'B' } },
    },
    {
      id: 'b', name: 'B', formula: '=[C]',
      parsedFormula: { root: { nodeType: 'var', varId: 'c', literal: 'C' } },
    },
    {
      id: 'c', name: 'C', formula: '=[A]',
      parsedFormula: { root: { nodeType: 'var', varId: 'a', literal: 'A' } },
    },
  ];

  assert.deepEqual(FormulaBrowserCore.createModel([direct], []).expandFormula('self'), {
    formula: '=([Self])',
    warnings: ['Циклическая ссылка: Self → Self'],
  });
  assert.deepEqual(FormulaBrowserCore.createModel(chain, []).expandFormula('a'), {
    formula: '=((([A])))',
    warnings: ['Циклическая ссылка: A → B → C → A'],
  });
});

test('ограничивает огромную исходную формулу до начала раскрытия', () => {
  const model = FormulaBrowserCore.createModel([
    {
      id: 'huge',
      name: 'Huge',
      varType: 'DP',
      formula: `=${'1'.repeat(100)}`,
      parsedFormula: { root: null },
    },
  ], []);

  assert.deepEqual(model.expandFormula('huge', { maxLength: 10 }), {
    formula: '=111111111',
    warnings: ['Достигнут предел длины раскрытой формулы (10 символов)'],
  });
});

test('обходит повреждённый циклический AST без переполнения стека', () => {
  const root = { nodeType: 'function', args: [] };
  root.args.push(
    { nodeType: 'var', varId: 'a', literal: 'A' },
    root,
  );

  assert.deepEqual(FormulaBrowserCore.collectReferences(root), [
    { id: 'a', literal: 'A', start: undefined, length: undefined },
  ]);
});
