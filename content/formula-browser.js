(function () {
  'use strict';

  const core = globalThis.FormulaBrowserCore;
  if (!core) {
    console.error('[Auth Injector] FormulaBrowserCore не загружен');
    return;
  }

  const state = {
    host: null,
    shadow: null,
    panel: null,
    variables: [],
    variablesById: new Map(),
    dps: [],
    model: null,
    loaded: false,
    loading: false,
    history: [],
    historyIndex: -1,
    maximized: false,
    restoreRect: null,
    positioned: false,
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action !== 'openFormulaBrowser') return;

    openBrowser()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  });

  async function openBrowser() {
    if (!state.host) mount();
    state.host.style.display = 'block';
    if (!state.positioned) {
      const rect = state.panel.getBoundingClientRect();
      Object.assign(state.panel.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        transform: 'none',
      });
      state.positioned = true;
    }
    state.shadow.getElementById('fb-search').focus();
    if (!state.loaded && !state.loading) await loadData();
  }

  function mount() {
    const host = document.createElement('div');
    host.id = 'auth-injector-formula-browser';
    host.style.cssText = [
      'all: initial',
      'position: fixed',
      'inset: 0',
      'display: none',
      'pointer-events: none',
      'z-index: 2147483647',
    ].join(';');

    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>${styles()}</style>
      <section class="fb-window" role="dialog" aria-label="Браузер формул">
        <header class="fb-titlebar">
          <div class="fb-title">
            <span class="fb-logo">ƒ</span>
            <span>Браузер формул</span>
          </div>
          <div class="fb-window-actions">
            <button id="fb-maximize" class="fb-icon-button" type="button" title="Развернуть">□</button>
            <button id="fb-close" class="fb-icon-button fb-close" type="button" title="Скрыть (Esc)">×</button>
          </div>
        </header>

        <div class="fb-toolbar">
          <button id="fb-back" class="fb-icon-button" type="button" title="Назад (Alt+←)">←</button>
          <button id="fb-forward" class="fb-icon-button" type="button" title="Вперёд (Alt+→)">→</button>
          <span id="fb-history-position" class="fb-history-position">0 / 0</span>
          <form id="fb-search-form" class="fb-search-form">
            <input id="fb-search" list="fb-variable-options" autocomplete="off" placeholder="Переменная: имя или id" />
            <datalist id="fb-variable-options"></datalist>
            <button class="fb-button fb-button-secondary" type="submit">Открыть</button>
          </form>
          <button id="fb-refresh" class="fb-button fb-button-quiet" type="button" title="Повторно загрузить переменные">Обновить</button>
        </div>

        <div class="fb-editor">
          <label for="fb-formula">Формула для анализа</label>
          <div class="fb-editor-row">
            <textarea id="fb-formula" rows="2" maxlength="200000" spellcheck="false" placeholder="=[Количество всего чеков (сравн)]+[Количество чеков услуги (сравн)]"></textarea>
            <button id="fb-analyze" class="fb-button fb-button-primary" type="button">Анализировать</button>
          </div>
          <div class="fb-shortcuts">Ctrl+Enter — анализ · Alt+←/→ — история · Esc — скрыть</div>
        </div>

        <main id="fb-content" class="fb-content">
          <div class="fb-empty">Загрузка переменных отчёта…</div>
        </main>
        <footer id="fb-status" class="fb-status" data-tone="neutral">Ожидание</footer>
      </section>
    `;

    (document.documentElement || document).appendChild(host);
    state.host = host;
    state.shadow = shadow;
    state.panel = shadow.querySelector('.fb-window');

    bindEvents();
    updateHistoryControls();
  }

  function bindEvents() {
    const $ = (id) => state.shadow.getElementById(id);

    $('fb-close').addEventListener('click', hideBrowser);
    $('fb-maximize').addEventListener('click', toggleMaximize);
    $('fb-back').addEventListener('click', goBack);
    $('fb-forward').addEventListener('click', goForward);
    $('fb-refresh').addEventListener('click', () => loadData(true));
    $('fb-analyze').addEventListener('click', analyzeFormula);
    $('fb-search-form').addEventListener('submit', openSearchResult);

    state.shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        hideBrowser();
      } else if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        goBack();
      } else if (event.altKey && event.key === 'ArrowRight') {
        event.preventDefault();
        goForward();
      } else if (event.ctrlKey && event.key === 'Enter') {
        event.preventDefault();
        analyzeFormula();
      }
    });

    bindDragging(state.shadow.querySelector('.fb-titlebar'));
  }

  function bindDragging(handle) {
    let drag = null;

    handle.addEventListener('pointerdown', (event) => {
      if (state.maximized || event.button !== 0 || event.target.closest('button')) return;
      const rect = state.panel.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      state.panel.style.left = `${rect.left}px`;
      state.panel.style.top = `${rect.top}px`;
      state.panel.style.transform = 'none';
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    handle.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const maxLeft = Math.max(0, window.innerWidth - 220);
      const maxTop = Math.max(0, window.innerHeight - 48);
      state.panel.style.left = `${clamp(event.clientX - drag.offsetX, 0, maxLeft)}px`;
      state.panel.style.top = `${clamp(event.clientY - drag.offsetY, 0, maxTop)}px`;
    });

    const finish = (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag = null;
      handle.releasePointerCapture(event.pointerId);
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function hideBrowser() {
    if (state.host) state.host.style.display = 'none';
  }

  function toggleMaximize() {
    const button = state.shadow.getElementById('fb-maximize');
    if (!state.maximized) {
      const rect = state.panel.getBoundingClientRect();
      state.restoreRect = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
      Object.assign(state.panel.style, {
        left: '12px',
        top: '12px',
        width: 'calc(100vw - 24px)',
        height: 'calc(100vh - 24px)',
        transform: 'none',
        resize: 'none',
      });
      state.maximized = true;
      button.textContent = '❐';
      button.title = 'Восстановить размер';
    } else {
      const rect = state.restoreRect;
      Object.assign(state.panel.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        transform: 'none',
        resize: 'both',
      });
      state.maximized = false;
      button.textContent = '□';
      button.title = 'Развернуть';
    }
  }

  async function loadData(force = false) {
    if (state.loading || (state.loaded && !force)) return;
    state.loading = true;
    setBusy(true);
    setStatus('Загрузка REP.GET_VARIABLES и REP.GET_DP_LIST…', 'neutral');

    try {
      const [variablesResponse, dpsResult] = await Promise.all([
        requestJson('REP.GET_VARIABLES', {}),
        requestJson('REP.GET_DP_LIST', {})
          .then((response) => {
            if (response.result !== 1 || !Array.isArray(response.dps)) {
              throw new Error('REP.GET_DP_LIST не вернул список источников');
            }
            return { response, error: null };
          })
          .catch((error) => ({ response: { dps: [] }, error })),
      ]);

      if (variablesResponse.result !== 1 || !Array.isArray(variablesResponse.variables)) {
        throw new Error('REP.GET_VARIABLES не вернул список переменных');
      }

      const rawVariables = variablesResponse.variables;
      state.variables = rawVariables.filter(
        (variable) =>
          variable &&
          typeof variable === 'object' &&
          hasUsableId(variable.id),
      );
      state.variablesById = new Map(
        state.variables.map((variable) => [variable.id, variable]),
      );
      const rawDps = Array.isArray(dpsResult.response.dps) ? dpsResult.response.dps : [];
      state.dps = rawDps.filter(
        (dp) =>
          dp &&
          typeof dp === 'object' &&
          hasUsableId(dp.dp_id),
      );
      state.model = core.createModel(state.variables, state.dps);
      state.loaded = true;
      populateVariableOptions();

      if (state.historyIndex >= 0) renderCurrent();
      else renderWelcome();

      const ignoredCount = rawVariables.length - state.variables.length;
      const invalidSuffix = ignoredCount
        ? ` Пропущено повреждённых записей без id: ${ignoredCount}.`
        : '';
      const suffix = dpsResult.error
        ? ' Названия DP-источников недоступны; показаны их id.'
        : '';
      setStatus(
        `Загружено переменных: ${state.variables.length}.${invalidSuffix}${suffix}`,
        dpsResult.error || ignoredCount ? 'warning' : 'success',
      );
    } catch (error) {
      renderError(error.message);
      setStatus(error.message, 'error');
    } finally {
      state.loading = false;
      setBusy(false);
    }
  }

  async function requestJson(command, params) {
    const bridge = globalThis.AuthInjectorBridge;
    if (!bridge?.requestJson) throw new Error('API-мост расширения не инициализирован');
    return bridge.requestJson(command, params, true);
  }

  function populateVariableOptions() {
    const datalist = state.shadow.getElementById('fb-variable-options');
    datalist.replaceChildren();
    const fragment = document.createDocumentFragment();
    state.variables
      .slice()
      .sort((a, b) => variableLabel(a).localeCompare(variableLabel(b), 'ru'))
      .forEach((variable) => {
        const option = document.createElement('option');
        option.value = variableLabel(variable);
        option.label = `${variable.type || 'Variable'} · ${variable.id}`;
        fragment.appendChild(option);
      });
    datalist.appendChild(fragment);
  }

  function openSearchResult(event) {
    event.preventDefault();
    if (!state.loaded) return;

    const input = state.shadow.getElementById('fb-search');
    const query = input.value.trim();
    if (!query) return;
    const normalized = query.toLocaleLowerCase('ru');
    const variable =
      state.variablesById.get(query) ||
      state.variables.find((item) => variableLabel(item).toLocaleLowerCase('ru') === normalized) ||
      state.variables.find((item) => variableLabel(item).toLocaleLowerCase('ru').includes(normalized));

    if (!variable) {
      setStatus(`Переменная «${query}» не найдена`, 'error');
      return;
    }

    input.value = variableLabel(variable);
    navigate({ kind: 'variable', id: variable.id });
  }

  async function analyzeFormula() {
    if (state.loading) return;
    const textarea = state.shadow.getElementById('fb-formula');
    let formula = textarea.value.trim();
    if (!formula) {
      setStatus('Введите формулу для анализа', 'warning');
      textarea.focus();
      return;
    }
    if (!formula.startsWith('=')) formula = `=${formula}`;
    textarea.value = formula;

    const button = state.shadow.getElementById('fb-analyze');
    button.disabled = true;
    button.textContent = 'Проверка…';
    setStatus('REP.VALIDATE_FORMULA…', 'neutral');

    try {
      let response;
      try {
        response = await requestJson('REP.VALIDATE_FORMULA', { formula });
      } catch (error) {
        setStatus(error.message, 'error');
        renderRequestError(formula, error.message);
        return;
      }

      if (response.result !== 1 || response.isValid !== 1) {
        const reason = response.reason || 'Формула не прошла проверку';
        setStatus(reason, 'error');
        renderValidationError(formula, reason);
        return;
      }

      const restored = response.restored || response.formula || formula;
      textarea.value = restored;
      navigate({
        kind: 'formula',
        formula: restored,
        source: response.tree?.source || response.formula || formula,
        validation: response,
      });
      setStatus(`Формула корректна · тип ${response.type || response.dataType || '?'}`, 'success');
    } finally {
      button.disabled = false;
      button.textContent = 'Анализировать';
    }
  }

  function navigate(entry) {
    const current = state.history[state.historyIndex];
    if (sameEntry(current, entry)) return;
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(entry);
    state.historyIndex = state.history.length - 1;
    renderCurrent();
  }

  function sameEntry(a, b) {
    if (!a || !b || a.kind !== b.kind) return false;
    return a.kind === 'variable' ? a.id === b.id : a.formula === b.formula;
  }

  function goBack() {
    if (state.historyIndex <= 0) return;
    state.historyIndex -= 1;
    renderCurrent();
  }

  function goForward() {
    if (state.historyIndex >= state.history.length - 1) return;
    state.historyIndex += 1;
    renderCurrent();
  }

  function updateHistoryControls() {
    if (!state.shadow) return;
    state.shadow.getElementById('fb-back').disabled = state.historyIndex <= 0;
    state.shadow.getElementById('fb-forward').disabled =
      state.historyIndex < 0 || state.historyIndex >= state.history.length - 1;
    state.shadow.getElementById('fb-history-position').textContent =
      state.historyIndex < 0 ? '0 / 0' : `${state.historyIndex + 1} / ${state.history.length}`;
  }

  function renderCurrent() {
    updateHistoryControls();
    const entry = state.history[state.historyIndex];
    if (!entry) return renderWelcome();
    if (entry.kind === 'variable') renderVariable(entry.id);
    else renderValidatedFormula(entry);
  }

  function renderWelcome() {
    const content = state.shadow.getElementById('fb-content');
    content.replaceChildren();
    const empty = element('div', 'fb-empty');
    empty.append(
      element('div', 'fb-empty-icon', 'ƒ(x)'),
      element('h2', '', 'Выберите переменную или введите формулу'),
      element(
        'p',
        '',
        'Ссылки в дереве можно открывать как страницы. Переходы сохраняются в истории текущей вкладки.',
      ),
    );
    content.appendChild(empty);
  }

  function renderVariable(variableId) {
    const variable = state.variablesById.get(variableId);
    if (!variable) return renderError(`Переменная ${variableId} больше не найдена`);

    const content = state.shadow.getElementById('fb-content');
    content.replaceChildren();
    const layout = element('div', 'fb-layout');
    const main = element('section', 'fb-main-column');
    const aside = element('aside', 'fb-side-column');

    const heading = element('div', 'fb-heading');
    const headingText = element('div');
    headingText.append(
      element('div', 'fb-eyebrow', variable.varType || 'Переменная'),
      element('h2', '', variable.name || variable.id),
      element('div', 'fb-id', variable.id),
    );
    const badges = element('div', 'fb-badges');
    badges.append(typeBadge(variable.type), neutralBadge(variable.dataType));
    heading.append(headingText, badges);
    main.appendChild(card(heading, 'fb-heading-card'));

    main.appendChild(formulaCard('Формула', variable.formula || 'Формула отсутствует'));

    const dependencies = state.model.getDependencies(variable.id);
    main.appendChild(dependenciesCard(dependencies));
    main.appendChild(expandedFormulaCard(
      () => state.model.expandFormula(variable.id),
    ));

    aside.appendChild(sourceCard(variable));
    aside.appendChild(treeCard(variable.parsedFormula?.root, [variable.id]));
    layout.append(main, aside);
    content.appendChild(layout);
  }

  function renderValidatedFormula(entry) {
    const content = state.shadow.getElementById('fb-content');
    content.replaceChildren();
    const layout = element('div', 'fb-layout');
    const main = element('section', 'fb-main-column');
    const aside = element('aside', 'fb-side-column');
    const response = entry.validation;
    const root = response.tree?.root;

    const heading = element('div', 'fb-heading');
    const headingText = element('div');
    headingText.append(
      element('div', 'fb-eyebrow', 'REP.VALIDATE_FORMULA'),
      element('h2', '', 'Проверенная формула'),
      element('div', 'fb-id', response.debug || 'Формула корректна'),
    );
    const badges = element('div', 'fb-badges');
    badges.append(neutralBadge(response.type || response.dataType), successBadge('VALID'));
    heading.append(headingText, badges);
    main.appendChild(card(heading, 'fb-heading-card'));
    main.appendChild(formulaCard('Восстановленная формула', entry.formula));

    const dependencies = referencesToVariables(root);
    main.appendChild(dependenciesCard(dependencies));
    main.appendChild(expandedFormulaCard(
      () => state.model.expandExpression(entry.source || entry.formula, root),
    ));
    aside.appendChild(treeCard(root, []));
    layout.append(main, aside);
    content.appendChild(layout);
  }

  function renderValidationError(formula, message) {
    const content = state.shadow.getElementById('fb-content');
    content.replaceChildren();
    const error = element('div', 'fb-error-panel');
    error.append(
      element('h2', '', 'Формула не прошла проверку'),
      element('p', '', message),
      codeBlock(formula),
    );
    content.appendChild(error);
  }

  function renderRequestError(formula, message) {
    const content = state.shadow.getElementById('fb-content');
    content.replaceChildren();
    const error = element('div', 'fb-error-panel');
    error.append(
      element('h2', '', 'Не удалось проверить формулу'),
      element('p', '', message),
      element('p', 'fb-muted', 'Формула не помечена как ошибочная: сервер не вернул результат проверки.'),
      codeBlock(formula),
    );
    content.appendChild(error);
  }

  function renderError(message) {
    const content = state.shadow.getElementById('fb-content');
    content.replaceChildren();
    const error = element('div', 'fb-error-panel');
    error.append(element('h2', '', 'Не удалось открыть браузер формул'), element('p', '', message));
    content.appendChild(error);
  }

  function dependenciesCard(dependencies) {
    const body = element('div');
    if (!dependencies.length) {
      body.appendChild(element('p', 'fb-muted', 'В формуле нет доступных ссылок на переменные.'));
    } else {
      const list = element('div', 'fb-dependency-list');
      dependencies.forEach((variable) => {
        const button = element('button', 'fb-dependency', variable.name || variable.id);
        button.type = 'button';
        button.appendChild(typeDot(variable.type));
        button.addEventListener('click', () => navigate({ kind: 'variable', id: variable.id }));
        list.appendChild(button);
      });
      body.appendChild(list);
    }
    return sectionCard('Непосредственные зависимости', body);
  }

  function expandedFormulaCard(getExpansion) {
    const details = element('details', 'fb-expansion');
    const summary = element('summary', '', 'Полностью раскрытая формула');
    const body = element('div', 'fb-expansion-body');
    let rendered = false;
    details.append(summary, body);
    details.addEventListener('toggle', () => {
      if (!details.open || rendered) return;
      rendered = true;
      try {
        const expansion = getExpansion();
        body.appendChild(codeBlock(expansion.formula || 'Нет формулы'));
        expansion.warnings.forEach((warning) =>
          body.appendChild(element('div', 'fb-warning', warning)),
        );
      } catch (error) {
        body.appendChild(element('div', 'fb-warning', error.message));
      }
    });
    return sectionCard('', details, 'fb-card-no-title');
  }

  function sourceCard(variable) {
    const source = state.model.getSourceInfo(variable.id);
    const body = element('div');
    if (!source) {
      body.appendChild(element('p', 'fb-muted', 'Пользовательская переменная отчёта.'));
      return sectionCard('Источник', body);
    }

    if (!source.sources.length) {
      body.appendChild(
        element(
          'p',
          'fb-warning',
          source.kind === 'Merge'
            ? 'У Merge-переменной нет корректно указанных источников.'
            : 'Источник не указан.',
        ),
      );
      return sectionCard(source.kind === 'Merge' ? 'Источники Merge' : 'Источник DP', body);
    }

    source.sources.forEach((item) => {
      const row = element('div', 'fb-source');
      row.append(
        element('strong', '', item.dpName || item.dpId),
        element('span', 'fb-source-id', item.dpId),
        element('code', '', item.objectId || '—'),
      );
      body.appendChild(row);
    });
    return sectionCard(source.kind === 'Merge' ? 'Источники Merge' : 'Источник DP', body);
  }

  function treeCard(root, ancestors) {
    const body = element('div', 'fb-tree');
    const rootVariable = ancestors.length === 1
      ? state.variablesById.get(ancestors[0])
      : null;
    if (rootVariable?.varType === 'DP' || rootVariable?.varType === 'Merge') {
      body.appendChild(
        element(
          'p',
          'fb-muted',
          rootVariable.varType === 'Merge'
            ? 'Merge-переменная является терминальным узлом; её источники перечислены выше.'
            : 'DP-переменная является терминальным объектом источника.',
        ),
      );
      return sectionCard('Дерево зависимостей', body);
    }
    const refs = uniqueReferences(core.collectReferences(root));
    if (!refs.length) body.appendChild(element('p', 'fb-muted', 'Формула не содержит переменных.'));
    else body.appendChild(renderReferenceTree(refs, ancestors));
    return sectionCard('Дерево зависимостей', body);
  }

  function renderReferenceTree(references, ancestors) {
    const list = element('ul', 'fb-tree-list');
    references.forEach((reference) => {
      const item = element('li', 'fb-tree-item');
      const variable = state.variablesById.get(reference.id);
      const row = element('div', 'fb-tree-row');

      if (!variable) {
        row.append(typeDot('unknown'), element('span', '', reference.literal || reference.id));
        row.appendChild(element('span', 'fb-tree-note', 'не найдена'));
        item.appendChild(row);
        list.appendChild(item);
        return;
      }

      const open = element('button', 'fb-tree-link', variable.name || reference.literal || variable.id);
      open.type = 'button';
      open.addEventListener('click', () => navigate({ kind: 'variable', id: variable.id }));

      const isCycle = ancestors.includes(variable.id);
      const isTerminal = variable.varType === 'DP' || variable.varType === 'Merge';
      const children = isTerminal
        ? []
        : uniqueReferences(core.collectReferences(variable.parsedFormula?.root));
      let toggle = null;
      if (!isCycle && children.length) {
        toggle = element('button', 'fb-tree-toggle', '▸');
        toggle.type = 'button';
        toggle.title = 'Показать вложенные зависимости';
        toggle.setAttribute('aria-expanded', 'false');
        row.appendChild(toggle);
      } else {
        row.appendChild(element('span', 'fb-tree-toggle-spacer'));
      }
      row.append(typeDot(variable.type), open);

      const source = state.model.getSourceInfo(variable.id);
      if (source?.sources?.length) {
        row.appendChild(element('span', 'fb-tree-note', source.sources.map((s) => s.dpName).join(', ')));
      }
      item.appendChild(row);

      if (isCycle) {
        item.appendChild(element('div', 'fb-cycle', '↻ циклическая ссылка'));
      } else if (toggle) {
        const branch = element('div', 'fb-tree-children');
        branch.hidden = true;
        let rendered = false;
        toggle.addEventListener('click', () => {
          if (!rendered) {
            branch.appendChild(renderReferenceTree(children, [...ancestors, variable.id]));
            rendered = true;
          }
          branch.hidden = !branch.hidden;
          toggle.textContent = branch.hidden ? '▸' : '▾';
          toggle.setAttribute('aria-expanded', String(!branch.hidden));
        });
        item.appendChild(branch);
      }
      list.appendChild(item);
    });
    return list;
  }

  function referencesToVariables(root) {
    return uniqueReferences(core.collectReferences(root))
      .map((reference) => state.variablesById.get(reference.id))
      .filter(Boolean);
  }

  function uniqueReferences(references) {
    const seen = new Set();
    return references.filter((reference) => {
      if (seen.has(reference.id)) return false;
      seen.add(reference.id);
      return true;
    });
  }

  function hasUsableId(value) {
    return value !== undefined && value !== null && String(value).trim().length > 0;
  }

  function variableLabel(variable) {
    return typeof variable?.name === 'string' && variable.name.length
      ? variable.name
      : String(variable?.id ?? 'Без имени/ID');
  }

  function formulaCard(title, formula) {
    return sectionCard(title, codeBlock(formula));
  }

  function sectionCard(title, body, extraClass = '') {
    const section = element('section', `fb-card ${extraClass}`.trim());
    if (title) section.appendChild(element('h3', '', title));
    section.appendChild(body);
    return section;
  }

  function card(body, extraClass = '') {
    const wrapper = element('section', `fb-card ${extraClass}`.trim());
    wrapper.appendChild(body);
    return wrapper;
  }

  function codeBlock(value) {
    return element('pre', 'fb-code', value == null ? '—' : String(value));
  }

  function typeBadge(type) {
    const normalized = normalizeTypeClass(type);
    return element('span', `fb-badge fb-type-${normalized}`, type || 'Variable');
  }

  function neutralBadge(value) {
    return element('span', 'fb-badge fb-badge-neutral', value || '?');
  }

  function successBadge(value) {
    return element('span', 'fb-badge fb-badge-success', value);
  }

  function typeDot(type) {
    return element('span', `fb-type-dot fb-type-${normalizeTypeClass(type)}`);
  }

  function normalizeTypeClass(type) {
    const normalized = String(type || 'unknown').toLowerCase();
    return ['dimension', 'attribute', 'measure'].includes(normalized)
      ? normalized
      : 'unknown';
  }

  function element(tag, className = '', text = null) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== null) {
      const value = String(text);
      node.textContent = value.length > 200000
        ? `${value.slice(0, 200000)}\n… [отображение сокращено]`
        : value;
    }
    return node;
  }

  function setBusy(busy) {
    const refresh = state.shadow.getElementById('fb-refresh');
    refresh.disabled = busy;
    refresh.textContent = busy ? 'Загрузка…' : 'Обновить';
  }

  function setStatus(message, tone = 'neutral') {
    const status = state.shadow.getElementById('fb-status');
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function styles() {
    return `
      :host { color-scheme: light; }
      * { box-sizing: border-box; }
      button, input, textarea { font: inherit; }
      button { -webkit-tap-highlight-color: transparent; }
      .fb-window {
        position: absolute;
        left: 50%;
        top: 7vh;
        transform: translateX(-50%);
        width: min(1120px, calc(100vw - 48px));
        height: min(820px, 86vh);
        min-width: min(620px, calc(100vw - 24px));
        min-height: 440px;
        display: grid;
        grid-template-rows: 48px auto auto minmax(0, 1fr) 30px;
        overflow: hidden;
        resize: both;
        pointer-events: auto;
        border: 1px solid #cbd5e1;
        border-radius: 12px;
        background: #f4f7fb;
        color: #172033;
        box-shadow: 0 24px 80px rgba(15, 23, 42, .35), 0 4px 16px rgba(15, 23, 42, .2);
        font-family: Inter, Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px;
        line-height: 1.45;
      }
      .fb-titlebar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 10px 0 16px;
        color: white;
        background: linear-gradient(120deg, #183a4e, #1e4f6a);
        cursor: move;
        user-select: none;
      }
      .fb-title { display: flex; align-items: center; gap: 10px; font-size: 15px; font-weight: 650; }
      .fb-logo {
        display: grid; place-items: center; width: 27px; height: 27px; border-radius: 7px;
        background: linear-gradient(199.32deg, #1ae3d7 -13.92%, #0945df 111.71%);
        font-family: Georgia, serif; font-size: 19px; font-style: italic; box-shadow: 0 2px 8px rgba(0,0,0,.2);
      }
      .fb-window-actions { display: flex; gap: 4px; }
      .fb-icon-button {
        width: 32px; height: 32px; display: inline-grid; place-items: center; padding: 0;
        border: 0; border-radius: 6px; background: transparent; color: inherit; cursor: pointer;
      }
      .fb-icon-button:hover:not(:disabled) { background: rgba(255,255,255,.14); }
      .fb-icon-button:disabled { opacity: .32; cursor: default; }
      .fb-close:hover { background: #d43f4f !important; }
      .fb-toolbar {
        display: flex; align-items: center; gap: 7px; padding: 9px 12px;
        border-bottom: 1px solid #dbe3ee; background: #fff;
      }
      .fb-toolbar > .fb-icon-button { color: #334155; border: 1px solid #d7dfeb; }
      .fb-toolbar > .fb-icon-button:hover:not(:disabled) { background: #eef3f9; }
      .fb-history-position { min-width: 40px; color: #64748b; text-align: center; font-variant-numeric: tabular-nums; }
      .fb-search-form { flex: 1; display: flex; gap: 7px; min-width: 220px; }
      input, textarea {
        width: 100%; border: 1px solid #cbd5e1; border-radius: 7px; outline: none;
        background: white; color: #172033; transition: border-color .15s, box-shadow .15s;
      }
      input { min-width: 0; height: 34px; padding: 0 10px; }
      textarea { min-height: 54px; padding: 8px 10px; resize: vertical; font-family: "Cascadia Code", Consolas, monospace; line-height: 1.35; }
      input:focus, textarea:focus { border-color: #2b6dd0; box-shadow: 0 0 0 3px rgba(43,109,208,.13); }
      .fb-button {
        min-height: 34px; padding: 0 13px; border: 1px solid transparent; border-radius: 7px;
        font-weight: 600; white-space: nowrap; cursor: pointer; transition: .15s ease;
      }
      .fb-button:disabled { opacity: .5; cursor: wait; }
      .fb-button-primary { color: white; background: #2b6dd0; box-shadow: 0 2px 5px rgba(43,109,208,.25); }
      .fb-button-primary:hover:not(:disabled) { background: #205db7; }
      .fb-button-secondary { color: #255da9; background: #eef5ff; border-color: #bcd0ec; }
      .fb-button-secondary:hover { background: #dfebfb; }
      .fb-button-quiet { color: #475569; background: #fff; border-color: #d7dfeb; }
      .fb-button-quiet:hover:not(:disabled) { background: #f2f5f9; }
      .fb-editor { padding: 10px 12px 8px; border-bottom: 1px solid #dbe3ee; background: #f8fafc; }
      .fb-editor > label { display: block; margin-bottom: 5px; color: #475569; font-size: 12px; font-weight: 650; }
      .fb-editor-row { display: flex; align-items: stretch; gap: 8px; }
      .fb-editor-row .fb-button { align-self: stretch; }
      .fb-shortcuts { margin-top: 4px; color: #8492a6; font-size: 11px; }
      .fb-content { min-height: 0; overflow: auto; padding: 14px; }
      .fb-layout { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(300px, .8fr); gap: 12px; align-items: start; }
      .fb-main-column, .fb-side-column { min-width: 0; display: grid; gap: 12px; }
      .fb-card { padding: 14px; border: 1px solid #dce4ef; border-radius: 10px; background: #fff; box-shadow: 0 1px 3px rgba(15,23,42,.05); }
      .fb-card h3 { margin: 0 0 9px; color: #334155; font-size: 12px; font-weight: 700; letter-spacing: .02em; text-transform: uppercase; }
      .fb-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
      .fb-heading h2 { margin: 2px 0 4px; font-size: 20px; line-height: 1.25; overflow-wrap: anywhere; }
      .fb-eyebrow { color: #2b6dd0; font-size: 11px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
      .fb-id { color: #78869a; font-family: "Cascadia Code", Consolas, monospace; font-size: 11px; overflow-wrap: anywhere; }
      .fb-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
      .fb-badge { display: inline-flex; align-items: center; min-height: 24px; padding: 2px 9px; border-radius: 999px; color: white; background: linear-gradient(135deg, #8b95a5, #485365); font-size: 11px; font-weight: 700; }
      .fb-badge-neutral { color: #475569; background: #edf1f5; }
      .fb-badge-success { color: #17663c; background: #daf4e5; }
      .fb-type-variable, .fb-type-formula, .fb-type-const, .fb-type-unknown { background: linear-gradient(135deg, #8b95a5, #485365); }
      .fb-type-dimension { background: linear-gradient(135deg, #1ae3d7, #0945df); }
      .fb-type-attribute { background: linear-gradient(180deg, #19b400, #09492a); }
      .fb-type-measure { background: linear-gradient(135deg, #ffc700, #df0909); }
      .fb-code {
        margin: 0; padding: 11px 12px; overflow: auto; border: 1px solid #dce5f0; border-radius: 8px;
        background: #f6f8fb; color: #1e293b; font-family: "Cascadia Code", Consolas, monospace;
        font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere;
      }
      .fb-dependency-list { display: flex; flex-wrap: wrap; gap: 7px; }
      .fb-dependency {
        display: inline-flex; align-items: center; gap: 7px; min-height: 30px; padding: 4px 9px;
        border: 1px solid #d4deea; border-radius: 7px; background: #f8fafc; color: #244b7c; cursor: pointer;
      }
      .fb-dependency:hover { border-color: #93b4df; background: #eef5ff; }
      .fb-type-dot { flex: 0 0 auto; width: 10px; height: 10px; border-radius: 3px; background: #7c8798; }
      .fb-expansion summary { color: #255da9; font-weight: 650; cursor: pointer; }
      .fb-expansion-body { display: grid; gap: 8px; margin-top: 10px; }
      .fb-warning { padding: 8px 10px; border-radius: 7px; background: #fff4d8; color: #855d00; }
      .fb-source { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; padding: 8px 0; border-bottom: 1px solid #edf1f5; }
      .fb-source:last-child { border-bottom: 0; }
      .fb-source strong { overflow-wrap: anywhere; }
      .fb-source-id { color: #64748b; }
      .fb-source code { grid-column: 1 / -1; color: #8492a6; font-size: 11px; overflow-wrap: anywhere; }
      .fb-tree { max-height: 520px; overflow: auto; padding-right: 3px; }
      .fb-tree-list { margin: 0; padding: 0 0 0 17px; border-left: 1px solid #dbe4ee; list-style: none; }
      .fb-tree > .fb-tree-list { padding-left: 0; border-left: 0; }
      .fb-tree-item { position: relative; margin: 5px 0; }
      .fb-tree-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .fb-tree-toggle, .fb-tree-toggle-spacer { flex: 0 0 16px; width: 16px; height: 18px; }
      .fb-tree-toggle { padding: 0; border: 0; border-radius: 3px; background: transparent; color: #64748b; line-height: 1; cursor: pointer; }
      .fb-tree-toggle:hover { background: #edf2f7; color: #255da9; }
      .fb-tree-link { min-width: 0; padding: 1px 0; border: 0; background: transparent; color: #255da9; text-align: left; overflow-wrap: anywhere; cursor: pointer; }
      .fb-tree-link:hover { text-decoration: underline; }
      .fb-tree-note { margin-left: auto; color: #8492a6; font-size: 10px; white-space: nowrap; }
      .fb-cycle { margin: 2px 0 2px 17px; color: #aa6716; font-size: 11px; }
      .fb-muted { margin: 0; color: #718096; }
      .fb-empty { min-height: 100%; display: grid; place-content: center; justify-items: center; padding: 30px; color: #64748b; text-align: center; }
      .fb-empty-icon { display: grid; place-items: center; width: 68px; height: 68px; margin-bottom: 12px; border-radius: 18px; background: linear-gradient(135deg, #e0f7f5, #dfe8ff); color: #174f91; font: italic 24px Georgia, serif; }
      .fb-empty h2 { margin: 0 0 6px; color: #334155; font-size: 18px; }
      .fb-empty p { max-width: 520px; margin: 0; }
      .fb-error-panel { padding: 18px; border: 1px solid #f0b8bd; border-radius: 10px; background: #fff7f7; color: #842b34; }
      .fb-error-panel h2 { margin: 0 0 6px; font-size: 17px; }
      .fb-error-panel p { margin: 0 0 12px; }
      .fb-status { padding: 6px 12px; overflow: hidden; border-top: 1px solid #dbe3ee; background: #fff; color: #64748b; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
      .fb-status[data-tone="success"] { color: #17663c; background: #f2fbf6; }
      .fb-status[data-tone="warning"] { color: #855d00; background: #fffbeb; }
      .fb-status[data-tone="error"] { color: #a12634; background: #fff5f5; }
      @media (max-width: 820px) {
        .fb-window { min-width: calc(100vw - 24px); }
        .fb-layout { grid-template-columns: 1fr; }
        .fb-toolbar { flex-wrap: wrap; }
        .fb-search-form { order: 2; flex-basis: 100%; }
        .fb-shortcuts { display: none; }
      }
    `;
  }
})();
