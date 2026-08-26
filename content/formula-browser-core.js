(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.FormulaBrowserCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function collectReferences(node, result = []) {
    const stack = node && typeof node === 'object' ? [node] : [];
    const visited = new WeakSet();
    let visitedCount = 0;

    while (stack.length && visitedCount < 50000) {
      const current = stack.pop();
      if (!current || typeof current !== 'object' || visited.has(current)) continue;
      visited.add(current);
      visitedCount += 1;

      if (current.nodeType === 'var' && current.varId) {
        result.push({
          id: current.varId,
          literal: current.literal || '',
          start: current.start,
          length: current.length,
        });
      }

      if (Array.isArray(current.args)) {
        for (let index = current.args.length - 1; index >= 0; index -= 1) {
          stack.push(current.args[index]);
        }
      }
    }

    return result;
  }

  function hasUsableId(value) {
    return value !== undefined && value !== null && String(value).trim().length > 0;
  }

  function normalizeVariableQuery(value) {
    return String(value || '')
      .trim()
      .replace(/^\[+/, '')
      .replace(/\]+$/, '')
      .trim()
      .toLocaleLowerCase('ru');
  }

  function createModel(variables = [], dps = []) {
    const validVariables = (Array.isArray(variables) ? variables : []).filter(
      (variable) =>
        variable &&
        typeof variable === 'object' &&
        hasUsableId(variable.id),
    );
    const validDps = (Array.isArray(dps) ? dps : []).filter(
      (dp) =>
        dp &&
        typeof dp === 'object' &&
        hasUsableId(dp.dp_id),
    );
    const variablesById = new Map(
      validVariables.map((variable) => [variable.id, variable]),
    );
    const variablesByName = new Map();
    validVariables.forEach((variable) => {
      if (typeof variable.name !== 'string' || !variable.name.length) return;
      const matches = variablesByName.get(variable.name) || [];
      matches.push(variable);
      variablesByName.set(variable.name, matches);
    });
    const dpsById = new Map(validDps.map((dp) => [dp.dp_id, dp]));

    function isTerminalVariable(variable) {
      return variable?.varType === 'DP' || variable?.varType === 'Merge';
    }

    function findVariable(query) {
      const raw = String(query || '').trim();
      if (!raw) return null;
      const direct = variablesById.get(raw) || validVariables.find(
        (variable) => String(variable.id) === raw,
      );
      if (direct) return direct;
      const normalized = normalizeVariableQuery(raw);
      return validVariables.find(
        (variable) => normalizeVariableQuery(variable.name || variable.id) === normalized,
      ) || validVariables.find(
        (variable) => normalizeVariableQuery(variable.name || variable.id).includes(normalized),
      ) || null;
    }

    function findUnquotedVariable(formula, literal, fromIndex) {
      const target = `[${literal}]`;
      let inString = false;

      for (let index = fromIndex; index <= formula.length - target.length; index += 1) {
        if (formula[index] === "'") {
          if (inString && formula[index + 1] === "'") {
            index += 1;
          } else {
            inString = !inString;
          }
          continue;
        }
        if (!inString && formula.startsWith(target, index)) return index;
      }

      return -1;
    }

    function getDependencies(variableId) {
      const variable = variablesById.get(variableId);
      if (isTerminalVariable(variable)) return [];
      const references = collectReferences(variable?.parsedFormula?.root);
      const seen = new Set();

      return references.flatMap((reference) => {
        if (seen.has(reference.id)) return [];
        seen.add(reference.id);
        const dependency = variablesById.get(reference.id);
        return dependency ? [dependency] : [];
      });
    }

    function getSourceInfo(variableId) {
      const variable = variablesById.get(variableId);
      if (!variable) return null;

      const toSource = (dpId, objectId) => ({
        dpId,
        dpName: dpsById.get(dpId)?.dpName || dpId,
        objectId,
      });

      if (variable.varType === 'DP') {
        return {
          kind: 'DP',
          sources: hasUsableId(variable.dp_id)
            ? [toSource(variable.dp_id, variable.id)]
            : [],
        };
      }

      if (variable.varType === 'Merge') {
        return {
          kind: 'Merge',
          sources: (Array.isArray(variable.merge) ? variable.merge : [])
            .filter(
              (source) =>
                source &&
                typeof source === 'object' &&
                hasUsableId(source.dp_id),
            )
            .map((source) => toSource(source.dp_id, source.dpObject_id)),
        };
      }

      return null;
    }

    function getDependencySources(variableId, options = {}) {
      const maxNodes = Number.isFinite(options.maxNodes)
        ? Math.max(0, Math.floor(options.maxNodes))
        : 2000;
      const stack = [variableId];
      const visited = new Set();
      const sources = new Map();

      while (stack.length && visited.size < maxNodes) {
        const currentId = stack.pop();
        if (visited.has(currentId)) continue;
        visited.add(currentId);
        const sourceInfo = getSourceInfo(currentId);
        if (sourceInfo) {
          sourceInfo.sources.forEach((source) => {
            const key = `${source.dpId}\u0000${source.objectId || ''}`;
            if (!sources.has(key)) sources.set(key, source);
          });
          continue;
        }
        getDependencies(currentId).forEach((dependency) => {
          if (!visited.has(dependency.id)) stack.push(dependency.id);
        });
      }

      return Array.from(sources.values());
    }

    function addWarning(warnings, warning) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }

    function createExpansionBudget(options) {
      const maxNodes = Number.isFinite(options.maxNodes)
        ? Math.max(0, Math.floor(options.maxNodes))
        : 2000;
      const maxLength = Number.isFinite(options.maxLength)
        ? Math.max(0, Math.floor(options.maxLength))
        : 200000;
      return {
        maxNodes,
        remainingNodes: maxNodes,
        maxLength,
      };
    }

    function expandReferences(formula, node, path, warnings, maxDepth, budget, zones = null) {
      const references = collectReferences(node);
      const positionalReplacements = [];
      let fallbackCursor = 0;

      references.forEach((reference) => {
        const dependency = variablesById.get(reference.id);
        if (!dependency) {
          const label = reference.literal
            ? `${reference.literal} (${reference.id})`
            : reference.id;
          addWarning(warnings, `Переменная не найдена: ${label}`);
          return;
        }
        if (isTerminalVariable(dependency)) return;

        let nested;
        if (path.includes(dependency.id)) {
          const cycleStart = path.indexOf(dependency.id);
          const cycleIds = [...path.slice(cycleStart), dependency.id];
          const cycleNames = cycleIds.map(
            (id) => variablesById.get(id)?.name || id,
          );
          const warning = `Циклическая ссылка: ${cycleNames.join(' → ')}`;
          addWarning(warnings, warning);
          nested = `[${dependency.name || dependency.id}]`;
        } else if (path.length >= maxDepth) {
          const warning = `Достигнут предел раскрытия (${maxDepth}): ${dependency.name || dependency.id}`;
          addWarning(warnings, warning);
          nested = `[${dependency.name || dependency.id}]`;
        } else if (budget.remainingNodes <= 0) {
          addWarning(
            warnings,
            `Достигнут предел раскрытия по количеству узлов (${budget.maxNodes})`,
          );
          nested = `[${dependency.name || dependency.id}]`;
        } else {
          budget.remainingNodes -= 1;
          const expanded = expandVariable(
            dependency,
            [...path, dependency.id],
            warnings,
            maxDepth,
            budget,
            null,
          );
          if (expanded === null) return;
          nested = expanded.replace(/^=/, '');
        }

        const replacement = `(${nested})`;
        const positionedText = Number.isInteger(reference.start) && Number.isInteger(reference.length)
          ? formula.slice(reference.start, reference.start + reference.length)
          : '';
        const expectedText = reference.literal ? `[${reference.literal}]` : '';
        const hasValidPosition = (
          Number.isInteger(reference.start) && reference.start >= 0 &&
          Number.isInteger(reference.length) && reference.length > 0 &&
          reference.start + reference.length <= formula.length &&
          positionedText.startsWith('[') && positionedText.endsWith(']') &&
          (!expectedText || positionedText === expectedText)
        );
        if (hasValidPosition) {
          positionalReplacements.push({
            start: reference.start,
            length: reference.length,
            replacement,
            variableId: dependency.id,
            label: dependency.name || dependency.id,
          });
          fallbackCursor = Math.max(fallbackCursor, reference.start + reference.length);
        } else {
          const literal = reference.literal || dependency.name;
          if (!literal) return;
          const start = findUnquotedVariable(formula, literal, fallbackCursor);
          if (start < 0) return;
          const length = literal.length + 2;
          positionalReplacements.push({
            start,
            length,
            replacement,
            variableId: dependency.id,
            label: dependency.name || dependency.id,
          });
          fallbackCursor = start + length;
        }
      });

      const appliedReplacements = [];
      positionalReplacements
        .sort((a, b) => b.start - a.start)
        .forEach((item) => {
          const { start, length, replacement } = item;
          if (formula.length - length + replacement.length > budget.maxLength) {
            addWarning(
              warnings,
              `Достигнут предел длины раскрытой формулы (${budget.maxLength} символов)`,
            );
            return;
          }
          formula = `${formula.slice(0, start)}${replacement}${formula.slice(start + length)}`;
          appliedReplacements.push(item);
        });

      if (zones) {
        appliedReplacements
          .map((item) => {
            const shift = appliedReplacements.reduce((total, other) => (
              other.start < item.start
                ? total + other.replacement.length - other.length
                : total
            ), 0);
            return {
              start: item.start + shift,
              length: item.replacement.length,
              variableId: item.variableId,
              label: item.label,
            };
          })
          .sort((a, b) => a.start - b.start)
          .forEach((zone) => zones.push(zone));
      }

      return formula;
    }

    function expandVariable(variable, path, warnings, maxDepth, budget, zones = null) {
      let formula =
        variable.parsedFormula?.source ||
        variable.formula;
      if (typeof formula !== 'string' || !formula.length) {
        const label = variable.name
          ? `${variable.name} (${variable.id})`
          : variable.id;
        addWarning(warnings, `У переменной ${label} отсутствует формула`);
        return null;
      }
      if (formula.length > budget.maxLength) {
        addWarning(
          warnings,
          `Достигнут предел длины раскрытой формулы (${budget.maxLength} символов)`,
        );
        formula = formula.slice(0, budget.maxLength);
        return formula;
      }
      if (isTerminalVariable(variable)) return formula;
      return expandReferences(
        formula,
        variable.parsedFormula?.root,
        path,
        warnings,
        maxDepth,
        budget,
        zones,
      );
    }

    function expandFormula(variableId, options = {}) {
      const variable = variablesById.get(variableId);
      if (!variable) return { formula: '', warnings: [`Переменная ${variableId} не найдена`] };

      const warnings = [];
      const maxDepth = options.maxDepth ?? 40;
      const budget = createExpansionBudget(options);
      return {
        formula: expandVariable(variable, [variable.id], warnings, maxDepth, budget, null) ?? '',
        warnings,
      };
    }

    function expandFormulaDetailed(variableId, options = {}) {
      const variable = variablesById.get(variableId);
      if (!variable) {
        return {
          formula: '',
          warnings: [`Переменная ${variableId} не найдена`],
          zones: [],
        };
      }

      const warnings = [];
      const zones = [];
      const maxDepth = options.maxDepth ?? 40;
      const budget = createExpansionBudget(options);
      return {
        formula: expandVariable(variable, [variable.id], warnings, maxDepth, budget, zones) ?? '',
        warnings,
        zones,
      };
    }

    function expandExpression(formula, node, options = {}) {
      const warnings = [];
      const maxDepth = options.maxDepth ?? 40;
      const budget = createExpansionBudget(options);
      if (formula.length > budget.maxLength) {
        addWarning(
          warnings,
          `Достигнут предел длины раскрытой формулы (${budget.maxLength} символов)`,
        );
        return {
          formula: formula.slice(0, budget.maxLength),
          warnings,
        };
      }
      return {
        formula: expandReferences(formula, node, [], warnings, maxDepth, budget, null),
        warnings,
      };
    }

    function expandExpressionDetailed(formula, node, options = {}) {
      const warnings = [];
      const zones = [];
      const maxDepth = options.maxDepth ?? 40;
      const budget = createExpansionBudget(options);
      if (formula.length > budget.maxLength) {
        addWarning(
          warnings,
          `Достигнут предел длины раскрытой формулы (${budget.maxLength} символов)`,
        );
        return {
          formula: formula.slice(0, budget.maxLength),
          warnings,
          zones,
        };
      }
      return {
        formula: expandReferences(formula, node, [], warnings, maxDepth, budget, zones),
        warnings,
        zones,
      };
    }

    function tokenizeFormula(formula, node = null) {
      const source = typeof formula === 'string' ? formula : String(formula ?? '');
      const referencesByStart = new Map();
      collectReferences(node).forEach((reference) => {
        if (Number.isInteger(reference.start)) referencesByStart.set(reference.start, reference);
      });
      const tokens = [];
      const push = (kind, start, end, extra = {}) => {
        tokens.push({
          kind,
          text: source.slice(start, end),
          start,
          length: end - start,
          ...extra,
        });
      };
      const isIdentifierStart = (character) => /[\p{L}_]/u.test(character || '');
      const isIdentifierPart = (character) => /[\p{L}\p{N}_.]/u.test(character || '');
      let index = 0;

      while (index < source.length) {
        const start = index;
        const character = source[index];

        if (/\s/u.test(character)) {
          while (index < source.length && /\s/u.test(source[index])) index += 1;
          push('whitespace', start, index);
          continue;
        }

        if (character === "'") {
          index += 1;
          while (index < source.length) {
            if (source[index] !== "'") {
              index += 1;
              continue;
            }
            if (source[index + 1] === "'") {
              index += 2;
              continue;
            }
            index += 1;
            break;
          }
          push('string', start, index);
          continue;
        }

        if (character === '[') {
          const close = source.indexOf(']', index + 1);
          if (close >= 0) {
            index = close + 1;
            const literal = source.slice(start + 1, close);
            const positionedReference = referencesByStart.get(start);
            const exactReference = positionedReference && (
              !positionedReference.literal || positionedReference.literal === literal
            )
              ? positionedReference
              : null;
            const namedMatches = variablesByName.get(literal) || [];
            const exactVariable = exactReference
              ? variablesById.get(exactReference.id)
              : null;
            const candidates = exactVariable ? [exactVariable] : namedMatches;
            const variableId = exactVariable?.id || (candidates.length === 1 ? candidates[0].id : null);
            push('variable', start, index, {
              variableId,
              candidateIds: candidates.map((variable) => variable.id),
              variableType: variableId
                ? variablesById.get(variableId)?.type || 'unknown'
                : 'unknown',
            });
            continue;
          }
        }

        if (/\d/u.test(character) || (character === '.' && /\d/u.test(source[index + 1] || ''))) {
          index += 1;
          while (index < source.length && /[\d.eE+-]/u.test(source[index])) {
            const current = source[index];
            if ((current === '+' || current === '-') && !/[eE]/u.test(source[index - 1])) break;
            index += 1;
          }
          push('number', start, index);
          continue;
        }

        if (isIdentifierStart(character)) {
          index += 1;
          while (index < source.length && isIdentifierPart(source[index])) index += 1;
          let next = index;
          while (next < source.length && /\s/u.test(source[next])) next += 1;
          push(source[next] === '(' ? 'function' : 'identifier', start, index);
          continue;
        }

        const pair = source.slice(index, index + 2);
        if (['<=', '>=', '<>', '!=', '==', '&&', '||'].includes(pair)) {
          index += 2;
          push('operator', start, index);
          continue;
        }
        if ('=+-*/<>!&|'.includes(character)) {
          index += 1;
          push('operator', start, index);
          continue;
        }
        if ('(),;'.includes(character)) {
          index += 1;
          push('punctuation', start, index);
          continue;
        }

        index += 1;
        push('text', start, index);
      }

      return tokens;
    }

    return {
      expandExpressionDetailed,
      expandExpression,
      expandFormulaDetailed,
      expandFormula,
      findVariable,
      getDependencySources,
      getDependencies,
      getSourceInfo,
      tokenizeFormula,
    };
  }

  return {
    collectReferences,
    createModel,
    normalizeVariableQuery,
  };
});
