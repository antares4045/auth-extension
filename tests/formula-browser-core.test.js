const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const FormulaBrowserCore = require('../content/formula-browser-core.js');

test('различает неограниченный, ограниченный и повреждённый предел вложенности', () => {
  assert.deepEqual(FormulaBrowserCore.parseExpansionDepth(undefined), { kind: 'unlimited' });
  assert.deepEqual(FormulaBrowserCore.parseExpansionDepth(null), { kind: 'unlimited' });
  assert.deepEqual(FormulaBrowserCore.parseExpansionDepth(''), { kind: 'unlimited' });
  assert.deepEqual(FormulaBrowserCore.parseExpansionDepth(0), { kind: 'invalid' });
  assert.deepEqual(FormulaBrowserCore.parseExpansionDepth(-2), { kind: 'invalid' });
  assert.deepEqual(FormulaBrowserCore.parseExpansionDepth('не число'), { kind: 'invalid' });
  assert.deepEqual(FormulaBrowserCore.parseExpansionDepth(2.8), { kind: 'invalid' });
  assert.deepEqual(FormulaBrowserCore.parseExpansionDepth('3'), { kind: 'limited', value: 3 });
});

test('ограничивает подпись длинного списка DP-источников до объединения строки', () => {
  const sources = Array.from({ length: 10000 }, (_, index) => ({
    dpName: `Очень длинный источник ${index}`,
  }));

  const summary = FormulaBrowserCore.summarizeSourceNames(sources, {
    maxItems: 3,
    maxLength: 60,
  });

  assert.ok(summary.length < 90);
  assert.match(summary, /… \+9998$/);
  assert.doesNotMatch(summary, /источник 9999/);
});

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

test('считает пользовательский предел по раскрытым уровням без скрытого смещения', () => {
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

  assert.deepEqual(model.expandFormula('v0', { maxDepth: 1 }), {
    formula: '=(([V2]))',
    warnings: ['Достигнут предел раскрытия (1): V2'],
  });
});

