import {patchMaintainedEngine} from './patch-maintained-engine.mjs';
import { mkdir, readFile, writeFile, copyFile, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { auditBundle } from './licenses.mjs';
import { patchContentRetryProcessor, patchContentRetryLifecycle, patchContentRetryFixture } from './patch-content-retry.mjs';
import { patchCommunityOnboarding } from './patch-community-onboarding.mjs';
import { patchConfigDoctor } from './patch-config-doctor.mjs';
import { patchSettingsRegistration } from './patch-settings-registration.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const communityRelease = process.env.ARCALINK_RELEASE_CHANNEL === 'community';
const foldersLab = process.env.ARCALINK_RELEASE_CHANNEL === 'folders-lab';
const freeRelayLab = process.env.ARCALINK_RELEASE_CHANNEL === 'free-relay-lab';
const releaseMetadata = JSON.parse(await readFile(path.join(root,
  foldersLab ? 'folders-lab-release.json' : freeRelayLab ? 'free-relay-release.json' : communityRelease ? 'community-release.json' : 'pilot-release.json'), 'utf8'));
const upstream = JSON.parse(await readFile(path.join(root, 'upstream.json'), 'utf8'));
const cache = path.join(root, '.cache');
const source = path.join(cache, 'source');
const archive = path.join(cache, 'source.tar.gz');
await mkdir(cache, { recursive: true });
try { await readFile(archive); } catch {
  execFileSync('curl', ['-fsSL', '--max-time', '180',
    `https://codeload.github.com/vrtmrz/obsidian-livesync/tar.gz/${upstream.commit}`, '-o', archive], { stdio: 'inherit' });
}
const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
if (hash !== upstream.archiveSha256) throw new Error('Upstream archive SHA-256 mismatch');
await rm(source, { recursive: true, force: true });
await mkdir(source, { recursive: true });
execFileSync('tar', ['-xzf', archive, '-C', source, '--strip-components=1']);
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
if (manifest.version !== upstream.version) throw new Error('Unexpected upstream version');
manifest.id = foldersLab ? 'arcalink-folders-lab' : freeRelayLab ? 'arcalink-free-lab' : communityRelease ? 'arcalink-sync' : 'arcalink-livesync-prototype';
manifest.name = foldersLab ? 'ArcaLink Folder Lab' : freeRelayLab ? 'ArcaLink Free Lab' : communityRelease ? 'ArcaLink Sync' : 'ArcaLink';
manifest.version = releaseMetadata.version;
manifest.author = 'ArcaLink';
manifest.authorUrl = 'https://arcalink.ru';
manifest.description = communityRelease
  ? 'Sync notes between devices through ArcaLink, with shared folders and Telegram.'
  : 'Синхронизация ArcaLink: личные хранилища, общие папки и Telegram.';
await writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifest, null, 2));
if (communityRelease) {
  const packagePath = path.join(source, 'package.json');
  const packageMetadata = JSON.parse(await readFile(packagePath, 'utf8'));
  packageMetadata.name = manifest.id;
  packageMetadata.version = manifest.version;
  packageMetadata.description = manifest.description;
  packageMetadata.author = 'ИП Санкин Денис Николаевич';
  packageMetadata.license = 'GPL-3.0-only';
  await writeFile(packagePath, JSON.stringify(packageMetadata, null, 2) + '\n');
  await writeFile(path.join(source, 'updates.md'), `# ArcaLink Sync ${manifest.version}\n\nInitial public release.\n`);
}
// Keep the engine untouched; a maintained subclass owns pilot integration.
const originalEntry = await readFile(path.join(source, 'src/main.ts'), 'utf8');
const invitation = 'inviteToOnboarding: () => showOnboardingInvitation(core, setupManager)';
if (originalEntry.split(invitation).length !== 2) throw new Error('Unexpected upstream onboarding entry');
const remoteSizeFeature='useCheckRemoteSize(core);';
if(originalEntry.split(remoteSizeFeature).length!==2)throw new Error('Unexpected upstream remote-size feature');
await writeFile(path.join(source, 'src/upstream-main.ts'), originalEntry.replace(invitation,
  'inviteToOnboarding: () => undefined').replace(remoteSizeFeature,
  '// ArcaLink checks 95% of the account quota instead of upstream fixed-MB prompts.').replace(
  'export default class ObsidianLiveSyncPlugin extends Plugin {',
  'export default class ObsidianLiveSyncPlugin extends Plugin {\n    declare renderPilotSettings?: (el: HTMLElement) => void;')); // Safety review remains upstream.
