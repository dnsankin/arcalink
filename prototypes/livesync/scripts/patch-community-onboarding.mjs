// Community onboarding must ask the user before starting a fresh app lifecycle.
// Production retains its existing lifecycle. Apply this same guarded transform
// to build inputs and public source exports; exporting patched files is idempotent.
export const restartPrompt = 'Connection settings are saved. Restart Obsidian to start syncing. Restart now?';
export function patchCommunityOnboarding(source, name) {
  const expected = { 'free-relay.ts': 1, 'workspaces.ts': 2 }[name];
  if (!expected) return source;
  const pair = /await (this\.plugin|p)\.app\.plugins\.disablePlugin\(\1\.manifest\.id\);\s*await \1\.app\.plugins\.enablePlugin\(\1\.manifest\.id\);/g;
  const matches = [...source.matchAll(pair)];
  if (!matches.length && !/disablePlugin|enablePlugin/.test(source) &&
      source.split(JSON.stringify(restartPrompt)).length - 1 === expected) return source;
  if (matches.length !== expected) throw Error('Unexpected Community onboarding lifecycle: ' + name);
  source = source.replace(pair, (_, owner) => `await ${owner}.core.services.appLifecycle.askRestart(${JSON.stringify(restartPrompt)});`);
  if (name === 'free-relay.ts') {
    const notice = "      new Notice('Free подключён. Откройте второй клиент с тем же аккаунтом, кодом группы и парольной фразой.');";
    if (source.split(notice).length !== 2) throw Error('Unexpected Free onboarding notice');
    source = source.replace(notice, '').replace(
      '// Same initialisation boundary as the existing ArcaLink cloud onboarding.',
      '// Settings are saved; the user decides when to start the new app lifecycle.');
  } else {
    const notice = "        new Notice('Вход выполнен. Подключено хранилище «' + space.title + '».');";
    if (source.split(notice).length !== 2) throw Error('Unexpected cloud onboarding notice');
    source = source.replace(notice, notice.replace('new Notice', 'if (wasConfigured) new Notice')).replace(
      '// Reload at the same boundary as cloud and explicit Free onboarding.',
      '// Ask the user to restart after saving the complete connection.');
  }
  if (/disablePlugin|enablePlugin/.test(source)) throw Error('Unexpected remaining plugin lifecycle API: ' + name);
  return source;
}
