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
    const dpsById = new Map(validDps.map((dp) => [dp.dp_id, dp]));

    function isTerminalVariable(variable) {
      return variable?.varType === 'DP' || variable?.varType === 'Merge';
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

    function expandReferences(formula, node, path, warnings, maxDepth, budget) {
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
          );
          if (expanded === null) return;
          nested = expanded.replace(/^=/, '');
        }

        const replacement = `(${nested})`;
        if (Number.isInteger(reference.start) && Number.isInteger(reference.length)) {
          positionalReplacements.push({
            start: reference.start,
            length: reference.length,
            replacement,
          });
          fallbackCursor = Math.max(fallbackCursor, reference.start + reference.length);
        } else {
          const literal = reference.literal || dependency.name;
          if (!literal) return;
          const start = findUnquotedVariable(formula, literal, fallbackCursor);
          if (start < 0) return;
          const length = literal.length + 2;
          positionalReplacements.push({ start, length, replacement });
          fallbackCursor = start + length;
        }
      });

      positionalReplacements
        .sort((a, b) => b.start - a.start)
        .forEach(({ start, length, replacement }) => {
          if (formula.length - length + replacement.length > budget.maxLength) {
            addWarning(
              warnings,
              `Достигнут предел длины раскрытой формулы (${budget.maxLength} символов)`,
            );
            return;
          }
          formula = `${formula.slice(0, start)}${replacement}${formula.slice(start + length)}`;
        });

      return formula;
    }

    function expandVariable(variable, path, warnings, maxDepth, budget) {
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
      );
    }

    function expandFormula(variableId, options = {}) {
      const variable = variablesById.get(variableId);
      if (!variable) return { formula: '', warnings: [`Переменная ${variableId} не найдена`] };

      const warnings = [];
      const maxDepth = options.maxDepth ?? 40;
      const budget = createExpansionBudget(options);
      return {
        formula: expandVariable(variable, [variable.id], warnings, maxDepth, budget) ?? '',
        warnings,
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
        formula: expandReferences(formula, node, [], warnings, maxDepth, budget),
        warnings,
      };
    }

    return {
      expandExpression,
      expandFormula,
      getDependencies,
      getSourceInfo,
    };
  }

  return {
    collectReferences,
    createModel,
  };
});