// Only the Free connection copy carries a signalling ticket; never persist it.
const upstreamPath=path.join(source,'src/upstream-main.ts');
const freeHook='prepareP2PSettings: useP2PSettingsPreparation(core.services.API.webCompatFetch.bind(core.services.API))';
const freeView='setupManager.registerP2PSetupConnectionProbe(replicator.connectionProbe);';
let freeEntry=await readFile(upstreamPath,'utf8');
if(freeEntry.split(freeHook).length!==2||freeEntry.split(freeView).length!==2)throw Error('Unexpected upstream P2P lifecycle');
freeEntry=freeEntry.replace(freeHook,'prepareP2PSettings: async (settings, signal) => (await (this as any).prepareFreeRelaySettings?.(settings, signal)) ?? await useP2PSettingsPreparation(core.services.API.webCompatFetch.bind(core.services.API))(settings, signal)')
 .replace(freeView,'(this as any).arcalinkP2P = replicator;\n                '+freeView);
await writeFile(upstreamPath,freeEntry);
const tsconfigPath=path.join(source,'tsconfig.json');
const tsconfig=await readFile(tsconfigPath,'utf8');
// Resolve the engine's own plugin types to its base, and editor types to the
// same CodeMirror packages Obsidian provides at runtime. No package upgrades.
const tsPaths='"@/*": ["./src/*"]';
if(tsconfig.split(tsPaths).length!==2)throw Error('Unexpected upstream TypeScript paths');
const tsInclude='"include": ["**/*.ts", "test/**/*.test.ts", "**/*.unit.spec.ts", "**/*.svelte"]';
if(tsconfig.split(tsInclude).length!==2)throw Error('Unexpected upstream TypeScript include list');
await writeFile(tsconfigPath,tsconfig.replace(tsInclude,
  '"include": ["**/*.ts", "src/**/*.mjs", "test/**/*.test.ts", "**/*.unit.spec.ts", "**/*.svelte"]').replace(
  tsPaths,
  '"@/*": ["./src/*"], "@/main": ["./src/upstream-main.ts"], "@/main.ts": ["./src/upstream-main.ts"], "arcalink-native-obsidian": ["./node_modules/obsidian"], "@codemirror/view": ["./node_modules/@codemirror/view"], "@codemirror/state": ["./node_modules/@codemirror/state"]'));
const tabPath = path.join(source, 'src/modules/features/SettingDialogue/ObsidianLiveSyncSettingTab.ts');
const originalTab = await readFile(tabPath, 'utf8');
const emptyMarker = '        containerEl.empty();';
const definitionMarker = '    override getSettingDefinitions(): SettingDefinitionItem[] {';
if (originalTab.split(emptyMarker).length !== 2 || originalTab.split(definitionMarker).length !== 2)
  throw new Error('Unexpected upstream settings renderer');
await writeFile(tabPath, originalTab.replace(emptyMarker, emptyMarker +
  '\n        if (typeof this.plugin.renderPilotSettings === "function") { this.plugin.renderPilotSettings(containerEl.createDiv({cls: "arcalink-pilot-settings"})); return; }')
  .replace(definitionMarker, definitionMarker + '\n        if (typeof this.plugin.renderPilotSettings === "function") return [];'));
// Pilot navigation uses product section names instead of upstream emoji tabs.
const pilotSections = {100:'Изменения',110:'Подключение',20:'Интерфейс',0:'Хранилище',30:'Синхронизация',33:'Выбор файлов',60:'Настройки устройств',50:'Восстановление',46:'Дополнительно',47:'Экспертные',51:'Совместимость',70:'Обслуживание',90:'Помощь'};
const renderedTab=await readFile(tabPath,'utf8');
const iconMarker='text: icon,';
if(renderedTab.split(iconMarker).length!==2)throw Error('Unexpected upstream navigation renderer');
await writeFile(tabPath,renderedTab.replace(iconMarker,`text: (${JSON.stringify(pilotSections)} as Record<number,string>)[order] || title,`));
const modulePath = path.join(source, 'src/modules/features/ModuleObsidianSettingTab.ts');
const settingsModule=(await readFile(modulePath, 'utf8')).replace(
  'openObsidianSettings(this.app, "obsidian-livesync")', 'openObsidianSettings(this.app, this.plugin.manifest.id)');
