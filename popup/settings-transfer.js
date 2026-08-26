(function initSettingsTransfer(globalScope) {
  const BACKUP_SCHEMA = 'universal-auth-injector/settings-backup';
  const BACKUP_VERSION = 1;

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function validateBackup(backup) {
    if (!isPlainObject(backup) || backup.schema !== BACKUP_SCHEMA) {
      throw new Error('Файл не является резервной копией Universal Auth Injector');
    }
    if (backup.version !== BACKUP_VERSION) {
      throw new Error(`Версия резервной копии ${backup.version} не поддерживается`);
    }
    if (!isPlainObject(backup.storageSync)) {
      throw new Error('В резервной копии отсутствуют настройки storage.sync');
    }
    if (!isPlainObject(backup.shortcuts)) {
      throw new Error('В резервной копии отсутствует список хоткеев');
    }
    for (const [name, shortcut] of Object.entries(backup.shortcuts)) {
      if (!name || typeof shortcut !== 'string') {
        throw new Error('Резервная копия содержит некорректный хоткей');
      }
    }
    return backup;
  }

  function createBackup(storageSync, commands, exportedAt = new Date().toISOString()) {
    const shortcuts = {};
    for (const command of commands || []) {
      if (command?.name) shortcuts[command.name] = command.shortcut || '';
    }
    return {
      schema: BACKUP_SCHEMA,
      version: BACKUP_VERSION,
      exportedAt,
      storageSync,
      shortcuts,
    };
  }

  function parseBackup(text) {
    let backup;
    try {
      backup = JSON.parse(text);
    } catch {
      throw new Error('Не удалось прочитать JSON-файл');
    }
    return validateBackup(backup);
  }

  async function replaceStorage(storageArea, nextSettings) {
    const previousSettings = await storageArea.get(null);
    const previousKeys = Object.keys(previousSettings);
    const nextKeys = Object.keys(nextSettings);
    const obsoleteKeys = previousKeys.filter((key) => !Object.hasOwn(nextSettings, key));
    try {
      if (obsoleteKeys.length > 0) {
        await storageArea.remove(obsoleteKeys);
      }
      if (nextKeys.length > 0) {
        await storageArea.set(nextSettings);
      }
    } catch (error) {
      try {
        if (previousKeys.length > 0) {
          await storageArea.set(previousSettings);
        }
        const introducedKeys = nextKeys.filter((key) => !Object.hasOwn(previousSettings, key));
        if (introducedKeys.length > 0) {
          await storageArea.remove(introducedKeys);
        }
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
      throw error;
    }
  }

  async function importBackup(backup, { storageArea, commandsApi }) {
    validateBackup(backup);
    const commands = await commandsApi.getAll();
    const knownCommands = new Map(
      commands.filter(({ name }) => name).map((command) => [command.name, command]),
    );
    const shortcuts = Object.entries(backup.shortcuts);

    const manualShortcuts = [];
    const skippedShortcuts = [];
    const updatedShortcuts = [];

    if (typeof commandsApi.update === 'function') {
      try {
        for (const [name, shortcut] of shortcuts) {
          const currentCommand = knownCommands.get(name);
          if (!currentCommand) {
            skippedShortcuts.push({ name, shortcut });
            continue;
          }
          await commandsApi.update({ name, shortcut });
          updatedShortcuts.push({ name, shortcut: currentCommand.shortcut || '' });
        }
        await replaceStorage(storageArea, backup.storageSync);
      } catch (error) {
        const shortcutRollbackErrors = [];
        for (const previousShortcut of updatedShortcuts.reverse()) {
          try {
            await commandsApi.update(previousShortcut);
          } catch (rollbackError) {
            shortcutRollbackErrors.push(rollbackError?.message || String(rollbackError));
          }
        }
        if (shortcutRollbackErrors.length > 0) {
          error.shortcutRollbackErrors = shortcutRollbackErrors;
        }
        throw error;
      }
    } else {
      for (const [name, shortcut] of shortcuts) {
        if (knownCommands.has(name)) manualShortcuts.push({ name, shortcut });
        else skippedShortcuts.push({ name, shortcut });
      }
      await replaceStorage(storageArea, backup.storageSync);
    }

    return { manualShortcuts, skippedShortcuts };
  }

  const api = {
    BACKUP_SCHEMA,
    BACKUP_VERSION,
    createBackup,
    parseBackup,
    importBackup,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.SettingsTransfer = api;
})(typeof globalThis === 'undefined' ? this : globalThis);
