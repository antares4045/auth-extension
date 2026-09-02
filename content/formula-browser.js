(function () {
  'use strict';

  const core = globalThis.FormulaBrowserCore;
  const GROUPING_STORAGE_KEY = 'formulaBrowserVariableGrouping';
  const ZONE_MODE_STORAGE_KEY = 'formulaBrowserZoneMode';
  const EXPANSION_OPEN_STORAGE_KEY = 'formulaBrowserExpansionOpen';
  const EXPANSION_DEPTH_STORAGE_KEY = 'formulaBrowserExpansionDepth';
  const PARENTHESIS_HIGHLIGHT_STORAGE_KEY = 'formulaBrowserParenthesisHighlight';
  const REVALIDATE_OPENED_STORAGE_KEY = 'formulaBrowserRevalidateOpenedVariables';
  const REVALIDATE_CONCURRENCY = 4;
  const POPOVER_CANDIDATE_LIMIT = 100;
  const POPOVER_CANDIDATE_BATCH = 10;
  const POPOVER_SOURCE_LIMIT = 5;
  const TREE_RENDER_BUDGET = 2000;
  const TREE_EXPAND_BATCH = 100;
  const TYPE_ICON_PATHS = {
    dimension: [
      'M13.3333 11.9531V13H3V2.66667L4 2.66678L2 0L0 2.66667H1V15H13.3333V16L16 14L13.3333 11.9531Z',
      'M5 11H14V2H5V11ZM7 4H12V9H7V4Z',
    ],
    measure: [
      'M11 5L0 16C4.22329 16 11 16 11 16C11 14.7331 11 5 11 5ZM5 14L9 10V14H5Z',
      'M12 16V0H14V1H16V3H14V5H16V7H14V9H16V11H14V13H16V15H14V16H12Z',
    ],
    attribute: [
      'M2.00002 0L4.00002 3H3.00002L2.99996 9.9999L0.99997 10L1.00002 3H0.0000194152L2.00002 0Z',
      'M13 13V12L16 14L13 16V15H6.00002V13H13Z',
      'M7 11H13V3.00002H5.00002L5.00001 8.99999H7V11ZM7 4.99999H11V8.99999H7V4.99999Z',
      'M1.6 11.9998H2.4V13.5998H3.99999V14.3998H2.4V15.9998H1.6V14.3998H0V13.5998H1.6V11.9998Z',
      'M2.99999 12.9998V11.9998H3.99999V12.9998H2.99999Z',
      'M2.99999 14.9998H3.99999L3.99999 15.9998H2.99999V14.9998Z',
      'M1 14.9998V15.9998H0L0 14.9998H1Z',
      'M1 12.9998H0.0000000655668V11.9998H1V12.9998Z',
    ],
  };
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
    sourceVariables: [],
    sourceVariablesById: new Map(),
    dps: [],
    model: null,
    variableValidations: new Map(),
    validationGraphRuns: new Map(),
    validationGeneration: 0,
    validationModeRevision: 0,
    pendingValidationRender: false,
    reportFingerprint: null,
    loadingFingerprint: null,
    loaded: false,
    loading: false,
    loadController: null,
    history: core.createNavigationHistory(),
    sidebarTab: 'variables',
    variableGrouping: 'request',
    zoneMode: 'none',
    expansionOpen: false,
    expansionDepth: { kind: 'unlimited' },
    parenthesisHighlight: true,
    revalidateOpenedVariables: false,
    preferencesLoaded: false,
    preferencesPromise: null,
    popover: null,
    popoverAnchor: null,
    popoverSequence: 0,
    suppressPopoverFocus: false,
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
    if (!state.preferencesLoaded) await loadUiPreferences();
    const fingerprint = currentReportFingerprint();
    const reportChanged = (
      (state.loaded && state.reportFingerprint !== fingerprint) ||
      (state.loading && state.loadingFingerprint !== fingerprint)
    );
    if (reportChanged) invalidateReportData();
    if (!state.loaded) {
      const restartAbortedLoad = state.loadController?.signal.aborted === true;
      if (!state.loading || restartAbortedLoad || reportChanged) {
        void loadData(restartAbortedLoad || reportChanged);
      }
    }
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
            <textarea id="fb-formula" rows="2" maxlength="200000" spellcheck="false" placeholder="=max([a] where ([b] &lt; [c]))"></textarea>
            <button id="fb-analyze" class="fb-button fb-button-primary" type="button">Анализировать</button>
          </div>
          <div class="fb-editor-meta">
            <div class="fb-shortcuts">Ctrl+Enter — анализ · Alt+←/→ — история · двойной клик по переменной — перейти · Esc — скрыть</div>
            <div class="fb-preference-controls">
              <label class="fb-checkbox-control">
                <input id="fb-revalidate-opened" type="checkbox" disabled />
                <span>Перепроверять открытые переменные</span>
              </label>
              <label class="fb-checkbox-control">
                <input id="fb-parenthesis-highlight" type="checkbox" checked disabled />
                <span>Подсвечивать скобки</span>
              </label>
            </div>
          </div>
        </div>

        <div class="fb-workspace">
          <aside class="fb-browser-sidebar" aria-label="Навигация браузера формул">
            <div class="fb-sidebar-tabs" role="tablist">
              <button id="fb-tab-variables" class="fb-sidebar-tab is-active" type="button" role="tab" aria-selected="true">Переменные</button>
              <button id="fb-tab-history" class="fb-sidebar-tab" type="button" role="tab" aria-selected="false">История</button>
            </div>
            <section id="fb-variables-panel" class="fb-sidebar-panel" role="tabpanel">
              <input id="fb-list-filter" class="fb-list-filter" autocomplete="off" placeholder="Фильтр списка…" />
              <div class="fb-list-grouping" role="group" aria-label="Группировка переменных">
                <button id="fb-group-request" class="fb-group-button is-active" type="button">По запросам</button>
                <button id="fb-group-alphabet" class="fb-group-button" type="button">По алфавиту</button>
              </div>
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
    $('fb-revalidate-opened').addEventListener('change', (event) => {
      state.validationModeRevision += 1;
      state.revalidateOpenedVariables = event.currentTarget.checked;
      state.validationGraphRuns.clear();
      persistUiPreference(
        REVALIDATE_OPENED_STORAGE_KEY,
        state.revalidateOpenedVariables,
        'Не удалось сохранить повторную проверку переменных',
      );
      rebuildActiveVariables();
      state.pendingValidationRender = false;
      dismissVariablePopover();
      renderCurrent();
      if (state.revalidateOpenedVariables) {
        const entry = state.history.current();
        if (entry?.kind === 'variable') startVariableValidationGraph(entry.id);
      }
    });
    $('fb-parenthesis-highlight').addEventListener('change', (event) => {
      state.parenthesisHighlight = event.currentTarget.checked;
      persistUiPreference(
        PARENTHESIS_HIGHLIGHT_STORAGE_KEY,
        state.parenthesisHighlight,
        'Не удалось сохранить подсветку парных скобок',
      );
      if (!state.parenthesisHighlight) clearAllParenthesisHighlights();
    });
    $('fb-search-form').addEventListener('submit', openSearchResult);
    $('fb-search').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      $('fb-search-form').requestSubmit();
    });
    $('fb-tab-variables').addEventListener('click', () => setSidebarTab('variables'));
    $('fb-tab-history').addEventListener('click', () => setSidebarTab('history'));
    $('fb-list-filter').addEventListener('input', renderVariableList);
    $('fb-group-request').addEventListener('click', () => setVariableGrouping('request'));
    $('fb-group-alphabet').addEventListener('click', () => setVariableGrouping('alphabet'));
    state.panel.addEventListener('pointerdown', (event) => {
      if (!state.popover || event.target.closest('.fb-variable-popover')) return;
      dismissVariablePopover();
    });

    state.panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (state.popover) dismissVariablePopover(true);
        else hideBrowser();
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
    state.loadController?.abort();
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
    if (state.loading && !force) return;
    if (state.loaded && !force) return;
    if (force) state.loadController?.abort();
    const controller = new AbortController();
    const requestFingerprint = currentReportFingerprint();
    state.loadController = controller;
    state.loadingFingerprint = requestFingerprint;
    state.loading = true;
    setBusy(true);
    setStatus('Загрузка REP.GET_VARIABLES и REP.GET_DP_LIST…', 'neutral');

    try {
      const [variablesResponse, dpsResult] = await Promise.all([
        requestJson('REP.GET_VARIABLES', {}, { signal: controller.signal }),
        requestJson('REP.GET_DP_LIST', {}, { signal: controller.signal })
          .then((response) => {
            if (response.result !== 1 || !Array.isArray(response.dps)) {
              throw new Error('REP.GET_DP_LIST не вернул список источников');
            }
            return { response, error: null };
          })
          .catch((error) => {
            if (controller.signal.aborted) throw error;
            return { response: { dps: [] }, error };
          }),
      ]);

      if (controller.signal.aborted || state.loadController !== controller) return;
      if (currentReportFingerprint() !== requestFingerprint) {
        if (state.host?.style.display !== 'none') void loadData(true);
        return;
      }

      if (variablesResponse.result !== 1 || !Array.isArray(variablesResponse.variables)) {
        throw new Error('REP.GET_VARIABLES не вернул список переменных');
      }

      const rawVariables = variablesResponse.variables;
      state.sourceVariables = rawVariables.filter(
        (variable) =>
          variable &&
          typeof variable === 'object' &&
          hasUsableId(variable.id),
      );
      state.sourceVariablesById = new Map(
        state.sourceVariables.map((variable) => [variable.id, variable]),
      );
      state.validationGeneration += 1;
      state.variableValidations.clear();
      state.validationGraphRuns.clear();
      const rawDps = Array.isArray(dpsResult.response.dps) ? dpsResult.response.dps : [];
      state.dps = rawDps.filter(
        (dp) =>
          dp &&
          typeof dp === 'object' &&
          hasUsableId(dp.dp_id),
      );
      rebuildActiveVariables();
      state.reportFingerprint = requestFingerprint;
      state.loaded = true;
      populateVariableOptions();
      renderVariableList();

      if (state.history.current()) renderCurrent();
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
      if (controller.signal.aborted) return;
      renderError(error.message);
      setStatus(error.message, 'error');
    } finally {
      if (state.loadController === controller) {
        state.loading = false;
        state.loadController = null;
        state.loadingFingerprint = null;
        setBusy(false);
      }
    }
  }

  function currentReportFingerprint() {
    const receiver = sessionStorage.getItem('receiver') ?? localStorage.getItem('receiver');
    const streamreceiver = sessionStorage.getItem('streamreceiver')
      ?? localStorage.getItem('streamreceiver');
    return core.createReportFingerprint(window.location.href, receiver, streamreceiver);
  }

  function invalidateReportData() {
    state.loadController?.abort();
    state.validationGeneration += 1;
    state.pendingValidationRender = false;
    dismissVariablePopover();
    state.variables = [];
    state.variablesById = new Map();
    state.sourceVariables = [];
    state.sourceVariablesById = new Map();
    state.dps = [];
    state.model = null;
    state.variableValidations.clear();
    state.validationGraphRuns.clear();
    state.reportFingerprint = null;
    state.loaded = false;
    state.history = core.createNavigationHistory();
    updateHistoryControls();
    state.shadow.getElementById('fb-search').value = '';
    state.shadow.getElementById('fb-variable-list').replaceChildren(
      element('div', 'fb-sidebar-empty', 'Загрузка…'),
    );
    state.shadow.getElementById('fb-content').replaceChildren(
      element('div', 'fb-empty', 'Загрузка переменных нового отчёта…'),
    );
    setStatus('Обнаружен другой отчёт · обновление переменных…', 'neutral');
  }

  async function requestJson(command, params, options = {}) {
    const bridge = globalThis.AuthInjectorBridge;
    if (!bridge?.requestJson) throw new Error('API-мост расширения не инициализирован');
    return bridge.requestJson(command, params, true, options);
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
    if (!state.history.visit(entry)) return;
    renderCurrent();
  }

  function goBack() {
    if (!state.history.back()) return;
    renderCurrent();
  }

  function goForward() {
    if (!state.history.forward()) return;
    renderCurrent();
  }

  function updateHistoryControls() {
    if (!state.shadow) return;
    const history = state.history.snapshot();
    state.shadow.getElementById('fb-back').disabled = !history.canBack;
    state.shadow.getElementById('fb-forward').disabled = !history.canForward;
    state.shadow.getElementById('fb-history-position').textContent =
      history.currentIndex < 0 ? '0 / 0' : `${history.position} / ${history.length}`;
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

  async function loadUiPreferences() {
    if (state.preferencesLoaded) return;
    if (!state.preferencesPromise) {
      state.preferencesPromise = (async () => {
        try {
          const stored = await chrome.storage.sync.get([
            GROUPING_STORAGE_KEY,
            ZONE_MODE_STORAGE_KEY,
            EXPANSION_OPEN_STORAGE_KEY,
            EXPANSION_DEPTH_STORAGE_KEY,
            PARENTHESIS_HIGHLIGHT_STORAGE_KEY,
            REVALIDATE_OPENED_STORAGE_KEY,
          ]);
          const grouping = stored?.[GROUPING_STORAGE_KEY];
          setVariableGrouping(grouping === 'alphabet' ? 'alphabet' : 'request', false);
          state.zoneMode = ['none', 'direct', 'all'].includes(stored?.[ZONE_MODE_STORAGE_KEY])
            ? stored[ZONE_MODE_STORAGE_KEY]
            : 'none';
          state.expansionOpen = stored?.[EXPANSION_OPEN_STORAGE_KEY] === true;
          const depth = core.parseExpansionDepth(stored?.[EXPANSION_DEPTH_STORAGE_KEY]);
          state.expansionDepth = depth.kind === 'invalid' ? { kind: 'unlimited' } : depth;
          state.parenthesisHighlight = stored?.[PARENTHESIS_HIGHLIGHT_STORAGE_KEY] !== false;
          state.revalidateOpenedVariables = stored?.[REVALIDATE_OPENED_STORAGE_KEY] === true;
        } catch {
          setVariableGrouping('request', false);
          state.zoneMode = 'none';
          state.expansionOpen = false;
          state.expansionDepth = { kind: 'unlimited' };
          state.parenthesisHighlight = true;
          state.revalidateOpenedVariables = false;
        } finally {
          const parenthesisInput = state.shadow.getElementById('fb-parenthesis-highlight');
          parenthesisInput.checked = state.parenthesisHighlight;
          parenthesisInput.disabled = false;
          const revalidateInput = state.shadow.getElementById('fb-revalidate-opened');
          revalidateInput.checked = state.revalidateOpenedVariables;
          revalidateInput.disabled = false;
          rebuildActiveVariables();
          state.preferencesLoaded = true;
        }
      })();
    }
    await state.preferencesPromise;
  }

  function persistUiPreference(key, value, warning) {
    chrome.storage.sync.set({ [key]: value }).catch(() => {
      setStatus(warning, 'warning');
    });
  }

  function setVariableGrouping(grouping, persist = true) {
    state.variableGrouping = grouping === 'alphabet' ? 'alphabet' : 'request';
    if (!state.shadow) return;
    state.shadow.getElementById('fb-group-request').classList.toggle(
      'is-active',
      state.variableGrouping === 'request',
    );
    state.shadow.getElementById('fb-group-alphabet').classList.toggle(
      'is-active',
      state.variableGrouping === 'alphabet',
    );
    renderVariableList();
    if (persist) {
      chrome.storage.sync.set({ [GROUPING_STORAGE_KEY]: state.variableGrouping }).catch(() => {
        setStatus('Не удалось сохранить режим группировки', 'warning');
      });
    }
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
    const regular = matches.filter((variable) => variableSection(variable) !== 'anonymous');
    const anonymous = matches.filter((variable) => variableSection(variable) === 'anonymous');

    if (state.variableGrouping === 'alphabet') {
      target.appendChild(variableListGroup('Все переменные', regular));
    } else {
      renderRequestGroups(target, regular);
    }
    const anonymousGroup = element('details', 'fb-anonymous-group');
    anonymousGroup.open = Boolean(filter);
    anonymousGroup.appendChild(element('summary', '', `Анонимные формулы · ${anonymous.length}`));
    const anonymousList = element('div', 'fb-variable-items');
    if (!anonymous.length) anonymousList.appendChild(element('div', 'fb-sidebar-empty', 'Нет совпадений'));
    else anonymous.forEach((variable) => anonymousList.appendChild(variableListButton(variable)));
    anonymousGroup.appendChild(anonymousList);
    target.appendChild(anonymousGroup);
  }

  function renderRequestGroups(target, variables) {
    const directDpVariables = variables.filter((variable) => variableSection(variable) === 'request');
    const knownDpIds = new Set(state.dps.map((dp) => String(dp.dp_id)));
    let renderedGroups = 0;

    state.dps.forEach((dp) => {
      const group = directDpVariables.filter(
        (variable) => String(variable.dp_id) === String(dp.dp_id),
      );
      if (!group.length) return;
      target.appendChild(variableListGroup(dp.dpName || dp.dp_id, group, dp.dp_id));
      renderedGroups += 1;
    });

    const unknownDps = new Map();
    directDpVariables.forEach((variable) => {
      const dpId = hasUsableId(variable.dp_id) ? String(variable.dp_id) : 'Без DP';
      if (knownDpIds.has(dpId)) return;
      const group = unknownDps.get(dpId) || [];
      group.push(variable);
      unknownDps.set(dpId, group);
    });
    unknownDps.forEach((group, dpId) => {
      target.appendChild(variableListGroup(dpId, group, 'Источник не найден в REP.GET_DP_LIST'));
      renderedGroups += 1;
    });

    const merge = variables.filter((variable) => variableSection(variable) === 'merge');
    if (merge.length) {
      target.appendChild(variableListGroup('Объединённые переменные', merge));
      renderedGroups += 1;
    }
    const general = variables.filter((variable) => variableSection(variable) === 'general');
    if (general.length) {
      target.appendChild(variableListGroup('Пользовательские переменные', general));
      renderedGroups += 1;
    }
    if (!renderedGroups) target.appendChild(element('div', 'fb-sidebar-empty', 'Нет совпадений'));
  }

  function variableListGroup(title, variables, subtitle = '') {
    const group = element('details', 'fb-variable-group');
    group.open = true;
    const summary = element('summary', 'fb-sidebar-heading');
    summary.append(
      element('span', '', title),
      element('span', 'fb-group-count', String(variables.length)),
    );
    if (subtitle) summary.title = subtitle;
    group.appendChild(summary);
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
        objectTypeLabel(variable.type),
      ),
    );
    button.title = `${variable.id} · ${variable.type || 'неизвестный type'} · ${variable.varType || 'неизвестный varType'}`;
    button.addEventListener('click', () => navigate({ kind: 'variable', id: variable.id }));
    return button;
  }

  function variableSection(variable) {
    if (variable?.varType === 'DP') return 'request';
    if (variable?.varType === 'Merge') return 'merge';
    if (variable?.varType === 'Formula') return 'anonymous';
    return 'general';
  }

  function renderHistoryList() {
    if (!state.shadow) return;
    const target = state.shadow.getElementById('fb-history-list');
    if (!target) return;
    target.replaceChildren();
    const history = state.history.snapshot();
    if (!history.entries.length) {
      target.appendChild(element('div', 'fb-sidebar-empty', 'История пока пуста'));
      return;
    }
    history.entries.forEach((entry, index) => {
      const button = element('button', `fb-sidebar-item fb-history-item${index === history.currentIndex ? ' is-current' : ''}`);
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
        state.history.select(index);
        renderCurrent();
      });
      target.appendChild(button);
    });
  }

  function renderCurrent() {
    updateHistoryControls();
    const entry = state.history.current();
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
    startVariableValidationGraph(variableId);
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
    const validationBadge = variableValidationBadge(variable.id);
    if (validationBadge) badges.appendChild(validationBadge);
    heading.append(headingText, badges);
    main.appendChild(card(heading, 'fb-heading-card'));
    const validationNotice = variableValidationNotice(variable.id);
    if (validationNotice) main.appendChild(validationNotice);

    main.appendChild(formulaCard(
      'Формула',
      variable.formula || 'Формула отсутствует',
      variable.parsedFormula?.root,
    ));

    const dependencies = state.model.getDependencies(variable.id);
    main.appendChild(dependenciesCard(dependencies));
    main.appendChild(expandedFormulaCard(
      (options) => state.model.expandFormulaDetailed(variable.id, options),
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
      (options) => state.model.expandExpressionDetailed(
        entry.source || entry.formula,
        root,
        options,
      ),
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
      richFormulaBlock(formula),
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
      richFormulaBlock(formula),
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
        const button = element('button', 'fb-dependency');
        button.type = 'button';
        button.append(typeDot(variable.type), element('span', '', variable.name || variable.id));
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
    details.open = state.expansionOpen;

    const renderBody = () => {
      if (rendered) return;
      rendered = true;
      try {
        let expansion;
        const controls = element('div', 'fb-expansion-controls');
        const zoneModes = element('div', 'fb-zone-modes');
        zoneModes.setAttribute('role', 'group');
        zoneModes.setAttribute('aria-label', 'Режим зонирования формулы');
        const formulaHost = element('div');
        const warningsHost = element('div');
        const renderExpansion = () => {
          const zones = state.zoneMode === 'all'
            ? expansion.allZones || expansion.zones
            : state.zoneMode === 'direct'
              ? expansion.zones
              : [];
          formulaHost.replaceChildren(richFormulaBlock(
            expansion.formula || 'Нет формулы',
            null,
            zones,
          ));
          zoneModes.querySelectorAll('.fb-zone-mode').forEach((button) => {
            const active = button.dataset.mode === state.zoneMode;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
          });
        };
        const refreshExpansion = () => {
          expansion = getExpansion({
            maxDepth: state.expansionDepth.kind === 'limited'
              ? state.expansionDepth.value
              : Infinity,
          });
          renderExpansion();
          warningsHost.replaceChildren(...expansion.warnings.map(
            (warning) => element('div', 'fb-warning', warning),
          ));
        };
        [
          ['none', 'Без зон'],
          ['direct', 'Верхний уровень'],
          ['all', 'Все уровни'],
        ].forEach(([mode, label]) => {
          const button = element('button', 'fb-zone-mode', label);
          button.type = 'button';
          button.dataset.mode = mode;
          button.addEventListener('click', () => {
            state.zoneMode = mode;
            persistUiPreference(
              ZONE_MODE_STORAGE_KEY,
              mode,
              'Не удалось сохранить режим зонирования',
            );
            renderExpansion();
          });
          zoneModes.appendChild(button);
        });
        const depthControl = element('label', 'fb-depth-control');
        const depthInput = element('input', 'fb-depth-input');
        depthInput.type = 'number';
        depthInput.min = '1';
        depthInput.step = '1';
        depthInput.inputMode = 'numeric';
        depthInput.placeholder = '∞';
        depthInput.value = state.expansionDepth.kind === 'limited'
          ? state.expansionDepth.value
          : '';
        depthInput.setAttribute('aria-label', 'Количество раскрываемых уровней вложенности');
        depthInput.title = 'Пусто — без пользовательского ограничения глубины';
        depthInput.addEventListener('change', () => {
          const depth = core.parseExpansionDepth(depthInput.value);
          if (depth.kind === 'invalid') {
            depthInput.value = state.expansionDepth.kind === 'limited'
              ? state.expansionDepth.value
              : '';
            setStatus('Глубина должна быть целым числом от 1 или оставаться пустой', 'warning');
            return;
          }
          state.expansionDepth = depth;
          depthInput.value = depth.kind === 'limited' ? depth.value : '';
          persistUiPreference(
            EXPANSION_DEPTH_STORAGE_KEY,
            depth.kind === 'limited' ? depth.value : null,
            'Не удалось сохранить глубину полной развёртки',
          );
          refreshExpansion();
        });
        depthControl.append(
          element('span', '', 'Уровней'),
          depthInput,
        );
        controls.append(
          zoneModes,
          depthControl,
          element('span', 'fb-muted', 'Зоны показывают происхождение фрагментов раскрытой формулы.'),
        );
        body.append(controls, formulaHost, warningsHost);
        refreshExpansion();
      } catch (error) {
        body.appendChild(element('div', 'fb-warning', error.message));
      }
    };

    details.addEventListener('toggle', () => {
      state.expansionOpen = details.open;
      persistUiPreference(
        EXPANSION_OPEN_STORAGE_KEY,
        details.open,
        'Не удалось сохранить состояние полной развёртки',
      );
      if (details.open) renderBody();
    });
    if (details.open) queueMicrotask(() => {
      if (details.isConnected) renderBody();
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
    else {
      const treeContext = {
        root: null,
        button: null,
        remaining: TREE_RENDER_BUDGET,
        batchActive: false,
        operation: 0,
        truncated: false,
      };
      const tree = renderReferenceTree(refs, ancestors, treeContext);
      treeContext.root = tree;
      if (tree.querySelector('.fb-tree-toggle, .fb-tree-more')) {
        const controls = element('div', 'fb-tree-controls');
        const expandAll = element('button', 'fb-tree-expand-all', 'Развернуть всё');
        expandAll.type = 'button';
        treeContext.button = expandAll;
        expandAll.addEventListener('click', () => toggleWholeTree(treeContext));
        controls.appendChild(expandAll);
        body.appendChild(controls);
      }
      body.appendChild(tree);
      syncWholeTreeButton(treeContext);
    }
    return sectionCard('Дерево зависимостей', body);
  }

  async function toggleWholeTree(context) {
    const { root: tree, button } = context;
    const operation = context.operation + 1;
    context.operation = operation;
    context.batchActive = true;
    context.remaining = TREE_RENDER_BUDGET;
    button.disabled = true;

    try {
      const hasPending = tree.querySelector(
        '.fb-tree-toggle[aria-expanded="false"], .fb-tree-more',
      );
      if (!hasPending) {
        const expanded = Array.from(
          tree.querySelectorAll('.fb-tree-toggle[aria-expanded="true"]'),
        ).reverse();
        expanded.forEach((toggle) => toggle.click());
        context.truncated = false;
        if (treeOperationIsCurrent(context, operation)) {
          setStatus('Дерево зависимостей свернуто', 'neutral');
        }
        return;
      }

      let processed = 0;
      while (processed < TREE_RENDER_BUDGET && context.remaining > 0) {
        if (!treeOperationIsCurrent(context, operation)) return;
        const pending = Array.from(tree.querySelectorAll(
          '.fb-tree-toggle[aria-expanded="false"], .fb-tree-more',
        )).slice(0, Math.min(TREE_EXPAND_BATCH, TREE_RENDER_BUDGET - processed));
        if (!pending.length) break;
        pending.forEach((control) => {
          if (context.remaining > 0) control.click();
        });
        processed += pending.length;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }

      if (!treeOperationIsCurrent(context, operation)) return;
      context.truncated = Boolean(tree.querySelector(
        '.fb-tree-toggle[aria-expanded="false"], .fb-tree-more',
      ));
      if (context.truncated) {
        setStatus(
          `Дерево частично раскрыто: достигнут лимит ${TREE_RENDER_BUDGET} узлов`,
          'warning',
        );
      } else {
        setStatus('Дерево зависимостей раскрыто', 'success');
      }
    } finally {
      if (context.operation === operation) {
        context.batchActive = false;
        button.disabled = false;
        syncWholeTreeButton(context);
      }
    }
  }

  function treeOperationIsCurrent(context, operation) {
    return context.operation === operation &&
      context.root?.isConnected &&
      state.host?.style.display !== 'none';
  }

  function syncWholeTreeButton(context) {
    const { root, button } = context;
    if (!root || !button) return;
    const hasMore = Boolean(root.querySelector('.fb-tree-more'));
    const hasCollapsed = Boolean(root.querySelector('.fb-tree-toggle[aria-expanded="false"]'));
    const hasExpanded = Boolean(root.querySelector('.fb-tree-toggle[aria-expanded="true"]'));
    button.parentElement.hidden = !hasMore && !hasCollapsed && !hasExpanded;
    if (hasMore || (context.truncated && hasCollapsed)) button.textContent = 'Развернуть ещё';
    else if (hasCollapsed) button.textContent = 'Развернуть всё';
    else if (hasExpanded) button.textContent = 'Свернуть всё';
  }

  function renderReferenceTree(references, ancestors, context, startIndex = 0) {
    const list = element('ul', 'fb-tree-list');
    let referenceIndex = startIndex;
    while (referenceIndex < references.length && context.remaining > 0) {
      const reference = references[referenceIndex];
      referenceIndex += 1;
      context.remaining -= 1;
      const item = element('li', 'fb-tree-item');
      const variable = state.variablesById.get(reference.id);
      const row = element('div', 'fb-tree-row');

      if (!variable) {
        row.append(typeDot('unknown'), element('span', '', reference.literal || reference.id));
        row.appendChild(element('span', 'fb-tree-note', 'не найдена'));
        item.appendChild(row);
        list.appendChild(item);
        continue;
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
        const sourceNames = core.summarizeSourceNames(source.sources);
        const note = element('span', 'fb-tree-note', sourceNames);
        note.title = sourceNames;
        row.appendChild(note);
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
            if (!context.batchActive) context.remaining = TREE_RENDER_BUDGET;
            branch.appendChild(renderReferenceTree(
              children,
              [...ancestors, variable.id],
              context,
            ));
            rendered = true;
          }
          branch.hidden = !branch.hidden;
          toggle.textContent = branch.hidden ? '▸' : '▾';
          toggle.setAttribute('aria-expanded', String(!branch.hidden));
          if (!context.batchActive) context.truncated = false;
          syncWholeTreeButton(context);
        });
        item.appendChild(branch);
      }
      list.appendChild(item);
    }

    if (referenceIndex < references.length) {
      const item = element('li', 'fb-tree-item fb-tree-more-item');
      const more = element(
        'button',
        'fb-tree-more',
        `Показать ещё (${references.length - referenceIndex})`,
      );
      more.type = 'button';
      more.addEventListener('click', () => {
        if (!context.batchActive) context.remaining = TREE_RENDER_BUDGET;
        const continuation = renderReferenceTree(
          references,
          ancestors,
          context,
          referenceIndex,
        );
        item.replaceWith(...Array.from(continuation.childNodes));
        if (!context.batchActive) context.truncated = false;
        syncWholeTreeButton(context);
      });
      item.appendChild(more);
      list.appendChild(item);
    }
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
    const parenthesisPairs = state.model?.matchParentheses(tokens) || [];
    const highlightedEnd = tokens.length
      ? tokens[tokens.length - 1].start + tokens[tokens.length - 1].length
      : 0;
    const validZones = (Array.isArray(zones) ? zones : [])
      .filter((zone) => (
        zone && Number.isInteger(zone.start) && Number.isInteger(zone.length) &&
        zone.start >= 0 && zone.length > 0 && zone.start + zone.length <= highlightedEnd
      ))
      .sort((a, b) => a.start - b.start || b.length - a.length)
      .slice(0, 100);
    appendFormulaRangeWithZones(
      block,
      tokens,
      0,
      highlightedEnd,
      buildZoneForest(validZones),
      { value: 0 },
    );
    if (highlightedEnd < formula.length) {
      const tail = element('span', 'fb-token-unhighlighted', formula.slice(highlightedEnd));
      tail.title = 'Для производительности подсветка ограничена первыми 5000 токенами / 50000 символами';
      block.appendChild(tail);
    }
    bindParenthesisHighlights(block, parenthesisPairs);
    return block;
  }

  function clearParenthesisHighlight(block) {
    block.querySelectorAll('.is-parenthesis-pair').forEach((node) => {
      node.classList.remove('is-parenthesis-pair');
    });
    block.querySelectorAll('.fb-parenthesis-scope-overlay').forEach((node) => node.remove());
  }

  function clearAllParenthesisHighlights() {
    state.shadow?.querySelectorAll('.fb-code-rich').forEach(clearParenthesisHighlight);
  }

  function bindParenthesisHighlights(block, pairs) {
    if (!pairs.length) return;
    const pairByPosition = new Map();
    pairs.forEach((pair) => {
      pairByPosition.set(pair.open, pair);
      pairByPosition.set(pair.close, pair);
    });
    const segments = [...block.querySelectorAll('.fb-formula-segment[data-formula-start]')]
      .map((node) => ({
        node,
        start: Number(node.dataset.formulaStart),
        end: Number(node.dataset.formulaEnd),
      }))
      .sort((left, right) => left.start - right.start);
    const parentheses = new Map();
    block.querySelectorAll('.fb-token-punctuation[data-formula-start]').forEach((node) => {
      const pair = pairByPosition.get(Number(node.dataset.formulaStart));
      if (!pair) return;
      node.classList.add('fb-parenthesis');
      if (!parentheses.has(pair.open)) parentheses.set(pair.open, []);
      parentheses.get(pair.open).push(node);
    });

    const firstSegmentAfter = (position) => {
      let low = 0;
      let high = segments.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (segments[middle].start <= position) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    const showPair = (pair) => {
      clearParenthesisHighlight(block);
      if (!state.parenthesisHighlight) return;
      parentheses.get(pair.open)?.forEach((node) => node.classList.add('is-parenthesis-pair'));
      const rects = [];
      for (let index = firstSegmentAfter(pair.open); index < segments.length; index += 1) {
        const segment = segments[index];
        if (segment.start >= pair.close) break;
        if (segment.end > pair.close) continue;
        rects.push(...segment.node.getClientRects());
      }
      appendParenthesisScopeOverlays(block, rects);
    };
    block.addEventListener('mouseover', (event) => {
      const parenthesis = event.target.closest?.('.fb-parenthesis');
      if (!parenthesis || !block.contains(parenthesis)) return;
      const pair = pairByPosition.get(Number(parenthesis.dataset.formulaStart));
      if (pair) showPair(pair);
    });
    block.addEventListener('mouseout', (event) => {
      const parenthesis = event.target.closest?.('.fb-parenthesis');
      if (!parenthesis || !block.contains(parenthesis)) return;
      if (parenthesis.contains(event.relatedTarget)) return;
      clearParenthesisHighlight(block);
    });
  }

  function appendParenthesisScopeOverlays(block, clientRects) {
    const blockRect = block.getBoundingClientRect();
    const rects = [...clientRects]
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .sort((left, right) => left.top - right.top || left.left - right.left);
    const merged = [];
    rects.forEach((rect) => {
      const previous = merged[merged.length - 1];
      const sameLine = previous &&
        Math.abs(previous.top - rect.top) < 2 &&
        Math.abs(previous.bottom - rect.bottom) < 2;
      if (sameLine && rect.left <= previous.right + 2) {
        previous.right = Math.max(previous.right, rect.right);
        previous.width = previous.right - previous.left;
        return;
      }
      merged.push({
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      });
    });
    merged.forEach((rect) => {
      const overlay = element('span', 'fb-parenthesis-scope-overlay');
      Object.assign(overlay.style, {
        left: `${rect.left - blockRect.left - block.clientLeft + block.scrollLeft}px`,
        top: `${rect.top - blockRect.top - block.clientTop + block.scrollTop}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      block.appendChild(overlay);
    });
  }

  function buildZoneForest(zones) {
    const roots = [];
    const stack = [];
    zones.forEach((zone) => {
      const node = { ...zone, end: zone.start + zone.length, children: [] };
      while (stack.length && node.start >= stack[stack.length - 1].end) stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) {
        if (node.end > parent.end) return;
        parent.children.push(node);
      } else {
        roots.push(node);
      }
      stack.push(node);
    });
    return roots;
  }

  function appendFormulaRangeWithZones(container, tokens, start, end, zones, palette) {
    let cursor = start;
    zones.forEach((zone) => {
      if (zone.start < cursor || zone.end > end) return;
      appendFormulaTokens(container, tokens, cursor, zone.start);
      const zoneIndex = palette.value;
      palette.value += 1;
      const wrapper = element('span', `fb-origin-zone fb-zone-${zoneIndex % 6}`);
      const labelText = zone.label || zone.variableId;
      const label = element('button', 'fb-origin-label', labelText);
      label.type = 'button';
      bindVariablePopover(label, [zone.variableId], labelText);
      const code = element('span', 'fb-origin-code');
      appendFormulaRangeWithZones(
        code,
        tokens,
        zone.start,
        zone.end,
        zone.children,
        palette,
      );
      wrapper.append(label, code);
      container.appendChild(wrapper);
      cursor = zone.end;
    });
    appendFormulaTokens(container, tokens, cursor, end);
  }

  function appendFormulaTokens(container, tokens, rangeStart, rangeEnd) {
    tokens.forEach((token) => {
      const tokenEnd = token.start + token.length;
      const start = Math.max(rangeStart, token.start);
      const end = Math.min(rangeEnd, tokenEnd);
      if (start >= end) return;
      const text = token.text.slice(start - token.start, end - token.start);
      const isWholeToken = start === token.start && end === tokenEnd;
      let node;
      if (token.kind === 'variable' && isWholeToken) {
        node = formulaVariableToken(token, text);
      } else {
        node = element('span', `fb-token fb-token-${token.kind}`, text);
      }
      node.classList.add('fb-formula-segment');
      node.dataset.formulaStart = String(start);
      node.dataset.formulaEnd = String(end);
      container.appendChild(node);
    });
  }

  function formulaVariableToken(token, text) {
    const candidateIds = Array.isArray(token.candidateIds) ? token.candidateIds : [];
    const canOpen = Boolean(token.variableId) || candidateIds.length > 0;
    const node = element(
      'span',
      `fb-formula-variable fb-type-${normalizeTypeClass(token.variableType)}${canOpen ? '' : ' is-missing'}`,
      text,
    );
    if (!canOpen) {
      node.title = 'Переменная отсутствует в REP.GET_VARIABLES';
      return node;
    }
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    const ids = token.variableId ? [token.variableId] : candidateIds;
    bindVariablePopover(node, ids, text);
    return node;
  }

  function bindVariablePopover(anchor, candidateIds, label) {
    const description = candidateIds.length > 1
      ? `${label}: карточки ${candidateIds.length} одноимённых переменных`
      : `${label}: один клик — карточка, двойной — перейти`;
    anchor.setAttribute('aria-label', description);
    anchor.setAttribute('aria-haspopup', 'dialog');
    anchor.setAttribute('aria-expanded', 'false');
    const show = (event) => {
      if (event.type === 'focus' && state.suppressPopoverFocus) return;
      if (event.type === 'click') event.stopPropagation();
      showVariablePopover(
        anchor,
        candidateIds,
        label,
        event.type === 'click' && event.detail === 0,
      );
    };
    anchor.addEventListener('click', show);
    anchor.addEventListener('dblclick', (event) => {
      if (candidateIds.length !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      dismissVariablePopover();
      navigate({ kind: 'variable', id: candidateIds[0] });
    });
    anchor.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      showVariablePopover(anchor, candidateIds, label, true);
    });
  }

  function showVariablePopover(anchor, candidateIds, label, focusCard = false) {
    if (state.popover && state.popoverAnchor === anchor) {
      if (focusCard) {
        (state.popover.querySelector('.fb-popover-open') ||
          state.popover.querySelector('.fb-popover-close'))?.focus();
      }
      return;
    }
    dismissVariablePopover();
    const popover = element('div', 'fb-variable-popover');
    state.popoverSequence += 1;
    popover.id = `auth-injector-variable-card-${state.popoverSequence}`;
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', `Карточка переменной: ${label}`);
    const uniqueCandidateIds = [];
    const seenCandidateIds = new Set();
    for (const id of candidateIds) {
      if (uniqueCandidateIds.length >= POPOVER_CANDIDATE_LIMIT) break;
      if (seenCandidateIds.has(id)) continue;
      seenCandidateIds.add(id);
      uniqueCandidateIds.push(id);
    }
    const header = element('div', 'fb-popover-header');
    header.append(
      element('strong', '', label),
      element(
        'span',
        'fb-muted',
        uniqueCandidateIds.length > 1 ? 'Выберите одноимённую переменную' : 'Сведения о переменной',
      ),
    );
    const close = element('button', 'fb-popover-close', '×');
    close.type = 'button';
    close.title = 'Закрыть';
    close.addEventListener('click', () => dismissVariablePopover(true));
    popover.append(header, close);
    state.panel.appendChild(popover);
    state.popover = popover;
    state.popoverAnchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('aria-controls', popover.id);

    let candidateCursor = 0;
    const renderCandidateBatch = () => {
      const previousMore = popover.querySelector('.fb-popover-more');
      const restoreBatchFocus = state.shadow.activeElement === previousMore;
      previousMore?.remove();
      const batch = uniqueCandidateIds.slice(
        candidateCursor,
        candidateCursor + POPOVER_CANDIDATE_BATCH,
      );
      let firstNewAction = null;
      batch.forEach((id) => {
        if (state.revalidateOpenedVariables) {
          void validateOpenedVariable(id).then((result) => {
            if (result) refreshVariableValidationViews(id);
          });
        }
        const card = variablePopoverCard(id);
        if (!card) return;
        if (!firstNewAction) firstNewAction = card.querySelector('.fb-popover-open');
        popover.appendChild(card);
      });
      candidateCursor += batch.length;
      if (candidateCursor < uniqueCandidateIds.length) {
        const more = element(
          'button',
          'fb-popover-more',
          `Показать ещё (${uniqueCandidateIds.length - candidateCursor})`,
        );
        more.type = 'button';
        more.addEventListener('click', renderCandidateBatch);
        popover.appendChild(more);
        if (restoreBatchFocus) more.focus();
      } else if (candidateIds.length > POPOVER_CANDIDATE_LIMIT) {
        popover.appendChild(element(
          'div',
          'fb-muted',
          `Показаны первые ${POPOVER_CANDIDATE_LIMIT} совпадений`,
        ));
        if (restoreBatchFocus) (firstNewAction || close).focus();
      } else if (restoreBatchFocus) {
        (firstNewAction || close).focus();
      }
    };
    renderCandidateBatch();
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
    if (focusCard) {
      (popover.querySelector('.fb-popover-open') || close).focus();
    }
  }

  function variablePopoverCard(id) {
    const variable = state.variablesById.get(id);
    if (!variable) return null;
    const variableCard = element('section', 'fb-popover-card');
    variableCard.dataset.variableId = String(id);
    variableCard.__formulaBrowserVariableId = id;
    const variableHeading = element('div', 'fb-popover-variable-heading');
    variableHeading.append(
      typeDot(variable.type),
      element('strong', '', variableLabel(variable)),
      element('code', '', variable.id),
    );
    const meta = element('dl', 'fb-popover-meta');
    appendDefinition(meta, 'Тип', variable.varType || 'Unknown');
    appendDefinition(meta, 'Кардинальность', objectTypeLabel(variable.type));
    appendDefinition(meta, 'Данные', variable.dataType || '—');
    const validation = variableValidationDescription(id);
    if (validation) appendDefinition(meta, 'Повторная проверка', validation);
    const validationNotice = variableValidationNotice(id, 'fb-popover-validation-error');
    const sourceInfo = state.model.getDependencySourceInfo(variable.id, { maxNodes: 500 });
    const visibleSources = sourceInfo.sources.slice(0, POPOVER_SOURCE_LIMIT);
    let sourceDescription = visibleSources.length
      ? visibleSources.map((source) => (
        `${truncateText(source.dpName || source.dpId, 80)} · ${truncateText(source.objectId || '—', 80)}`
      )).join('\n')
      : sourceInfo.truncated
        ? 'DP не найден в пределах лимита обхода'
        : 'Нет достижимого DP-источника';
    const hiddenSources = sourceInfo.sources.length - visibleSources.length;
    if (hiddenSources > 0) sourceDescription += `\n… ещё ${hiddenSources}`;
    if (sourceInfo.truncated) sourceDescription += '\n… показан частичный результат';
    appendDefinition(meta, 'DP', sourceDescription);
    const open = element('button', 'fb-popover-open', 'Перейти к переменной →');
    open.type = 'button';
    open.addEventListener('click', () => {
      dismissVariablePopover();
      navigate({ kind: 'variable', id });
    });
    variableCard.append(
      variableHeading,
      ...(validationNotice ? [validationNotice] : []),
      meta,
      open,
    );
    return variableCard;
  }

  function truncateText(value, maxLength) {
    const text = String(value ?? '');
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  }

  function dismissVariablePopover(returnFocus = false) {
    const anchor = state.popoverAnchor;
    state.popover?.remove();
    state.popover = null;
    state.popoverAnchor = null;
    if (anchor) {
      anchor.setAttribute('aria-expanded', 'false');
      anchor.removeAttribute('aria-controls');
    }
    if (returnFocus && anchor?.isConnected) {
      state.suppressPopoverFocus = true;
      anchor.focus();
      state.suppressPopoverFocus = false;
    }
    if (state.pendingValidationRender) {
      state.pendingValidationRender = false;
      queueMicrotask(() => {
        if (!state.popover) renderCurrent();
      });
    }
  }

  function appendDefinition(list, term, description) {
    list.append(
      element('dt', '', term),
      element('dd', '', description),
    );
  }

  function rebuildActiveVariables() {
    if (!state.sourceVariables.length) return;
    state.variables = core.selectValidatedVariables(
      state.sourceVariables,
      state.variableValidations,
      state.revalidateOpenedVariables,
    );
    state.variablesById = new Map(
      state.variables.map((variable) => [variable.id, variable]),
    );
    state.model = core.createModel(state.variables, state.dps);
  }

  function validateOpenedVariable(variableId) {
    if (!state.revalidateOpenedVariables || !state.loaded) return Promise.resolve(null);
    const existing = state.variableValidations.get(variableId);
    if (existing) return existing.promise || Promise.resolve(existing);
    const variable = state.sourceVariablesById.get(variableId);
    if (!variable || typeof variable.formula !== 'string' || !variable.formula.trim()) {
      const skipped = { status: 'skipped', message: 'У переменной нет формулы' };
      state.variableValidations.set(variableId, skipped);
      return Promise.resolve(skipped);
    }

    const generation = state.validationGeneration;
    const pending = { status: 'pending', promise: null };
    const promise = requestJson('REP.VALIDATE_FORMULA', { formula: variable.formula })
      .then((response) => {
        if (generation !== state.validationGeneration) return null;
        const validatedVariable = core.createValidatedVariable(variable, response);
        if (!validatedVariable) {
          const failed = {
            status: 'error',
            message: response?.reason || 'Сервер не вернул обновлённое дерево формулы',
          };
          state.variableValidations.set(variableId, failed);
          return failed;
        }
        const completed = { status: 'success', variable: validatedVariable };
        state.variableValidations.set(variableId, completed);
        rebuildActiveVariables();
        return completed;
      })
      .catch((error) => {
        if (generation !== state.validationGeneration) return null;
        const failed = { status: 'error', message: error.message };
        state.variableValidations.set(variableId, failed);
        return failed;
      });
    pending.promise = promise;
    state.variableValidations.set(variableId, pending);
    return promise;
  }

  function startVariableValidationGraph(rootId) {
    if (!state.revalidateOpenedVariables || !state.loaded) return;
    if (state.validationGraphRuns.has(rootId)) return;
    const generation = state.validationGeneration;
    const modeRevision = state.validationModeRevision;
    setStatus('Повторная проверка открытых переменных…', 'neutral');
    const run = (async () => {
      const visited = new Set();
      let frontier = [rootId];
      let successCount = 0;
      let fallbackCount = 0;
      while (
        frontier.length &&
        generation === state.validationGeneration &&
        modeRevision === state.validationModeRevision &&
        state.revalidateOpenedVariables
      ) {
        const batchIds = [];
        frontier.forEach((id) => {
          if (visited.has(id)) return;
          visited.add(id);
          batchIds.push(id);
        });
        frontier = [];
        for (let index = 0; index < batchIds.length; index += REVALIDATE_CONCURRENCY) {
          const chunk = batchIds.slice(index, index + REVALIDATE_CONCURRENCY);
          const results = await Promise.all(chunk.map((id) => validateOpenedVariable(id)));
          results.forEach((result) => {
            if (result?.status === 'success') successCount += 1;
            else fallbackCount += 1;
          });
          if (
            generation !== state.validationGeneration ||
            modeRevision !== state.validationModeRevision ||
            !state.revalidateOpenedVariables
          ) {
            return false;
          }
        }
        batchIds.forEach((id) => {
          const variable = state.variablesById.get(id) || state.sourceVariablesById.get(id);
          if (!variable || variable.varType === 'DP' || variable.varType === 'Merge') return;
          core.collectReferences(variable.parsedFormula?.root).forEach((reference) => {
            if (!visited.has(reference.id) && state.sourceVariablesById.has(reference.id)) {
              frontier.push(reference.id);
            }
          });
        });
      }
      if (
        generation !== state.validationGeneration ||
        modeRevision !== state.validationModeRevision ||
        !state.revalidateOpenedVariables
      ) return false;
      refreshVariableValidationViews();
      const fallbackSuffix = fallbackCount
        ? ` · оставлено исходных: ${fallbackCount}`
        : '';
      setStatus(
        `Обновлено переменных: ${successCount}${fallbackSuffix}`,
        fallbackCount ? 'warning' : 'success',
      );
      return true;
    })();
    state.validationGraphRuns.set(rootId, run);
    const releaseRun = () => {
      if (state.validationGraphRuns.get(rootId) === run) {
        state.validationGraphRuns.delete(rootId);
      }
    };
    void run.then(releaseRun, releaseRun);
  }

  function refreshVariableValidationViews(variableId = null) {
    if (state.popover) {
      [...state.popover.querySelectorAll('.fb-popover-card')].forEach((oldCard) => {
        if (
          variableId !== null &&
          oldCard.__formulaBrowserVariableId !== variableId
        ) return;
        const hadFocus = oldCard.contains(state.shadow.activeElement);
        const replacement = variablePopoverCard(oldCard.__formulaBrowserVariableId);
        if (!replacement) return;
        oldCard.replaceWith(replacement);
        if (hadFocus) replacement.querySelector('.fb-popover-open')?.focus();
      });
      state.pendingValidationRender = true;
      return;
    }
    state.pendingValidationRender = false;
    renderCurrent();
  }

  function variableValidationBadge(variableId) {
    if (!state.revalidateOpenedVariables) return null;
    const validation = state.variableValidations.get(variableId);
    if (!validation || validation.status === 'pending') {
      return neutralBadge('ПРОВЕРКА…');
    }
    if (validation.status === 'success') return successBadge('ОБНОВЛЕНО');
    if (validation.status === 'error') {
      const badge = errorBadge('ОШИБКА ПРОВЕРКИ');
      badge.title = validation.message || 'Повторная проверка завершилась ошибкой';
      return badge;
    }
    const badge = neutralBadge('НЕТ ФОРМУЛЫ');
    badge.title = validation.message || 'Повторная проверка не выполнена';
    return badge;
  }

  function variableValidationDescription(variableId) {
    if (!state.revalidateOpenedVariables) return '';
    const validation = state.variableValidations.get(variableId);
    if (!validation || validation.status === 'pending') return 'Выполняется…';
    if (validation.status === 'success') return 'Используется обновлённое дерево';
    if (validation.status === 'error') {
      return `Ошибка · используются исходные данные · ${validation.message || 'причина не указана'}`;
    }
    return `Исходные данные · ${validation.message || 'проверка недоступна'}`;
  }

  function variableValidationNotice(variableId, extraClass = '') {
    if (!state.revalidateOpenedVariables) return null;
    const validation = state.variableValidations.get(variableId);
    if (validation?.status !== 'error') return null;
    const notice = element(
      'div',
      `fb-validation-error ${extraClass}`.trim(),
      `Повторная проверка завершилась ошибкой. Используются исходные данные.\n${truncateText(validation.message || 'Причина не указана', 1000)}`,
    );
    notice.setAttribute('role', 'alert');
    return notice;
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

  function errorBadge(value) {
    return element('span', 'fb-badge fb-badge-error', value);
  }

  function typeDot(type) {
    const normalized = normalizeTypeClass(type);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('fb-type-icon', `fb-icon-${normalized}`);
    const paths = TYPE_ICON_PATHS[normalized] || ['M8 1L15 8L8 15L1 8L8 1ZM7 5H9V9H7V5ZM7 11H9V13H7V11Z'];
    paths.forEach((data) => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', data);
      path.setAttribute('fill', 'currentColor');
      svg.appendChild(path);
    });
    return svg;
  }

  function objectTypeLabel(type) {
    return typeof type === 'string' && type.length ? type : 'Unknown';
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
      button:focus-visible, summary:focus-visible, [tabindex]:focus-visible {
        outline: 2px solid rgba(65, 112, 153, .34); outline-offset: 1px;
      }
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
        background: #244957;
        cursor: move;
        user-select: none;
      }
      .fb-title { display: flex; align-items: center; gap: 10px; font-size: 15px; font-weight: 650; }
      .fb-logo {
        display: grid; place-items: center; width: 27px; height: 27px; border-radius: 7px;
        background: rgba(255,255,255,.13); color: #e8f1f4;
        font-family: Georgia, serif; font-size: 19px; font-style: italic;
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
      .fb-editor-meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 12px; margin-top: 4px; }
      .fb-shortcuts { color: #8492a6; font-size: 11px; }
      .fb-preference-controls { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px 12px; }
      .fb-checkbox-control { display: inline-flex; align-items: center; gap: 5px; color: #718096; font-size: 10px; white-space: nowrap; cursor: pointer; }
      .fb-checkbox-control input { margin: 0; accent-color: #6483a4; }
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
      .fb-list-grouping { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; margin: 0 0 10px; padding: 2px; border: 1px solid #d8e0e8; border-radius: 7px; background: #edf1f5; }
      .fb-group-button { min-height: 27px; padding: 2px 5px; border: 0; border-radius: 5px; background: transparent; color: #687587; font-size: 10px; cursor: pointer; }
      .fb-group-button:hover { color: #334155; }
      .fb-group-button.is-active { background: #fff; color: #315f8d; box-shadow: 0 1px 2px rgba(15,23,42,.09); }
      .fb-sidebar-list { display: grid; gap: 9px; }
      .fb-variable-group, .fb-variable-items { display: grid; gap: 3px; }
      .fb-variable-group > summary { list-style: none; cursor: pointer; }
      .fb-variable-group > summary::-webkit-details-marker { display: none; }
      .fb-variable-group > summary::before { content: '▸'; display: inline-block; width: 11px; color: #8a96a6; transform: rotate(0); transition: transform .12s; }
      .fb-variable-group[open] > summary::before { transform: rotate(90deg); }
      .fb-sidebar-heading { display: flex; align-items: center; gap: 5px; padding: 4px 5px; color: #687587; font-size: 10px; font-weight: 700; letter-spacing: .025em; }
      .fb-group-count { margin-left: auto; min-width: 20px; color: #96a0ae; font-variant-numeric: tabular-nums; text-align: right; }
      .fb-anonymous-group { border-top: 1px solid #e2e8f0; padding-top: 7px; }
      .fb-anonymous-group > summary { padding: 5px 6px; color: #64748b; font-size: 11px; font-weight: 700; cursor: pointer; }
      .fb-anonymous-group .fb-variable-items { margin-top: 4px; }
      .fb-sidebar-item {
        width: 100%; min-width: 0; display: grid; grid-template-columns: 16px minmax(0, 1fr) auto;
        align-items: center; gap: 6px; padding: 5px 6px; border: 1px solid transparent; border-radius: 5px;
        background: transparent; color: #334155; text-align: left; cursor: pointer;
      }
      .fb-sidebar-item:hover { border-color: transparent; background: #e9eef4; }
      .fb-sidebar-item.is-current { border-color: #b7cbe0; background: #e4edf7; color: #254f78; }
      .fb-sidebar-item-main { min-width: 0; overflow: hidden; font-family: 'Roboto Condensed', Roboto, sans-serif; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
      .fb-sidebar-item-meta { color: #8a97aa; font-size: 8px; letter-spacing: .02em; white-space: nowrap; }
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
      .fb-badge { display: inline-flex; align-items: center; min-height: 24px; padding: 2px 9px; border-radius: 999px; color: #556171; background: #edf1f5; font-size: 11px; font-weight: 650; }
      .fb-badge-neutral { color: #475569; background: #edf1f5; }
      .fb-badge-success { color: #17663c; background: #daf4e5; }
      .fb-badge-error { color: #a12634; background: #fde4e7; }
      .fb-badge.fb-type-dimension { color: #356b9c; background: #e9f2fa; }
      .fb-badge.fb-type-attribute { color: #477652; background: #edf6ef; }
      .fb-badge.fb-type-measure { color: #8a622d; background: #faf2e7; }
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
      .fb-parenthesis {
        border-radius: 2px; cursor: default;
        transition: color .12s ease, background-color .12s ease, box-shadow .12s ease;
      }
      .fb-code-rich > :not(.fb-parenthesis-scope-overlay) { position: relative; z-index: 1; }
      .fb-parenthesis-scope-overlay {
        position: absolute; z-index: 0; border-radius: 2px;
        background: rgba(78,105,135,.045); pointer-events: none;
      }
      .fb-parenthesis.is-parenthesis-pair {
        background-color: rgba(69,103,141,.11); color: #496d94;
        box-shadow: inset 0 -1px 0 rgba(69,103,141,.24);
      }
      .fb-formula-variable {
        display: inline; margin: 0; padding: 0 1px; border: 0; border-radius: 3px;
        background: transparent; color: #526579; font: inherit; font-weight: 600; line-height: inherit; cursor: pointer;
      }
      .fb-formula-variable.fb-type-dimension { color: #4777a4; }
      .fb-formula-variable.fb-type-attribute { color: #568063; }
      .fb-formula-variable.fb-type-measure { color: #9a713d; }
      .fb-formula-variable:hover { background: rgba(71,119,164,.09); text-decoration: underline; text-underline-offset: 2px; }
      .fb-formula-variable:focus-visible { background: rgba(71,119,164,.09); outline-color: rgba(71,119,164,.45); }
      .fb-formula-variable.is-missing { color: #7d8793; text-decoration: underline dotted; cursor: help; }
      .fb-origin-zone {
        display: inline-flex; flex-direction: column; vertical-align: middle; margin: 9px 2px 2px;
        border: 1px solid #c5d6e2; border-radius: 5px; background: rgba(235,242,247,.7);
      }
      .fb-origin-label {
        max-width: 210px; margin: -10px 4px 0; padding: 1px 5px; overflow: hidden; border: 0; border-radius: 4px;
        border: 1px solid #c5d6e2; background: #f5f8fa; color: #557186; font: 600 9px/1.4 Inter, Roboto, sans-serif;
        text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
      }
      .fb-origin-label:hover { text-decoration: underline; }
      .fb-origin-code { padding: 1px 4px 2px; }
      .fb-zone-1 { border-color: #ded1b9; background: rgba(248,244,234,.72); }
      .fb-zone-1 .fb-origin-label { border-color: #ded1b9; color: #866f49; }
      .fb-zone-2 { border-color: #c7d9cb; background: rgba(238,246,240,.72); }
      .fb-zone-2 .fb-origin-label { border-color: #c7d9cb; color: #5b7862; }
      .fb-zone-3 { border-color: #d5cbe0; background: rgba(245,241,248,.72); }
      .fb-zone-3 .fb-origin-label { border-color: #d5cbe0; color: #71627f; }
      .fb-zone-4 { border-color: #dfccce; background: rgba(249,242,243,.72); }
      .fb-zone-4 .fb-origin-label { border-color: #dfccce; color: #806166; }
      .fb-zone-5 { border-color: #c4d9d7; background: rgba(238,247,246,.72); }
      .fb-zone-5 .fb-origin-label { border-color: #c4d9d7; color: #557976; }
      .fb-expansion-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
      .fb-zone-modes { display: inline-flex; padding: 2px; border: 1px solid #d5dee8; border-radius: 7px; background: #f1f4f7; }
      .fb-zone-mode { padding: 3px 8px; border: 0; border-radius: 5px; background: transparent; color: #637386; font-size: 10px; cursor: pointer; }
      .fb-zone-mode:hover { color: #315f8a; }
      .fb-zone-mode.is-active { background: #fff; color: #315f8a; box-shadow: 0 1px 3px rgba(31,50,72,.14); }
      .fb-depth-control { display: inline-flex; align-items: center; gap: 5px; color: #637386; font-size: 10px; }
      .fb-depth-input { width: 54px; padding: 3px 5px; border: 1px solid #d5dee8; border-radius: 5px; background: #fff; color: #315f8a; font: inherit; }
      .fb-dependency-list { display: flex; flex-wrap: wrap; gap: 7px; }
      .fb-dependency {
        display: inline-flex; align-items: center; gap: 7px; min-height: 30px; padding: 4px 9px;
        border: 1px solid #d4deea; border-radius: 7px; background: #f8fafc; color: #244b7c; cursor: pointer;
      }
      .fb-dependency:hover { border-color: #93b4df; background: #eef5ff; }
      .fb-type-icon { flex: 0 0 auto; width: 16px; height: 16px; color: #7e8996; }
      .fb-icon-dimension { color: #3f75ad; }
      .fb-icon-attribute { color: #4d805a; }
      .fb-icon-measure { color: #a8752f; }
      .fb-expansion summary { color: #255da9; font-weight: 650; cursor: pointer; }
      .fb-expansion-body { display: grid; gap: 8px; margin-top: 10px; }
      .fb-warning { padding: 8px 10px; border-radius: 7px; background: #fff4d8; color: #855d00; }
      .fb-validation-error { padding: 10px 12px; border: 1px solid #efb6bd; border-radius: 8px; background: #fff1f2; color: #9f2634; white-space: pre-line; overflow-wrap: anywhere; }
      .fb-popover-validation-error { padding: 8px; font-size: 11px; }
      .fb-source { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; padding: 8px 0; border-bottom: 1px solid #edf1f5; }
      .fb-source:last-child { border-bottom: 0; }
      .fb-source strong { overflow-wrap: anywhere; }
      .fb-source-id { color: #64748b; }
      .fb-source code { grid-column: 1 / -1; color: #8492a6; font-size: 11px; overflow-wrap: anywhere; }
      .fb-tree { max-height: 520px; overflow: auto; padding-right: 3px; }
      .fb-tree-controls { display: flex; justify-content: flex-end; margin-bottom: 4px; }
      .fb-tree-controls[hidden] { display: none; }
      .fb-tree-expand-all { padding: 2px 4px; border: 0; background: transparent; color: #58799c; font-size: 10px; cursor: pointer; }
      .fb-tree-expand-all:hover { color: #255da9; text-decoration: underline; }
      .fb-tree-expand-all:disabled { color: #9aa8b7; cursor: wait; text-decoration: none; }
      .fb-tree-list { margin: 0; padding: 0 0 0 17px; border-left: 1px solid #dbe4ee; list-style: none; }
      .fb-tree > .fb-tree-list { padding-left: 0; border-left: 0; }
      .fb-tree-item { position: relative; margin: 5px 0; }
      .fb-tree-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .fb-tree-toggle, .fb-tree-toggle-spacer { flex: 0 0 16px; width: 16px; height: 18px; }
      .fb-tree-toggle { padding: 0; border: 0; border-radius: 3px; background: transparent; color: #64748b; line-height: 1; cursor: pointer; }
      .fb-tree-toggle:hover { background: #edf2f7; color: #255da9; }
      .fb-tree-more { margin-left: 22px; padding: 2px 0; border: 0; background: transparent; color: #58799c; font-size: 10px; cursor: pointer; }
      .fb-tree-more:hover { color: #255da9; text-decoration: underline; }
      .fb-tree-link { flex: 1 1 55%; min-width: 90px; padding: 1px 0; border: 0; background: transparent; color: #255da9; text-align: left; overflow-wrap: break-word; cursor: pointer; }
      .fb-tree-link:hover { text-decoration: underline; }
      .fb-tree-note { flex: 0 1 40%; min-width: 0; max-width: 40%; margin-left: auto; overflow: hidden; color: #8492a6; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
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
      .fb-popover-card { display: grid; gap: 9px; padding: 10px; border: 1px solid #e0e7ee; border-radius: 8px; background: #fbfcfd; }
      .fb-popover-card + .fb-popover-card { margin-top: 8px; }
      .fb-popover-variable-heading { min-width: 0; display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 2px 7px; align-items: center; }
      .fb-popover-variable-heading strong { min-width: 0; overflow-wrap: anywhere; color: #2f3d4d; }
      .fb-popover-variable-heading code { grid-column: 2; overflow-wrap: anywhere; color: #8a95a3; font-size: 9px; }
      .fb-popover-meta { display: grid; grid-template-columns: 105px minmax(0, 1fr); gap: 5px 9px; margin: 0; padding: 8px; border-radius: 6px; background: #f7f9fb; }
      .fb-popover-meta dt { color: #7a8696; font-size: 10px; }
      .fb-popover-meta dd { min-width: 0; margin: 0; color: #3e4b5b; font-size: 11px; white-space: pre-line; overflow-wrap: anywhere; }
      .fb-popover-open { justify-self: end; padding: 2px 0; border: 0; background: transparent; color: #58799c; font-size: 10px; cursor: pointer; }
      .fb-popover-open:hover { color: #255da9; text-decoration: underline; }
      .fb-popover-more { justify-self: center; width: 100%; padding: 6px; border: 1px dashed #c8d4df; border-radius: 6px; background: #f8fafc; color: #58799c; font-size: 10px; cursor: pointer; }
      .fb-popover-more:hover { border-color: #9fb6ca; color: #255da9; }
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