await writeFile(modulePath,communityRelease||foldersLab?patchSettingsRegistration(settingsModule):settingsModule);
// ArcaLink exposes plugin sync in its settings; omit the legacy plug shortcut.
const configSyncPath=path.join(source,'src/features/ConfigSync/CmdConfigSync.ts');
const configSyncSource=await readFile(configSyncPath,'utf8');
const configSyncRibbon=`        this.addRibbonIcon("custom-sync", $msg("cmdConfigSync.showCustomizationSync"), () => {
            this.showPluginSyncModal();
        }).addClass("livesync-ribbon-showcustom");`;
if(configSyncSource.split(configSyncRibbon).length!==2)throw Error('Unexpected upstream customization ribbon registration');
await writeFile(configSyncPath,configSyncSource.replace(configSyncRibbon,''));

const shared2Sources=(await readdir(path.join(root,'plugin'))).filter(name=>/^shared2.*\.(?:ts|mjs)$/.test(name)).sort();
for (const name of [...shared2Sources,'shared-folder-provider.ts','shared-folder-blobs.mjs','large-content-gate.mjs','main.ts','companion-sync.ts','companion-ownership.ts','companion-ownership-model.mjs','companion-key-transfer.mjs','companion-peer-proof.mjs','companion-bridge.ts','companion-proof.mjs','mobile-assistant.ts','assistant-download.mjs','publication.ts','publication-model.mjs','content-retry.mjs','language-settings.ts','settings-state.mjs','vault-controls.ts','unified-vault.ts','free-relay.ts','free-relay-settings.mjs','desktop.ts','pilot-http.mjs','client-version.mjs','workspaces.ts','replication-drain.mjs','file-encoding.mjs','plugin-sync.mjs','folder-exclusions.mjs','folder-exclusions.ts','folder-rules-ui.ts','folder-rules-tree.mjs','folder-policy.mjs','folder-policy-store.mjs','folder-policies.ts','folder-local-database.mjs','folder-cleanup.mjs','folder-crypto.mjs','folder-mode-proof.mjs','environment.mjs','sync-parameters.mjs','sync-feedback.mjs','mobile-sync-state.mjs','mobile-sync-status.ts','startup-notices.mjs','folders.ts','shared-folder-picker.ts','folder-model.mjs','telegram.ts','telegram-users.mjs','remote-deletion.mjs', 'recovery.mjs', 'storage-warning.mjs', 'collaboration.ts', 'collab-diff.mjs','diagnostic.mjs','localized-obsidian.ts','message-language.mjs','message-catalog.mjs','notice-message.mjs']) {
  const input = path.join(root, 'plugin', name), output = path.join(source, 'src', name);
  if (communityRelease && ['free-relay.ts', 'workspaces.ts'].includes(name)) {
    await writeFile(output, patchCommunityOnboarding(await readFile(input, 'utf8'), name));
  } else await copyFile(input, output);
}
// Reuse the original ArcaLink tray assets; embed them for offline operation.
const trayAssets={};
for(const [key,name] of [['trayImage','arcalink-tray.png'],['trayWhiteImage','arcalink-tray-white.png']])trayAssets[key]='data:image/png;base64,'+(await readFile(path.resolve(root,'../../plugin/arcalink-sync',name))).toString('base64');
await writeFile(path.join(source,'src/tray-images.ts'),Object.entries(trayAssets).map(([key,value])=>'export const '+key+'='+JSON.stringify(value)+';').join('\n'));
// Embed the existing website mark so branding also works offline.
const brandMark=await readFile(path.resolve(root,'../../control-plane-java/src/main/resources/static/assets/arcalink-mark.svg'),'utf8');
await writeFile(path.join(source,'src/brand-logo.ts'),'export const brandLogo='+JSON.stringify('data:image/svg+xml;base64,'+Buffer.from(brandMark).toString('base64'))+';\n');
const buildConfigPath=path.join(source,'esbuild.config.mjs'),buildConfig=await readFile(buildConfigPath,'utf8');
const uiAliasMarker='        moduleAliasPlugin,';
if(buildConfig.split(uiAliasMarker).length!==2)throw Error('Unexpected upstream build plugin list');
await writeFile(buildConfigPath,"import {shared2ProductionPlugin} from '../../scripts/shared2-production-build.mjs';\n"+buildConfig.replace(uiAliasMarker,`
        shared2ProductionPlugin(),        {
            name: "arcalink-localized-ui",
            setup(build) {
                build.onResolve({filter:/^arcalink-native-obsidian$/},()=>({path:"obsidian",external:true}));
                build.onResolve({filter:/^obsidian$/},()=>({path:path.resolve("src/localized-obsidian.ts")}));
            }
        },
${uiAliasMarker}`));
const logPath=path.join(source,'src/modules/features/ModuleLog.ts'),logSource=await readFile(logPath,'utf8');
const displayMarker='        addDisplayLog(newMessage);',statusMarker='this.statusLog.value = messageContent;',activityMarker='message: `${networkActivity}Sync: ${w}';
const logRibbon=`        this.addRibbonIcon("view-log", $msg("moduleLog.showLog"), () => {
            void this.services.API.showWindow(VIEW_TYPE_LOG);
        }).addClass("livesync-ribbon-showlog");`;