test('останавливает неограниченную цепочку на техническом пределе до переполнения стека', () => {
  const variables = Array.from({ length: 2000 }, (_, index) => ({
    id: `v${index}`,
    name: `V${index}`,
    formula: `=[V${index + 1}]`,
    parsedFormula: {
      root: { nodeType: 'var', varId: `v${index + 1}`, literal: `V${index + 1}` },
    },
  }));
  variables.push({
    id: 'v2000', name: 'V2000', varType: 'DP', formula: '=[V2000]',
  });

  const expansion = FormulaBrowserCore.createModel(variables, [])
    .expandFormula('v0', { maxDepth: Infinity });

  assert.match(expansion.formula, /\[V\d+\]/);
  assert.match(expansion.warnings.join('\n'), /технический предел безопасного раскрытия/);
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

test('разбивает формулу на синтаксические токены и сохраняет точный varId из AST', () => {
  const variables = [
    { id: 'income', name: 'Доход с НДС', type: 'Measure', varType: 'DP' },
  ];
  const root = {
    nodeType: 'function',
    args: [{
      nodeType: 'var',
      varId: 'income',
      literal: 'Доход с НДС',
      start: 4,
      length: 13,
    }],
  };
  const model = FormulaBrowserCore.createModel(variables, []);

  assert.deepEqual(
    model.tokenizeFormula("=if([Доход с НДС]>10,'[не переменная]',0)", root)
      .filter((token) => token.kind !== 'whitespace'),
    [
      { kind: 'operator', text: '=', start: 0, length: 1 },
      { kind: 'function', text: 'if', start: 1, length: 2 },
      { kind: 'punctuation', text: '(', start: 3, length: 1 },
      {
        kind: 'variable', text: '[Доход с НДС]', start: 4, length: 13,
        variableId: 'income', candidateIds: ['income'], variableType: 'Measure',
      },
      { kind: 'operator', text: '>', start: 17, length: 1 },
      { kind: 'number', text: '10', start: 18, length: 2 },
      { kind: 'punctuation', text: ',', start: 20, length: 1 },
      { kind: 'string', text: "'[не переменная]'", start: 21, length: 17 },
      { kind: 'punctuation', text: ',', start: 38, length: 1 },
      { kind: 'number', text: '0', start: 39, length: 1 },
      { kind: 'punctuation', text: ')', start: 40, length: 1 },
    ],
  );
});

test('находит ссылки по имени в раскрытой формуле и не ломается на одноимённых переменных', () => {
  const model = FormulaBrowserCore.createModel([
    { id: 'a', name: 'Источник', type: 'Dimension', varType: 'DP' },
    { id: 'b', name: 'Источник', type: 'Attribute', varType: 'FutureType' },
  ], []);

  const variable = model.tokenizeFormula('=[Источник]', null)[1];
  assert.deepEqual(variable, {
    kind: 'variable', text: '[Источник]', start: 1, length: 10,
    variableId: null, candidateIds: ['a', 'b'], variableType: 'unknown',
  });
});

test('возвращает зоны прямых переменных в координатах полностью раскрытой формулы', () => {
  const variables = [
    {
      id: 'root', name: 'Root', formula: '=[Left]+[Right]',
      parsedFormula: {
        root: { nodeType: 'function', args: [
          { nodeType: 'var', varId: 'left', literal: 'Left', start: 1, length: 6 },
          { nodeType: 'var', varId: 'right', literal: 'Right', start: 8, length: 7 },
        ] },
      },
    },
    { id: 'left', name: 'Left', formula: '=1', parsedFormula: { root: null } },
    { id: 'right', name: 'Right', formula: '=22', parsedFormula: { root: null } },
  ];
  const model = FormulaBrowserCore.createModel(variables, []);

  assert.deepEqual(model.expandFormulaDetailed('root'), {
    formula: '=(1)+(22)',
    warnings: [],
    zones: [
      { start: 1, length: 3, variableId: 'left', label: 'Left' },
      { start: 5, length: 4, variableId: 'right', label: 'Right' },
    ],
    allZones: [
      { start: 1, length: 3, variableId: 'left', label: 'Left' },
      { start: 5, length: 4, variableId: 'right', label: 'Right' },
    ],
  });
});

test('возвращает вложенные зоны всех уровней, включая терминальный DP-лист', () => {
  const variables = [
    {
      id: 'root', name: 'Root', formula: '=[Middle]+1',
      parsedFormula: { root: {
        nodeType: 'var', varId: 'middle', literal: 'Middle', start: 1, length: 8,
      } },
    },
    {
      id: 'middle', name: 'Middle', formula: '=[Leaf]+2',
      parsedFormula: { root: {
        nodeType: 'var', varId: 'leaf', literal: 'Leaf', start: 1, length: 6,
      } },
    },
    { id: 'leaf', name: 'Leaf', varType: 'DP', formula: '=[Leaf]' },
  ];
  const model = FormulaBrowserCore.createModel(variables, []);

  assert.deepEqual(model.expandFormulaDetailed('root'), {
    formula: '=([Leaf]+2)+1',
    warnings: [],
    zones: [
      { start: 1, length: 10, variableId: 'middle', label: 'Middle' },
    ],
    allZones: [
      { start: 1, length: 10, variableId: 'middle', label: 'Middle' },
      { start: 2, length: 6, variableId: 'leaf', label: 'Leaf' },
    ],
  });
});

test('ограничивает число зон для формулы с множеством терминальных ссылок', () => {
  const leafVariables = Array.from({ length: 8 }, (_, index) => ({
    id: `leaf-${index}`,
    name: `Leaf ${index}`,
    varType: 'DP',
  }));
  const formula = `=${leafVariables.map((variable) => `[${variable.name}]`).join('+')}`;
  const args = [];
  let cursor = 1;
  leafVariables.forEach((variable) => {
    const literal = `[${variable.name}]`;
    args.push({
      nodeType: 'var',
      varId: variable.id,
      literal: variable.name,
      start: cursor,
      length: literal.length,
    });
    cursor += literal.length + 1;
  });
  const model = FormulaBrowserCore.createModel([
    {
      id: 'root', name: 'Root', formula,
      parsedFormula: { root: { nodeType: 'function', args } },
    },
    ...leafVariables,
  ], []);

  const expansion = model.expandFormulaDetailed('root', { maxZones: 3 });

  assert.equal(expansion.formula, formula);
  assert.equal(expansion.zones.length, 3);
  assert.equal(expansion.allZones.length, 3);
  assert.match(expansion.warnings.join('\n'), /предел зонирования \(3\)/);
});

test('вложенные зоны не вытесняют соседей из режима верхнего уровня', () => {
  const model = FormulaBrowserCore.createModel([
    {
      id: 'root', name: 'Root', formula: '=[A]+[B]',
      parsedFormula: { root: { nodeType: 'function', args: [
        { nodeType: 'var', varId: 'a', literal: 'A', start: 1, length: 3 },
        { nodeType: 'var', varId: 'b', literal: 'B', start: 5, length: 3 },
      ] } },
    },
    {
      id: 'a', name: 'A', formula: '=[Leaf]',
      parsedFormula: { root: {
        nodeType: 'var', varId: 'leaf', literal: 'Leaf', start: 1, length: 6,
      } },
    },
    { id: 'b', name: 'B', formula: '=2', parsedFormula: { root: null } },
    { id: 'leaf', name: 'Leaf', varType: 'DP' },
  ], []);

  const expansion = model.expandFormulaDetailed('root', { maxZones: 2 });

  assert.deepEqual(
    expansion.zones.map((zone) => zone.variableId),
    ['a', 'b'],
  );
  assert.deepEqual(
    expansion.allZones.map((zone) => zone.variableId),
    ['a', 'leaf'],
  );
});

test('неуспешная ссылка не расходует зону следующей корректной переменной', () => {
  const model = FormulaBrowserCore.createModel([
    {
      id: 'root', name: 'Root', formula: '=[A]+[B]',
      parsedFormula: { root: { nodeType: 'function', args: [
        { nodeType: 'var', varId: 'a', literal: 'A', start: 1, length: 3 },
        { nodeType: 'var', varId: 'b', literal: 'B', start: 5, length: 3 },
      ] } },
    },
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B', formula: '=2', parsedFormula: { root: null } },
  ], []);

  const expansion = model.expandFormulaDetailed('root', { maxZones: 1 });

  assert.equal(expansion.formula, '=[A]+(2)');
  assert.deepEqual(expansion.zones.map((zone) => zone.variableId), ['b']);
  assert.deepEqual(expansion.allZones.map((zone) => zone.variableId), ['b']);
});

test('поиск принимает имя с одной или двумя квадратными скобками', () => {
  const model = FormulaBrowserCore.createModel([
    { id: 'income', name: 'Доход с НДС' },
  ], []);

  assert.equal(model.findVariable('Доход с НДС').id, 'income');
  assert.equal(model.findVariable('[Доход с НДС]').id, 'income');
  assert.equal(model.findVariable('[Доход с НДС').id, 'income');
  assert.equal(model.findVariable('Доход с НДС]').id, 'income');
  assert.equal(model.findVariable('income').id, 'income');
});

test('игнорирует повреждённые координаты AST и находит ссылку по литералу', () => {
  const model = FormulaBrowserCore.createModel([
    { id: 'root', name: 'Root', formula: '=[Child]+1', parsedFormula: {
      root: { nodeType: 'var', varId: 'child', literal: 'Child', start: 999, length: -4 },
    } },
    { id: 'child', name: 'Child', formula: '=2', parsedFormula: { root: null } },
  ], []);

  assert.equal(model.expandFormula('root').formula, '=(2)+1');
});

test('индексирует формулу один раз для множества повреждённых ссылок', () => {
  const formula = `=${'x'.repeat(149999)}`;
  const references = Array.from({ length: 5000 }, () => ({
    nodeType: 'var', varId: 'child', literal: 'Missing', start: -1, length: 0,
  }));
  const model = FormulaBrowserCore.createModel([
    {
      id: 'root', name: 'Root', formula,
      parsedFormula: { root: { nodeType: 'function', args: references } },
    },
    { id: 'child', name: 'Child', formula: '=2', parsedFormula: { root: null } },
  ], []);

  const startedAt = performance.now();
  const expansion = model.expandFormula('root');
  const elapsed = performance.now() - startedAt;

  assert.equal(expansion.formula, formula);
  assert.ok(elapsed < 1000, `fallback-поиск занял ${Math.round(elapsed)} мс`);
});

test('собирает уникальные DP-источники через вложенные и Merge-переменные', () => {
  const model = FormulaBrowserCore.createModel([
    {
      id: 'root', name: 'Root', varType: 'General',
      parsedFormula: { root: { nodeType: 'function', args: [
        { nodeType: 'var', varId: 'nested', literal: 'Nested' },
        { nodeType: 'var', varId: 'merge', literal: 'Merge' },
      ] } },
    },
    {
      id: 'nested', name: 'Nested', varType: 'FutureType',
      parsedFormula: { root: { nodeType: 'function', args: [
        { nodeType: 'var', varId: 'dp-a', literal: 'A' },
        { nodeType: 'var', varId: 'root', literal: 'Root' },
      ] } },
    },
    { id: 'dp-a', name: 'A', varType: 'DP', dp_id: 'DP1' },
    { id: 'merge', name: 'Merge', varType: 'Merge', merge: [
      { dp_id: 'DP1', dpObject_id: 'DP1.1' },
      { dp_id: 'DP2', dpObject_id: 'DP2.2' },
    ] },
  ], [
    { dp_id: 'DP1', dpName: 'Продажи' },
    { dp_id: 'DP2', dpName: 'Возвраты' },
  ]);

  assert.deepEqual(model.getDependencySources('root'), [
    { dpId: 'DP1', dpName: 'Продажи', objectId: 'DP1.1' },
    { dpId: 'DP2', dpName: 'Возвраты', objectId: 'DP2.2' },
    { dpId: 'DP1', dpName: 'Продажи', objectId: 'dp-a' },
  ]);
  assert.deepEqual(model.getDependencySourceInfo('root', { maxNodes: 1 }), {
    sources: [],
    truncated: true,
  });
});
