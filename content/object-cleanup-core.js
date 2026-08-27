(function initObjectCleanupCore(globalScope) {
  'use strict';

  const DEFAULT_SETTINGS = Object.freeze({
    objectTypes: Object.freeze(['UNV', 'CN', 'REP']),
    locations: Object.freeze(['REC_BIN']),
    mask: '*',
    force: true,
  });

  const OBJECT_TYPES = Object.freeze({
    UNV: 'Юнивёрсы',
    CN: 'Соединения',
    REP: 'Отчёты',
  });

  const OBJECT_KIND_FILTERS = Object.freeze({
    UNV: Object.freeze(['SL']),
    CN: Object.freeze(['CN']),
    REP: Object.freeze(['REP']),
  });

  const LOCATIONS = Object.freeze({
    USER: 'Личное хранилище',
    PUBLIC: 'Общие папки',
    REC_BIN: 'Корзина',
  });

  const LOCATION_FILTERS = Object.freeze({
    USER: Object.freeze({ rightFilters: Object.freeze(['USER']), specFilters: Object.freeze(['NONE']) }),
    PUBLIC: Object.freeze({ rightFilters: Object.freeze(['PUBLIC']), specFilters: Object.freeze(['NONE']) }),
    REC_BIN: Object.freeze({ rightFilters: Object.freeze(['USER']), specFilters: Object.freeze(['REC_BIN']) }),
  });

  function normalizeChoiceList(value, allowed, fallback) {
    if (!Array.isArray(value)) return [...fallback];
    return [...new Set(value.filter((item) => Object.hasOwn(allowed, item)))];
  }

  function normalizeSettings(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      objectTypes: normalizeChoiceList(
        source.objectTypes,
        OBJECT_TYPES,
        DEFAULT_SETTINGS.objectTypes,
      ),
      locations: normalizeChoiceList(
        source.locations,
        LOCATIONS,
        DEFAULT_SETTINGS.locations,
      ),
      mask: typeof source.mask === 'string' ? source.mask : DEFAULT_SETTINGS.mask,
      force: typeof source.force === 'boolean' ? source.force : DEFAULT_SETTINGS.force,
    };
  }

  function validateSettings(settings) {
    if (settings.objectTypes.length === 0) {
      throw new Error('Выберите хотя бы один тип объекта');
    }
    if (settings.locations.length === 0) {
      throw new Error('Выберите хотя бы одно расположение');
    }
    if (!settings.mask.trim()) throw new Error('Укажите маску имени');
  }

  function buildFindParams(settingsValue, location) {
    const settings = normalizeSettings(settingsValue);
    validateSettings(settings);
    const locationFilter = LOCATION_FILTERS[location];
    if (!locationFilter) throw new Error(`Неизвестное расположение: ${location}`);
    const kindsFilter = [...new Set(
      settings.objectTypes.flatMap((objectType) => OBJECT_KIND_FILTERS[objectType]),
    )];
    return {
      searchType: 'MASK',
      searchMask: [settings.mask.trim()],
      kindsFilter,
      folderRoleFilter: {
        rightFilters: [...locationFilter.rightFilters],
        kindFilters: [...settings.objectTypes],
        specFilters: [...locationFilter.specFilters],
      },
      sort: { field: 'id', sortDirection: 'ASC' },
      treeResult: 0,
    };
  }

  function flattenFoundObjects(nodes) {
    if (!Array.isArray(nodes)) return [];
    return nodes.flatMap((item) => [
      item,
      ...flattenFoundObjects(item?.elements),
      ...flattenFoundObjects(item?.children),
    ]);
  }

  function bridgeErrorMessage(response, fallback) {
    const firstError = Array.isArray(response?.errors) ? response.errors[0] : null;
    return firstError?.text
      || firstError?.reason
      || response?.error?.message
      || response?.message
      || fallback;
  }

  function assertSuccessful(response, fallback) {
    if (!response || response.result === 0) {
      throw new Error(bridgeErrorMessage(response, fallback));
    }
    return response;
  }

  async function collectCandidates(settingsValue, requestJson) {
    const settings = normalizeSettings(settingsValue);
    validateSettings(settings);
    const targetResults = await Promise.all(settings.locations.map(async (location) => {
      try {
        const searchResponse = assertSuccessful(
          await requestJson('REPOS.FIND_OBJECTS', buildFindParams(settings, location)),
          `Не удалось выполнить поиск в разделе «${LOCATIONS[location]}»`,
        );
        const children = searchResponse?.data?.children;
        if (!Array.isArray(children)) {
          throw new Error(`Сервер вернул неожиданный результат поиска в разделе «${LOCATIONS[location]}»`);
        }

        return {
          items: flattenFoundObjects(children)
            .filter((item) => item?.kind !== 'FLD')
            .map((item) => ({
              id: item.id,
              name: String(item.name || ''),
              kind: item.kind || '',
              location,
              path: String(item.path || item.pathForDeleted || ''),
              force: settings.force,
            })),
          warning: null,
        };
      } catch (error) {
        return {
          items: [],
          warning: `${LOCATIONS[location]}: ${error.message}`,
        };
      }
    }));

    const uniqueItems = new Map();
    for (const { items } of targetResults) {
      for (const item of items) uniqueItems.set(String(item.id), item);
    }

    const warnings = targetResults.map(({ warning }) => warning).filter(Boolean);
    if (warnings.length === settings.locations.length) {
      throw new Error(warnings.join('\n'));
    }

    const items = [...uniqueItems.values()].sort((left, right) => (
      String(left.id).localeCompare(String(right.id), undefined, { numeric: true })
    ));
    return { items, warnings };
  }

  async function deleteCandidates(candidates, requestJson) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error('Список удаления пуст');
    }

    const results = [];
    for (const candidate of candidates) {
      if (candidate?.id === undefined || candidate?.id === null) {
        results.push({
          id: null,
          name: String(candidate?.name || ''),
          force: candidate?.force === true,
          success: false,
          error: 'У объекта отсутствует id',
        });
        continue;
      }

      const force = candidate.force === true;
      try {
        assertSuccessful(
          await requestJson('REPOS.DEL_USER_OBJ', {
            id: candidate.id,
            force: force ? 1 : 0,
            isFullDelete: force ? 1 : 0,
          }),
          `Не удалось удалить ${candidate.name || candidate.id}`,
        );
        results.push({
          id: candidate.id,
          name: String(candidate.name || ''),
          force,
          success: true,
        });
      } catch (error) {
        results.push({
          id: candidate.id,
          name: String(candidate.name || ''),
          force,
          success: false,
          error: error.message,
        });
      }
    }

    return results;
  }

  const api = {
    DEFAULT_SETTINGS,
    OBJECT_TYPES,
    OBJECT_KIND_FILTERS,
    LOCATIONS,
    normalizeSettings,
    validateSettings,
    buildFindParams,
    flattenFoundObjects,
    collectCandidates,
    deleteCandidates,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.ObjectCleanupCore = Object.freeze(api);
})(typeof globalThis === 'undefined' ? this : globalThis);