const noticeMarker='        if (level >= LOG_LEVEL_NOTICE) {';
if(logSource.split(displayMarker).length!==2||logSource.split(statusMarker).length!==2||logSource.split(activityMarker).length!==2||logSource.split(logRibbon).length!==2||logSource.split(noticeMarker).length!==2)throw Error('Unexpected upstream display log renderer');
await writeFile(logPath,"import {localizeMessage,deferStartupSyncNotice} from '@/localized-obsidian';\n"+logSource.replace(logRibbon,'').replace(displayMarker,'        addDisplayLog(timestamp + "->" + localizeMessage(messageContent));').replace(statusMarker,'this.statusLog.value = localizeMessage(messageContent);').replace('message: newMessage });','message: timestamp + "->" + localizeMessage(messageContent) });').replace(activityMarker,'message: `${networkActivity}${localizeMessage("Sync: ")}${w}').replace(noticeMarker,'        if (level >= LOG_LEVEL_NOTICE && !deferStartupSyncNotice(messageContent)) {'));
// Modal translation must never translate the user's diff fragments or filename.
const conflictPath=path.join(source,'src/modules/features/InteractiveConflictResolving/ConflictResolveModal.ts');
let conflictSource=await readFile(conflictPath,'utf8');
for(const marker of ['const span = container.createSpan({ cls });','diffOptionsRow.createSpan({ text: this.filename });']){
  if(conflictSource.split(marker).length!==2)throw Error('Unexpected upstream conflict content renderer');
  conflictSource=conflictSource.replace(marker,marker==='const span = container.createSpan({ cls });'
    ?marker+'\n            span.setAttr("data-arcalink-user-content", "");'
    :'diffOptionsRow.createSpan({ text: this.filename }, e => e.setAttr("data-arcalink-user-content", ""));');
}
await writeFile(conflictPath,conflictSource);
const historyPath=path.join(source,'src/modules/features/DocumentHistory/DocumentHistoryModal.ts');
const historySource=await readFile(historyPath,'utf8'),historyMarker='    appendSearchHighlightedText(container: HTMLElement, text: string) {';
if(historySource.split(historyMarker).length!==2)throw Error('Unexpected upstream history content renderer');
await writeFile(historyPath,historySource.replace(historyMarker,historyMarker+'\n        container = container.createSpan({}, e => e.setAttr("data-arcalink-user-content", ""));'));
// Localise before Markdown rendering, and keep the catalogue's original parameter names.
const translationPath=path.join(source,'src/common/translation.ts'),translationSource=await readFile(translationPath,'utf8');
const catalogueReturn='    return msg ?? key;',commonlibReturn='if (!isLiveSyncMessageKey(key)) return englishMessageTranslator(key, params);';
if(translationSource.split(catalogueReturn).length!==2||translationSource.split(commonlibReturn).length!==2)throw Error('Unexpected upstream translation boundary');
await writeFile(translationPath,"import {localizeMessage} from '@/localized-obsidian';\n"+translationSource.replace(catalogueReturn,'    return localizeMessage(msg ?? key);').replace(commonlibReturn,'if (!isLiveSyncMessageKey(key)) return localizeMessage(englishMessageTranslator(key, params));').replace('return englishMessageTranslator(key);','return localizeMessage(englishMessageTranslator(key));'));
// Translate a complete popup before it becomes separate text/link DOM nodes.
const popupPath=path.join(source,'src/modules/services/ObsidianConfirm.ts');
const popupSource=await readFile(popupPath,'utf8'),popupMarker='dialogText.split("{HERE}", 2)';
if(popupSource.split(popupMarker).length!==2)throw Error('Unexpected upstream popup fragment renderer');
await writeFile(popupPath,"import {localizeMessage} from '@/localized-obsidian';\n"+popupSource.replace(popupMarker,'localizeMessage(dialogText).split("{HERE}", 2)'));
// Route the former diagnostic pane to the ordinary vault settings.
const p2pUiPath=path.join(source,'src/serviceFeatures/useP2PReplicatorUI.ts');
const p2pUi=await readFile(p2pUiPath,'utf8');
const statusStart=p2pUi.indexOf('    const openStatusPane = () => {');
const statusEnd=p2pUi.indexOf('    const runOpenReplication',statusStart);
if(statusStart<0||statusEnd<0)throw Error('Unexpected upstream P2P status entry');
await writeFile(p2pUiPath,p2pUi.slice(0,statusStart)+`    const openStatusPane = () => {
        window.dispatchEvent(new CustomEvent('arcalink-open-vault-controls'));
        return Promise.resolve();
    };
`+p2pUi.slice(statusEnd));
const preflightPath=path.join(source,'src/serviceFeatures/replication/preflight.ts');
const preflight=await readFile(preflightPath,'utf8'),fatalMarker='errorManager.showError(ensureMessage, showMessage ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO);';
const seedHandler='    return async function canReplicateWithSecuritySeed',seedCleared='        errorManager.clearError(ensureMessage);';
if(preflight.split(fatalMarker).length!==2||preflight.split(seedHandler).length!==2||preflight.split(seedCleared).length!==2)throw Error('Unexpected seed preflight error renderer');
await writeFile(preflightPath,preflight.replace(seedHandler,'    let pilotSeedFailure: string | undefined;\n'+seedHandler).replace(fatalMarker,`const explanation = await (context.services.API as any).pilotFailureMessage?.() || "Не удалось получить параметры синхронизации с сервера. Проверьте соединение и повторите синхронизацию.";
            if (pilotSeedFailure && pilotSeedFailure !== explanation) errorManager.clearError(pilotSeedFailure);
            pilotSeedFailure = explanation;
            const report = (context.services.API as any).pilotReportParameterFailure;
            if (report) report(explanation, showMessage);
            errorManager.showError(explanation, report ? LOG_LEVEL_INFO : showMessage ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO);`).replace(seedCleared,seedCleared+'\n        if (pilotSeedFailure) errorManager.clearError(pilotSeedFailure);\n        pilotSeedFailure = undefined;'));
