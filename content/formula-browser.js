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
    sidebarTab: 'variables',
    popover: null,
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

        <div class="fb-workspace">
          <aside class="fb-browser-sidebar" aria-label="Навигация браузера формул">
            <div class="fb-sidebar-tabs" role="tablist">
              <button id="fb-tab-variables" class="fb-sidebar-tab is-active" type="button" role="tab" aria-selected="true">Переменные</button>
              <button id="fb-tab-history" class="fb-sidebar-tab" type="button" role="tab" aria-selected="false">История</button>
            </div>
            <section id="fb-variables-panel" class="fb-sidebar-panel" role="tabpanel">
              <input id="fb-list-filter" class="fb-list-filter" autocomplete="off" placeholder="Фильтр списка…" />
              <div id="fb-variable-list" class="fb-sidebar-list">
                <div class="fb-sidebar-empty">Загрузка…</div>
              </div>
            </section>
            <section id="fb-history-panel" class="fb-sidebar-panel" role="tabpanel" hidden>
              <div id="fb-history-list" class="fb-sidebar-list">
                <div class="fb-sidebar-empty">История пока пуста</div>
              </div>
            </section>
          </aside>
          <main id="fb-content" class="fb-content">
            <div class="fb-empty">Загрузка переменных отчёта…</div>
          </main>
        </div>
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
    $('fb-tab-variables').addEventListener('click', () => setSidebarTab('variables'));
    $('fb-tab-history').addEventListener('click', () => setSidebarTab('history'));
    $('fb-list-filter').addEventListener('input', renderVariableList);

    state.panel.addEventListener('keydown', (event) => {
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
      event.stopPropagation();
    });

    [
      'keyup', 'keypress', 'beforeinput', 'input', 'change',
      'copy', 'cut', 'paste', 'compositionstart', 'compositionupdate', 'compositionend',
      'click', 'dblclick', 'contextmenu',
      'pointerdown', 'pointerup', 'pointermove', 'pointercancel',
      'mousedown', 'mouseup', 'mousemove', 'touchstart', 'touchmove', 'touchend',
      'wheel', 'dragstart', 'dragover', 'drop', 'submit', 'focusin', 'focusout',
    ].forEach((eventName) => {
      state.panel.addEventListener(eventName, (event) => event.stopPropagation());
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
    dismissVariablePopover();
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
      renderVariableList();

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
    const variable = state.model.findVariable(query);

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
    renderHistoryList();
  }

  function setSidebarTab(tab) {
    state.sidebarTab = tab;
    const variablesActive = tab === 'variables';
    const variablesTab = state.shadow.getElementById('fb-tab-variables');
    const historyTab = state.shadow.getElementById('fb-tab-history');
    variablesTab.classList.toggle('is-active', variablesActive);
    historyTab.classList.toggle('is-active', !variablesActive);
    variablesTab.setAttribute('aria-selected', String(variablesActive));
    historyTab.setAttribute('aria-selected', String(!variablesActive));
    state.shadow.getElementById('fb-variables-panel').hidden = !variablesActive;
    state.shadow.getElementById('fb-history-panel').hidden = variablesActive;
  }

  function renderVariableList() {
    if (!state.shadow) return;
    const target = state.shadow.getElementById('fb-variable-list');
    const filter = core.normalizeVariableQuery(state.shadow.getElementById('fb-list-filter').value);
    target.replaceChildren();
    const matches = state.variables
      .filter((variable) => {
        if (!filter) return true;
        return `${variableLabel(variable)} ${variable.formula || ''} ${variable.id} ${variable.type || ''} ${variable.varType || ''}`
          .toLocaleLowerCase('ru')
          .includes(filter);
      })
      .sort((a, b) => variableLabel(a).localeCompare(variableLabel(b), 'ru'));
    const regular = matches.filter((variable) => variable.varType !== 'Formula');
    const anonymous = matches.filter((variable) => variable.varType === 'Formula');

    target.appendChild(variableListGroup(`Переменные · ${regular.length}`, regular));
    const anonymousGroup = element('details', 'fb-anonymous-group');
    anonymousGroup.open = Boolean(filter);
    anonymousGroup.appendChild(element('summary', '', `Анонимные формулы · ${anonymous.length}`));
    const anonymousList = element('div', 'fb-variable-items');
    if (!anonymous.length) anonymousList.appendChild(element('div', 'fb-sidebar-empty', 'Нет совпадений'));
    else anonymous.forEach((variable) => anonymousList.appendChild(variableListButton(variable)));
    anonymousGroup.appendChild(anonymousList);
    target.appendChild(anonymousGroup);
  }

  function variableListGroup(title, variables) {
    const group = element('section', 'fb-variable-group');
    group.appendChild(element('div', 'fb-sidebar-heading', title));
    const list = element('div', 'fb-variable-items');
    if (!variables.length) list.appendChild(element('div', 'fb-sidebar-empty', 'Нет совпадений'));
    else variables.forEach((variable) => list.appendChild(variableListButton(variable)));
    group.appendChild(list);
    return group;
  }

  function variableListButton(variable) {
    const button = element('button', 'fb-sidebar-item');
    button.type = 'button';
    button.dataset.variableId = variable.id;
    button.append(
      typeDot(variable.type),
      element('span', 'fb-sidebar-item-main', variableListLabel(variable)),
      element(
        'span',
        'fb-sidebar-item-meta',
        variable.varType === 'Formula' ? String(variable.id).slice(0, 8) : variable.varType || 'Unknown',
      ),
    );
    button.title = `${variable.id} · ${variable.type || 'неизвестный type'} · ${variable.varType || 'неизвестный varType'}`;
    button.addEventListener('click', () => navigate({ kind: 'variable', id: variable.id }));
    return button;
  }

  function renderHistoryList() {
    if (!state.shadow) return;
    const target = state.shadow.getElementById('fb-history-list');
    if (!target) return;
    target.replaceChildren();
    if (!state.history.length) {
      target.appendChild(element('div', 'fb-sidebar-empty', 'История пока пуста'));
      return;
    }
    state.history.forEach((entry, index) => {
      const button = element('button', `fb-sidebar-item fb-history-item${index === state.historyIndex ? ' is-current' : ''}`);
      button.type = 'button';
      const label = entry.kind === 'variable'
        ? variableLabel(state.variablesById.get(entry.id) || { id: entry.id })
        : entry.formula;
      button.append(
        element('span', 'fb-history-index', String(index + 1)),
        element('span', 'fb-sidebar-item-main', label),
        element('span', 'fb-sidebar-item-meta', entry.kind === 'variable' ? 'переменная' : 'формула'),
      );
      button.title = label;
      button.addEventListener('click', () => {
        state.historyIndex = index;
        renderCurrent();
      });
      target.appendChild(button);
    });
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

    main.appendChild(formulaCard(
      'Формула',
      variable.formula || 'Формула отсутствует',
      variable.parsedFormula?.root,
    ));

    const dependencies = state.model.getDependencies(variable.id);
    main.appendChild(dependenciesCard(dependencies));
    main.appendChild(expandedFormulaCard(
      () => state.model.expandFormulaDetailed(variable.id),
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
    main.appendChild(formulaCard('Восстановленная формула', entry.formula, root));

    const dependencies = referencesToVariables(root);
    main.appendChild(dependenciesCard(dependencies));
    main.appendChild(expandedFormulaCard(
      () => state.model.expandExpressionDetailed(entry.source || entry.formula, root),
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
        const controls = element('div', 'fb-expansion-controls');
        const zoneToggle = element('label', 'fb-zone-toggle');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        zoneToggle.append(checkbox, element('span', '', 'Зонирование по исходным переменным'));
        controls.append(
          zoneToggle,
          element('span', 'fb-muted', 'Снимите галочку, чтобы оставить только подсветку синтаксиса.'),
        );
        const formulaHost = element('div');
        const renderExpansion = () => {
          formulaHost.replaceChildren(richFormulaBlock(
            expansion.formula || 'Нет формулы',
            null,
            checkbox.checked ? expansion.zones : [],
          ));
        };
        checkbox.addEventListener('change', renderExpansion);
        body.append(controls, formulaHost);
        renderExpansion();
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

  function variableListLabel(variable) {
    if (typeof variable?.name === 'string' && variable.name.length) return variable.name;
    if (variable?.varType === 'Formula' && typeof variable.formula === 'string' && variable.formula.length) {
      const singleLine = variable.formula.replace(/\s+/g, ' ').trim();
      return singleLine.length > 90 ? `${singleLine.slice(0, 90)}…` : singleLine;
    }
    return variableLabel(variable);
  }

  function formulaCard(title, formula, root = null) {
    return sectionCard(title, richFormulaBlock(formula, root));
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

  function richFormulaBlock(value, root = null, zones = []) {
    const formula = value == null ? '—' : String(value);
    const block = element('pre', 'fb-code fb-code-rich');
    const syntaxSource = formula.slice(0, 50000);
    const allTokens = state.model
      ? state.model.tokenizeFormula(syntaxSource, root)
      : [{ kind: 'text', text: syntaxSource, start: 0, length: syntaxSource.length }];
    const tokens = allTokens.slice(0, 5000);
    const highlightedEnd = tokens.length
      ? tokens[tokens.length - 1].start + tokens[tokens.length - 1].length
      : 0;
    const validZones = (Array.isArray(zones) ? zones : [])
      .filter((zone) => (
        zone && Number.isInteger(zone.start) && Number.isInteger(zone.length) &&
        zone.start >= 0 && zone.length > 0 && zone.start + zone.length <= highlightedEnd
      ))
      .sort((a, b) => a.start - b.start)
      .filter((zone, index, all) => index === 0 || zone.start >= all[index - 1].start + all[index - 1].length)
      .slice(0, 100);
    let cursor = 0;

    validZones.forEach((zone, index) => {
      appendFormulaTokens(block, tokens, cursor, zone.start);
      const wrapper = element('span', `fb-origin-zone fb-zone-${index % 6}`);
      const label = element('button', 'fb-origin-label', zone.label || zone.variableId);
      label.type = 'button';
      label.title = `Открыть переменную ${zone.label || zone.variableId}`;
      label.addEventListener('click', () => navigate({ kind: 'variable', id: zone.variableId }));
      const code = element('span', 'fb-origin-code');
      appendFormulaTokens(code, tokens, zone.start, zone.start + zone.length);
      wrapper.append(label, code);
      block.appendChild(wrapper);
      cursor = zone.start + zone.length;
    });
    appendFormulaTokens(block, tokens, cursor, highlightedEnd);
    if (highlightedEnd < formula.length) {
      const tail = element('span', 'fb-token-unhighlighted', formula.slice(highlightedEnd));
      tail.title = 'Для производительности подсветка ограничена первыми 5000 токенами / 50000 символами';
      block.appendChild(tail);
    }
    return block;
  }

  function appendFormulaTokens(container, tokens, rangeStart, rangeEnd) {
    tokens.forEach((token) => {
      const tokenEnd = token.start + token.length;
      const start = Math.max(rangeStart, token.start);
      const end = Math.min(rangeEnd, tokenEnd);
      if (start >= end) return;
      const text = token.text.slice(start - token.start, end - token.start);
      const isWholeToken = start === token.start && end === tokenEnd;
      if (token.kind === 'variable' && isWholeToken) {
        container.appendChild(formulaVariableToken(token, text));
      } else {
        container.appendChild(element('span', `fb-token fb-token-${token.kind}`, text));
      }
    });
  }

  function formulaVariableToken(token, text) {
    const candidateIds = Array.isArray(token.candidateIds) ? token.candidateIds : [];
    const canOpen = Boolean(token.variableId) || candidateIds.length > 0;
    const node = element(
      canOpen ? 'button' : 'span',
      `fb-formula-variable fb-type-${normalizeTypeClass(token.variableType)}${canOpen ? '' : ' is-missing'}`,
      text,
    );
    if (!canOpen) {
      node.title = 'Переменная отсутствует в REP.GET_VARIABLES';
      return node;
    }
    node.type = 'button';
    node.title = candidateIds.length > 1
      ? `Найдено одноимённых переменных: ${candidateIds.length}`
      : 'Открыть переменную';
    node.addEventListener('click', () => {
      if (token.variableId) {
        navigate({ kind: 'variable', id: token.variableId });
      } else if (candidateIds.length === 1) {
        navigate({ kind: 'variable', id: candidateIds[0] });
      } else {
        showVariablePopover(node, candidateIds, text);
      }
    });
    return node;
  }

  function showVariablePopover(anchor, candidateIds, label) {
    dismissVariablePopover();
    const popover = element('div', 'fb-variable-popover');
    const header = element('div', 'fb-popover-header');
    header.append(
      element('strong', '', label),
      element('span', 'fb-muted', 'Выберите одноимённую переменную'),
    );
    const close = element('button', 'fb-popover-close', '×');
    close.type = 'button';
    close.title = 'Закрыть';
    close.addEventListener('click', dismissVariablePopover);
    popover.append(header, close);
    candidateIds.forEach((id) => {
      const variable = state.variablesById.get(id);
      if (!variable) return;
      const button = element('button', 'fb-popover-option');
      button.type = 'button';
      button.append(
        typeDot(variable.type),
        element('span', '', variableLabel(variable)),
        element('small', '', `${variable.varType || 'Unknown'} · ${variable.id}`),
      );
      button.addEventListener('click', () => {
        dismissVariablePopover();
        navigate({ kind: 'variable', id });
      });
      popover.appendChild(button);
    });
    state.panel.appendChild(popover);
    state.popover = popover;
    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const panelRect = state.panel.getBoundingClientRect();
    const left = clamp(
      anchorRect.left - panelRect.left,
      8,
      Math.max(8, panelRect.width - popoverRect.width - 8),
    );
    const below = anchorRect.bottom - panelRect.top + 6;
    const above = anchorRect.top - panelRect.top - popoverRect.height - 6;
    const top = below + popoverRect.height <= panelRect.height - 8 ? below : above;
    popover.style.left = `${left}px`;
    popover.style.top = `${clamp(top, 8, Math.max(8, panelRect.height - popoverRect.height - 8))}px`;
  }

  function dismissVariablePopover() {
    state.popover?.remove();
    state.popover = null;
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
        width: min(1280px, calc(100vw - 48px));
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
      .fb-workspace { min-height: 0; display: grid; grid-template-columns: 250px minmax(0, 1fr); }
      .fb-browser-sidebar {
        min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr);
        border-right: 1px solid #dbe3ee; background: #f8fafc;
      }
      .fb-sidebar-tabs { display: grid; grid-template-columns: 1fr 1fr; padding: 8px; gap: 5px; border-bottom: 1px solid #dbe3ee; background: #fff; }
      .fb-sidebar-tab { min-height: 30px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: #64748b; font-weight: 650; cursor: pointer; }
      .fb-sidebar-tab:hover { background: #f0f4f8; }
      .fb-sidebar-tab.is-active { border-color: #bcd0ec; background: #eaf2fd; color: #255da9; }
      .fb-sidebar-panel { min-height: 0; overflow: auto; padding: 9px 8px 12px; }
      .fb-list-filter { position: sticky; top: 0; z-index: 1; margin-bottom: 9px; box-shadow: 0 4px 10px rgba(248,250,252,.95); }
      .fb-sidebar-list { display: grid; gap: 9px; }
      .fb-variable-group, .fb-variable-items { display: grid; gap: 3px; }
      .fb-sidebar-heading { padding: 3px 6px; color: #718096; font-size: 10px; font-weight: 750; letter-spacing: .05em; text-transform: uppercase; }
      .fb-anonymous-group { border-top: 1px solid #e2e8f0; padding-top: 7px; }
      .fb-anonymous-group > summary { padding: 5px 6px; color: #64748b; font-size: 11px; font-weight: 700; cursor: pointer; }
      .fb-anonymous-group .fb-variable-items { margin-top: 4px; }
      .fb-sidebar-item {
        width: 100%; min-width: 0; display: grid; grid-template-columns: 10px minmax(0, 1fr) auto;
        align-items: center; gap: 7px; padding: 7px 7px; border: 1px solid transparent; border-radius: 7px;
        background: transparent; color: #334155; text-align: left; cursor: pointer;
      }
      .fb-sidebar-item:hover { border-color: #d5e0ed; background: #fff; }
      .fb-sidebar-item.is-current { border-color: #a9c5e9; background: #eaf2fd; color: #174f91; }
      .fb-sidebar-item-main { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .fb-sidebar-item-meta { color: #8a97aa; font-size: 9px; white-space: nowrap; }
      .fb-sidebar-empty { padding: 12px 7px; color: #8492a6; font-size: 11px; text-align: center; }
      .fb-history-item { grid-template-columns: 22px minmax(0, 1fr) auto; }
      .fb-history-index { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 6px; background: #e9eef5; color: #64748b; font-size: 10px; font-variant-numeric: tabular-nums; }
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
      .fb-code-rich { position: relative; }
      .fb-token-function { color: #7252a3; font-weight: 700; }
      .fb-token-string { color: #a34d38; }
      .fb-token-number { color: #126f6a; }
      .fb-token-operator { color: #475569; font-weight: 700; }
      .fb-token-punctuation { color: #778397; }
      .fb-token-identifier { color: #704c16; }
      .fb-token-unhighlighted { color: #64748b; }
      .fb-formula-variable {
        display: inline; margin: 0; padding: 1px 4px; border: 1px solid transparent; border-radius: 5px;
        color: #fff; font: inherit; font-weight: 650; line-height: inherit; cursor: pointer; box-decoration-break: clone;
      }
      .fb-formula-variable:hover { filter: brightness(1.07); box-shadow: 0 0 0 2px rgba(43,109,208,.17); }
      .fb-formula-variable.is-missing { border-color: #cbd5e1; background: #eef1f5; color: #64748b; cursor: help; }
      .fb-origin-zone {
        display: inline-flex; flex-direction: column; vertical-align: middle; margin: 9px 2px 2px;
        border: 1px solid #9fc5df; border-radius: 7px; background: rgba(219,239,252,.48);
      }
      .fb-origin-label {
        max-width: 210px; margin: -10px 4px 0; padding: 1px 5px; overflow: hidden; border: 0; border-radius: 4px;
        background: #3f7fa8; color: #fff; font: 600 9px/1.4 Inter, Roboto, sans-serif;
        text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
      }
      .fb-origin-label:hover { text-decoration: underline; }
      .fb-origin-code { padding: 1px 4px 2px; }
      .fb-zone-1 { border-color: #d6b06b; background: rgba(255,237,197,.52); }
      .fb-zone-1 .fb-origin-label { background: #a87825; }
      .fb-zone-2 { border-color: #91c89e; background: rgba(222,246,226,.52); }
      .fb-zone-2 .fb-origin-label { background: #478555; }
      .fb-zone-3 { border-color: #bea3d8; background: rgba(238,226,250,.52); }
      .fb-zone-3 .fb-origin-label { background: #76539a; }
      .fb-zone-4 { border-color: #dda3a9; background: rgba(252,228,231,.52); }
      .fb-zone-4 .fb-origin-label { background: #a65b65; }
      .fb-zone-5 { border-color: #8cc8c5; background: rgba(218,245,242,.52); }
      .fb-zone-5 .fb-origin-label { background: #367e79; }
      .fb-expansion-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
      .fb-zone-toggle { display: inline-flex; align-items: center; gap: 6px; color: #334155; font-weight: 600; cursor: pointer; }
      .fb-zone-toggle input { width: 15px; min-width: 15px; height: 15px; margin: 0; }
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
      .fb-variable-popover {
        position: absolute; z-index: 2147483647; width: min(360px, calc(100% - 16px)); max-height: 360px;
        overflow: auto; padding: 10px; border: 1px solid #b9c9dc; border-radius: 10px; background: #fff;
        color: #172033; box-shadow: 0 14px 40px rgba(15,23,42,.28); font-family: Inter, Roboto, sans-serif;
      }
      .fb-popover-header { display: grid; gap: 2px; padding: 0 30px 8px 2px; }
      .fb-popover-close { position: absolute; right: 7px; top: 6px; width: 27px; height: 27px; border: 0; border-radius: 6px; background: transparent; color: #64748b; font-size: 18px; cursor: pointer; }
      .fb-popover-close:hover { background: #edf2f7; }
      .fb-popover-option { width: 100%; display: grid; grid-template-columns: 10px minmax(0, 1fr); gap: 2px 8px; align-items: center; padding: 8px; border: 0; border-top: 1px solid #edf1f5; background: #fff; color: #255da9; text-align: left; cursor: pointer; }
      .fb-popover-option:hover { background: #eef5ff; }
      .fb-popover-option small { grid-column: 2; color: #8492a6; overflow-wrap: anywhere; }
      @media (max-width: 820px) {
        .fb-window { min-width: calc(100vw - 24px); }
        .fb-workspace { grid-template-columns: 205px minmax(0, 1fr); }
        .fb-layout { grid-template-columns: 1fr; }
        .fb-toolbar { flex-wrap: wrap; }
        .fb-search-form { order: 2; flex-basis: 100%; }
        .fb-shortcuts { display: none; }
      }
    `;
  }
})();