const doctorPath=path.join(source,'src/serviceFeatures/startupLifecycle/configDoctor.ts');
await writeFile(doctorPath,patchConfigDoctor(await readFile(doctorPath,'utf8')));
const env = { ...process.env, PATHS_TEST_INSTALL: '' };
// Retain cloud metadata after a failed content read, using the existing
// processor and its revision/deletion checks for every delayed attempt.
const resultProcessorPath=path.join(source,'src/serviceFeatures/replication/ReplicateResultProcessor.ts');
await writeFile(resultProcessorPath,patchContentRetryProcessor(await readFile(resultProcessorPath,'utf8')));
const replicationFeaturePath=path.join(source,'src/serviceFeatures/replication/index.ts');
await writeFile(replicationFeaturePath,patchContentRetryLifecycle(await readFile(replicationFeaturePath,'utf8')));
for(const name of ['receivedChangeReadiness.unit.spec.ts','replicationFeature.unit.spec.ts']){
 const fixturePath=path.join(source,'src/serviceFeatures/replication',name);
 await writeFile(fixturePath,patchContentRetryFixture(await readFile(fixturePath,'utf8')));
}
await copyFile(path.join(root,'tests/content-retry.integration.unit.spec.ts'),path.join(source,'src/content-retry.integration.unit.spec.ts'));
execFileSync('npm', ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: source, env, stdio: 'inherit' });
await patchMaintainedEngine(source,{foldersLab});
// Preserve attachment encodings at the Obsidian boundary. Explicit binary
// metadata must also take precedence over the filename's text extension.
const accessPath=path.join(source,'src/serviceModules/FileAccessObsidian.ts');
const accessSource=await readFile(accessPath,'utf8'),accessMarker='    constructor(app: App, dependencies: FileAccessBaseDependencies) {';
if(accessSource.split(accessMarker).length!==2)throw Error('Unexpected upstream file access boundary');
await writeFile(accessPath,"import {decodeFilePreservingBytes} from '@/file-encoding.mjs';\nimport {isPlainText} from '@vrtmrz/livesync-commonlib/compat/string_and_binary/path';\n"+accessSource.replace(accessMarker,`    override async vaultReadAuto(file: any) {
        return decodeFilePreservingBytes(await this.vaultReadBinary(file), isPlainText(this.getPath(file)));
    }
    override async adapterReadAuto(file: any) {
        return decodeFilePreservingBytes(await this.adapterReadBinary(file), isPlainText(this.getPath(file)));
    }
${accessMarker}`));
execFileSync('npm', ['ci','--include=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:path.join(root,'collaboration'),env,stdio:'inherit'});
// Resolve the separate pinned collaboration tree without modifying upstream lock.
for(const name of ['yjs','y-codemirror.next','y-indexeddb','@hocuspocus/provider','lib0']){const target=path.join(source,'node_modules',name);await mkdir(path.dirname(target),{recursive:true});await rm(target,{recursive:true,force:true});const {symlink}=await import('node:fs/promises');await symlink(path.join(root,'collaboration/node_modules',name),target,'dir');}
execFileSync('npm', ['run', 'build'], { cwd: source, env, stdio: 'inherit' });
const audit = await auditBundle(source);
const dist = path.join(root, 'dist', manifest.id);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const name of ['main.js', 'manifest.json', 'styles.css', 'LICENSE']) {
  await copyFile(path.join(source, name), path.join(dist, name));
}
if (communityRelease) {
  await copyFile(path.resolve(root, '../../plugin/arcalink-sync/LICENSE'), path.join(dist, 'LICENSE'));
}
if (communityRelease || foldersLab) {
  await writeFile(path.join(dist, 'versions.json'), JSON.stringify({[manifest.version]: manifest.minAppVersion}, null, 2) + '\n');
}
if (foldersLab) await copyFile(path.join(root, 'FOLDER-LAB.md'), path.join(dist, 'README.md'));
await writeFile(path.join(dist, 'styles.css'), (await readFile(path.join(dist, 'styles.css'), 'utf8')) + '\n' + await readFile(path.join(root, 'plugin', 'styles.css'), 'utf8'));
await writeFile(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
await writeFile(path.join(dist, 'THIRD_PARTY_NOTICES.txt'), audit.notices);
await writeFile(path.join(root, 'dist', 'license-inventory.json'), JSON.stringify(audit.inventory, null, 2));
await writeFile(path.join(dist, 'UPSTREAM.json'), JSON.stringify(upstream, null, 2));
execFileSync(process.execPath, ['--check', path.join(dist, 'main.js')]);
const zip = path.join(root, 'dist', manifest.id + '.zip');
await rm(zip, { force: true });
// Community installs individual release assets; its clean build must not
// require an OS archive utility. Internal release ZIPs retain their workflow.
if (!communityRelease) execFileSync('zip', ['-qr', zip, manifest.id], { cwd: path.join(root, 'dist') });
console.log(`Built ${communityRelease ? dist : zip}; license audit: ${audit.inventory.length} bundled packages.`);
