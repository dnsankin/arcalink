import {isFreeRelayConnection,FREE_SIGNAL_URL} from './free-relay-settings.mjs';
import { requestPilot, responseData, responseError } from './pilot-http.mjs';
import { Modal, Notice, Setting, requestUrl, Platform } from 'obsidian';
import { VER } from '@vrtmrz/livesync-commonlib/compat/common/types';
import { checkRemoteVersion, checkSyncInfo } from '@vrtmrz/livesync-commonlib/compat/pouchdb/negotiation';
import { REMOTE_RESOURCE_KINDS } from '@vrtmrz/livesync-commonlib/replication';
import { decrypt as decryptHKDF } from 'octagonal-wheels/encryption/hkdf';
import { decrypt as decryptLegacy } from 'octagonal-wheels/encryption/encryption';
import { createNewVaultSettings } from '@vrtmrz/livesync-commonlib/settings';
import { waitForReplicationDrain } from './replication-drain.mjs';
import { pluginSyncSettings } from './plugin-sync.mjs';
import { upsertRemoteConfigurationInPlace } from '@vrtmrz/livesync-commonlib/remote-configurations';
const BASE = 'https://arcalink.ru';
const SYNC_FLAGS = ['liveSync', 'periodicReplication', 'syncOnSave', 'syncOnEditorSave', 'syncOnStart', 'syncOnFileOpen', 'syncAfterMerge'];
const PAUSED_SYNC = Object.fromEntries(SYNC_FLAGS.map(key => [key, false]));
export class Workspaces {
    plugin: any;
    pending: any = null;
    busy = false;
    mergeRecovery: any = null;
    constructor(plugin: any) { this.plugin = plugin; }
    get sessionPath() { return this.plugin.pilotDirectory + '/pilot-session.json'; }
    async session() { try {
        return JSON.parse(await this.plugin.app.vault.adapter.read(this.sessionPath));
    }
    catch {
        return {};
    } }
    auth() { const s = this.plugin.core.services.setting.currentSettings(); if (this.pending)
        return 'Bearer ' + this.pending.access_token; if (!s.isConfigured)
        throw Error('Сначала войдите в аккаунт'); return 'Basic ' + btoa(s.couchDB_USER + ':' + s.couchDB_PASSWORD); }
    async api(action: string, body: any = {}) {
        let free=!this.pending&&isFreeRelayConnection(this.plugin.core.services.setting.currentSettings())?await this.plugin.freeRelay.session():null;
        if(free?.refreshToken&&free.accessExpiresAt<=Date.now()+120000)free=await this.plugin.freeRelay.refresh(free);
        const authorization=free?.accessToken?'Bearer '+free.accessToken:this.auth();
        const r = await requestPilot(requestUrl, { url: this.plugin.unifiedVault.base + '/workspaces/' + action, method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body), throw: false }); if (r.status !== 200)
        throw Object.assign(Error(responseError(r, 'Хранилища временно недоступны')), {status:r.status}); return responseData(r); }
    async login(email: string, password: string) {
        email = email.trim().toLowerCase();
        if (!email) throw Error('Введите электронную почту');
        const old = await this.session();
        const freeSession=await this.plugin.freeRelay.session();
        if(!old.deviceId&&freeSession?.email===email)Object.assign(old,{email,deviceId:freeSession.deviceId});
        const settings = this.plugin.core.services.setting.currentSettings();
        if (!password) {
            if ((settings.isConfigured && old.email === email) || this.pending?.email === email) {
                await this.api('list');
                return true;
            }
            throw Error('Введите пароль для входа в аккаунт');
        }
        const r = await requestPilot(requestUrl, { url: BASE + '/auth/password/login', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, device_name: 'Pilot ' + this.plugin.app.vault.getName(), platform: Platform.isMobile ? 'mobile' : 'desktop', app_version: this.plugin.manifest.version, ...(old.email === email && old.deviceId ? { device_id: old.deviceId } : {}) }), throw: false });
        if (r.status < 200 || r.status >= 300 || !responseData(r)?.access_token || !responseData(r)?.device?.id)
            throw Error(responseError(r, 'Не удалось войти: проверьте почту и пароль'));
        const previousPending = this.pending;
        this.pending = { ...responseData(r), email };
        try {
            const s = this.plugin.core.services.setting.currentSettings(), list = await this.api('list');
            if (s.isConfigured) {
                const binding=await this.plugin.unifiedVault.saved();
                const space = list.workspaces.find((w: any) => isFreeRelayConnection(s)?w.id===binding?.workspaceId:w.database === s.couchDB_DBNAME);
                if (!space)
                    throw Error('Для другого аккаунта используйте отдельное локальное хранилище. Текущее подключение сохранено.');
            }
            await this.plugin.unifiedVault.rememberAuth(this.pending,email);
            const existing=await this.plugin.freeRelay.session();
            if(existing)await this.plugin.app.vault.adapter.write(this.plugin.freeRelay.sessionPath,JSON.stringify({...existing,email,deviceId:this.pending.device.id,accessToken:this.pending.access_token,refreshToken:this.pending.refresh_token,accessExpiresAt:Date.parse(this.pending.auth_session?.access_expires_at)}));
            if(isFreeRelayConnection(settings))this.pending=null;
            return true;
        }
        catch (e) {
            this.pending = previousPending;
            throw e;
        }
    }
    choose(spaces: any[], host?: HTMLElement) {
        const m = host ? null : new Modal(this.plugin.app), content = host || m!.contentEl, settings = this.plugin.core.services.setting.currentSettings();
        const close = () => m?.close();
        const current = settings.isConfigured ? spaces.find(w => w.database === settings.couchDB_DBNAME) : null;
        m?.titleEl.setText('Серверные хранилища ArcaLink');
        content.addClass('arcalink-workspace-dialog');
        content.createEl('p', { text: 'Локальное хранилище: «' + this.plugin.app.vault.getName() + '».' + (current ? ' Подключено к «' + current.title + '».' : ' Пока не подключено. Выберите серверное хранилище и подтвердите подключение.') });
        content.createEl('p', { text: 'Создание нового серверного хранилища не меняет текущее подключение. Подключение к другому хранилищу объединит его заметки с локальными после вашего подтверждения.' });
        let wid = '', passphrase = '', mergeConfirmed = false, connectButton: any, deleteButton: any;
        const selection = new Setting(content).setName('Серверное хранилище');
        const phrase = new Setting(content).setName('Парольная фраза').setDesc('Для зашифрованного хранилища используйте ту же фразу, что и на другом устройстве. Для нового пустого хранилища задайте фразу и сохраните её.').addText(t => { t.inputEl.type = 'password'; t.onChange(v => passphrase = v); });
        phrase.settingEl.hidden = true;
        const explanation = new Setting(content).setName('Подключение').setDesc('Хранилище не выбрано. Подключение не меняется, пока вы не подтвердите выбор.');
        let mergeToggle: any;
        const mergeWarning = new Setting(content).setName('Я понимаю, что произойдёт слияние хранилищ').addToggle(t => { mergeToggle = t; t.onChange(value => { mergeConfirmed = value; updateSelection(); }); });
        mergeWarning.settingEl.hidden = true;
        const deletion = new Setting(content).setName('Удаление серверного хранилища').setDesc('Выберите неподключённое хранилище для удаления.').addButton(b => {
            deleteButton = b;
            b.setButtonText('Удалить хранилище').setWarning().setDisabled(true).onClick(() => {
                const space = spaces.find(w => w.id === wid);
                if (!space || space.connected || space.database === settings.couchDB_DBNAME) return;
                close();
                void this.deleteDialog(space);
            });
        });
        const updateSelection = () => {
            const space = spaces.find(w => w.id === wid), same = !!settings.isConfigured && !!space && space.database === settings.couchDB_DBNAME;
            const resuming = !!this.mergeRecovery;
            const blocked = resuming && space?.id !== this.mergeRecovery.target.id;
            phrase.settingEl.hidden = blocked || !space?.encrypted || (same && !resuming && !!settings.passphrase);
            mergeWarning.settingEl.hidden = !space || (same && !resuming) || blocked;
            if (space) mergeWarning.setDesc('Произойдёт слияние локального хранилища «' + this.plugin.app.vault.getName() + '» и серверного «' + space.title + '»: локальные заметки будут загружены на сервер, а серверные заметки — скачаны в Obsidian. Прежнее серверное хранилище сохранится. Дальнейшие изменения будут отправляться только в выбранное хранилище. Перед подключением сохраните резервную копию важных заметок.');
            connectButton.setDisabled(this.busy || !space || blocked || ((!same || resuming) && !mergeConfirmed)).setButtonText('Подключить');
            const deletionBlocked = same || !!space?.connected || this.busy;
            deleteButton.setDisabled(!space || deletionBlocked);
            deletion.setDesc(!space ? 'Выберите неподключённое хранилище для удаления.' : deletionBlocked ? 'Удаление заблокировано: хранилище подключено к устройству или используется общей папкой, Telegram либо переносом шифрования.' : 'Удалится только выбранное серверное хранилище. Перед удалением потребуется подтверждение.');
            explanation.setDesc(!space ? 'Выберите серверное хранилище. Автоматического подключения нет.' : blocked ? 'Сначала завершите слияние с «' + this.mergeRecovery.target.title + '»: выберите это хранилище и нажмите «Подключить».' : resuming ? 'Автосинхронизация приостановлена. Подтвердите продолжение слияния с «' + space.title + '».' : same ? 'Обновится только текущее подключение к «' + space.title + '». Заметки и режим шифрования сохранятся.' : 'После подтверждения заметки этого локального хранилища будут синхронизироваться с «' + space.title + '». Если здесь уже есть заметки, они будут объединены с серверными.');
        };
        selection.addDropdown(d => {
            d.addOption('', 'Выберите хранилище…');
            for (const w of spaces) d.addOption(w.id, w.title + (w.id === current?.id ? ' — подключено' : '') + (w.encrypted ? ' — с шифрованием' : ''));
            d.setValue('').onChange(v => { wid = v; mergeConfirmed = false; mergeToggle.setValue(false); updateSelection(); });
        });
        new Setting(content).addButton(b => {
            connectButton = b;
            b.setButtonText('Подключить').setCta().setDisabled(true).onClick(async () => {
                b.setDisabled(true);
                try {
                    const space = spaces.find(w => w.id === wid);
                    if ((!settings.isConfigured || space?.database !== settings.couchDB_DBNAME || this.mergeRecovery) && !mergeConfirmed) throw Error('Подтвердите слияние локального и серверного хранилищ');
                    await this.connect(space, !this.mergeRecovery && space?.database === settings.couchDB_DBNAME ? (settings.passphrase || passphrase) : passphrase, mergeConfirmed);
                    close();
                    this.plugin.app.setting.activeTab?.display();
                } catch (e: any) { new Notice(e.message, 12000); if (this.mergeRecovery) this.plugin.app.setting.activeTab?.display(); }
                finally { updateSelection(); }
            });
        }).addButton(b => b.setButtonText('Создать новое').onClick(() => { close(); this.createDialog(); }));
        m?.open();
    }
    async renderCatalog(host: HTMLElement) {
        const status = host.createEl('p', { text: 'Загружаем серверные хранилища…' });
        try {
            const { workspaces } = await this.api('list');
            this.mergeRecovery = await this.pendingMerge();
            if (!status.isConnected) return;
            host.empty();this.choose(workspaces, host);
        } catch (e: any) { if (status.isConnected) status.setText(e.message); }
    }
    async deleteDialog(space: any) {
        try {
            const settings = this.plugin.core.services.setting.currentSettings();
            if (space.connected || (settings.isConfigured && space.database === settings.couchDB_DBNAME)) throw Error('Нельзя удалить подключённое хранилище');
            if (await this.pendingMerge()) throw Error('Сначала завершите слияние хранилищ');
            if (this.busy || await this.pendingMigration()) throw Error('Сначала завершите перенос шифрования');
            const m = new Modal(this.plugin.app);
            m.titleEl.setText('Удалить серверное хранилище?');
            m.contentEl.createEl('p', { text: 'Серверное хранилище «' + space.title + '» и его данные будут удалены без возможности восстановления. Локальные заметки Obsidian и текущее подключение сохранятся. Подключённые хранилища удалять нельзя.' });
            let confirmation = '', deleteButton: any;
            new Setting(m.contentEl).setName('Введите название хранилища').setDesc(space.title).addText(t => t.onChange(value => { confirmation = value; deleteButton.setDisabled(confirmation !== space.title); }));
            new Setting(m.contentEl).addButton(b => b.setButtonText('Отмена').onClick(() => { m.close(); void this.showCatalog(); })).addButton(b => {
                deleteButton = b;
                b.setButtonText('Удалить навсегда').setWarning().setDisabled(true).onClick(async () => {
                    if (confirmation !== space.title) return;
                    b.setDisabled(true);
                    try {
                        if (await this.pendingMerge()) throw Error('Сначала завершите слияние хранилищ');
                        if (this.busy || await this.pendingMigration()) throw Error('Сначала завершите перенос шифрования');
                        await this.api('delete', { id: space.id, confirm_title: confirmation });
                        m.close();
                        new Notice('Серверное хранилище «' + space.title + '» удалено. Локальные заметки и текущее подключение сохранены.');
                        await this.showCatalog();
                        this.plugin.app.setting.activeTab?.display();
                    } catch (e: any) { new Notice(e.message); }
                    finally { b.setDisabled(confirmation !== space.title); }
                });
            });
            m.open();
        } catch (e: any) { new Notice(e.message); }
    }
    createDialog() {
        const m = new Modal(this.plugin.app);
        m.titleEl.setText('Новое серверное хранилище');
        m.contentEl.createEl('p', { text: 'Хранилище появится в вашем аккаунте. Текущее подключение и локальные заметки останутся на месте. Подключить новое хранилище можно отдельным действием после создания.' });
        let title = this.plugin.app.vault.getName(), encrypted = false;
        new Setting(m.contentEl).setName('Название').addText(t => t.setValue(title).onChange(v => title = v.trim()));
        new Setting(m.contentEl).setName('Шифрование личных заметок').setDesc('Парольную фразу задайте при первом подключении к этому хранилищу. На остальных устройствах используйте ту же фразу; восстановление невозможно.').addToggle(t => t.setValue(encrypted).onChange(v => encrypted = v));
        new Setting(m.contentEl).addButton(b => b.setButtonText('Создать').setCta().onClick(async () => {
            b.setDisabled(true);
            try {
                const w = await this.api('create', { title, encrypted });
                m.close();
                new Notice('Серверное хранилище «' + w.title + '» создано. Текущее подключение не изменилось.');
                await this.showCatalog();
            } catch (e: any) { new Notice(e.message); }
            finally { b.setDisabled(false); }
        }));
        m.open();
    }
    async connect(space: any, passphrase = '', mergeConfirmed = false) {
        if (this.busy) throw Error('Подключение уже выполняется');
        if (await this.pendingMigration())
            throw Error('Сначала завершите перенос шифрования');
        if (!space)
            throw Error('Выберите хранилище');
        const p = this.plugin, s = p.core.services.setting.currentSettings(), wasConfigured = !!s.isConfigured;
        if(!wasConfigured&&this.pending){
            let state;
            try { state=await this.api('state',{id:space.id}); }
            catch(e:any) { if(e.status!==404)throw e; } // Older gateways keep their existing cloud authorization path.
            if(state?.policy_version===1&&state.relay_free_enabled&&state.sync_mode==='relay'){
                if(state.workspace_id!==space.id||state.relay_group!==space.id||typeof state.relay_passphrase!=='string'||state.relay_passphrase.length<16)throw Error('Некорректная привязка Free');
                if(space.encrypted&&!passphrase)throw Error('Введите парольную фразу хранилища');
                const session={email:this.pending.email,deviceId:this.pending.device.id,accessToken:this.pending.access_token,refreshToken:this.pending.refresh_token,accessExpiresAt:Date.parse(this.pending.auth_session?.access_expires_at),group:space.id};
                const credentials=await p.freeRelay.credentials(session);
                const settings={...createNewVaultSettings(),isConfigured:true,remoteType:'ONLY_P2P',liveSync:false,syncOnSave:false,syncOnStart:false,encrypt:!!space.encrypted,passphrase:space.encrypted?passphrase:'',P2P_Enabled:true,P2P_AutoStart:true,P2P_AutoBroadcast:true,P2P_AutoAccepting:1,P2P_AutoSyncPeers:'~.*',P2P_AutoWatchPeers:'~.*',P2P_relays:FREE_SIGNAL_URL,P2P_roomID:credentials.room,P2P_passphrase:state.relay_passphrase,P2P_AppID:'self-hosted-livesync',P2P_connectionPath:'relay'};
                upsertRemoteConfigurationInPlace(settings as any,'p2p',{id:'arcalink-free',name:space.title,activate:true,activateForP2P:true});
                await p.app.vault.adapter.write(p.freeRelay.sessionPath,JSON.stringify(session));
                const saved=await p.unifiedVault.saved();await p.unifiedVault.save({...saved,workspaceId:space.id,title:space.title});
                await p.app.vault.adapter.write(this.sessionPath,JSON.stringify({email:session.email,deviceId:session.deviceId,workspaceId:space.id,workspaceTitle:space.title}));
                await p.core.services.setting.applyPartial(settings,true);this.pending=null;
                // An unconfigured startup generation cannot initialise its database.
                // Ask the user to restart after saving the complete connection.
                await p.core.services.appLifecycle.askRestart("Connection settings are saved. Restart Obsidian to start syncing. Restart now?");
                return;
            }
        }
        const pending = await this.pendingMerge();
        if (pending || (wasConfigured && s.couchDB_DBNAME !== space.database)) {
            if (!mergeConfirmed) throw Error('Подтвердите слияние локального и серверного хранилищ');
            return this.mergeWorkspace(space, passphrase, pending);
        }
        if (space.encrypted === true && !passphrase)
            throw Error('Введите парольную фразу зашифрованного хранилища');
        const access = await this.api('connect', { id: space.id });
        const settings = { ...(wasConfigured ? s : createNewVaultSettings()), couchDB_URI: access.url.replace(/\/$/, ''), couchDB_DBNAME: access.database, couchDB_USER: access.user, couchDB_PASSWORD: access.password, isConfigured: true, liveSync: true, syncOnSave: true, syncOnStart: true, ...(!wasConfigured ? { customChunkSize: 60, encrypt: !!space.encrypted, passphrase: space.encrypted ? passphrase : '' } : {}) };
        Object.assign(settings, pluginSyncSettings(s.syncInternalFiles, p.app.vault.configDir, p.manifest.id));
        upsertRemoteConfigurationInPlace(settings as any, 'couchdb', { id: 'arcalink-pilot', name: 'ArcaLink', activate: true });
        await this.checkDestinationKey(settings);
        await p.core.services.setting.applyPartial(settings, true);
        const old = await this.session();
        await p.app.vault.adapter.write(this.sessionPath, JSON.stringify({ email: this.pending?.email || old.email, deviceId: this.pending?.device.id || old.deviceId, workspaceId: space.id, workspaceTitle: space.title }));
        this.pending = null;
        if (wasConfigured)
            await p.core.services.control.applySettings();
        else {
            await p.core.services.appLifecycle.askRestart("Connection settings are saved. Restart Obsidian to start syncing. Restart now?");
        }
        if (wasConfigured) new Notice('Вход выполнен. Подключено хранилище «' + space.title + '».');
    }
    get mergeJournal() { return this.plugin.pilotDirectory + '/workspace-merge.json'; }
    async pauseUnfinishedMerge() {
        if (await this.plugin.app.vault.adapter.exists(this.mergeJournal))
            await this.plugin.core.services.setting.applyPartial(PAUSED_SYNC, true);
        return true;
    }
    async pendingMerge() {
        // Missing is the only recoverable read error: a damaged journal must not bypass the pause.
        const adapter = this.plugin.app.vault.adapter;
        if (!await adapter.exists(this.mergeJournal)) return null;
        let journal;
        try { journal = JSON.parse(await adapter.read(this.mergeJournal)); }
        catch { throw Error('Не удалось прочитать журнал слияния. Автосинхронизация должна оставаться выключенной.'); }
        if (!journal.target?.id || !journal.target.database || !journal.suffix || !journal.sync)
            throw Error('Не удалось прочитать журнал слияния. Автосинхронизация должна оставаться выключенной.');
        return journal;
    }
    async checkDestinationKey(settings: any) {
        if (!settings.encrypt) return;
        const services = this.plugin.core.services, headers = { Authorization: 'Basic ' + btoa(settings.couchDB_USER + ':' + settings.couchDB_PASSWORD) };
        const base = settings.couchDB_URI + '/' + encodeURIComponent(settings.couchDB_DBNAME);
        const read = async (path: string) => {
            const r = await requestPilot(requestUrl, { url: base + path, headers, throw: false });
            if (r.status !== 200 && r.status !== 404) throw Error('Не удалось проверить ключ шифрования: сервер недоступен');
            return r.status === 200 ? responseData(r) : null;
        };
        let witness = await read('/syncinfo');
        // Older clients did not create syncinfo. Validate an existing encrypted chunk before creating the marker.
        if (!witness?.e_) {
            let after = 'h:';
            for (;;) {
                const page = await read('/_all_docs?include_docs=true&limit=32&startkey=' + encodeURIComponent(JSON.stringify(after)) + '&endkey=' + encodeURIComponent(JSON.stringify('h;')));
                if (!page) throw Error('Не удалось проверить ключ шифрования: сервер недоступен');
                witness = page.rows.find((r: any) => r.doc?.e_)?.doc;
                if (witness || page.rows.length < 32) break;
                after = page.rows[page.rows.length - 1].id + '\u0000';
            }
        }
        if (witness?.e_) {
            const seed = await services.replicator.createRemoteResource(REMOTE_RESOURCE_KINDS.SECURITY_SEED, settings);
            if (!seed) throw Error('Не удалось проверить ключ шифрования: сервер недоступен');
            try {
                const salt = await seed.read();
                try {
                    if (witness.data.startsWith('%=')) await decryptHKDF(witness.data, settings.passphrase, salt);
                    else {
                        try { await decryptLegacy(witness.data, settings.passphrase, settings.useDynamicIterationCount); }
                        catch { await decryptLegacy(witness.data, settings.passphrase, false); }
                    }
                }
                catch { throw Error('Парольная фраза не подходит к выбранному серверному хранилищу. Данные не загружены.'); }
            } finally { await seed.dispose(); }
        }
        // An empty DB needs the engine's version document before syncinfo; otherwise the engine
        // correctly rejects the now non-empty unversioned DB. Own this trial connection explicitly.
        const verifier = await services.replicator.createReplicator(settings);
        let connection: any;
        try {
            connection = await verifier.connectRemoteCouchDBWithSetting(settings, Platform.isMobile, true);
            if (typeof connection === 'string') throw Error('Не удалось проверить ключ шифрования: сервер недоступен');
            if (!await checkRemoteVersion(connection.db, async () => false, VER))
                throw Error('Версия серверного хранилища несовместима. Текущее подключение сохранено.');
            if (!await checkSyncInfo(connection.db)) throw Error('Парольная фраза не подходит к выбранному серверному хранилищу. Данные не загружены.');
        } finally {
            try { if (connection && typeof connection !== 'string') await connection.close(); }
            finally { await verifier.closeReplication(); }
        }
    }
    async waitForReflection() {
        const r = this.plugin.core.services.replication;
        if (!await waitForReplicationDrain(() => [r.replicationResultCount.value, r.storageApplyingCount.value, r.databaseQueueCount.value]))
            throw Error('Не удалось завершить обработку заметок. Повторите подключение после завершения текущей синхронизации.');
    }
    async mergeWorkspace(space: any, passphrase: string, pending: any) {
        if (this.busy) throw Error('Подключение уже выполняется');
        const p = this.plugin, services = p.core.services, adapter = p.app.vault.adapter;
        const current = JSON.parse(JSON.stringify(services.setting.currentSettings()));
        if (pending && pending.target.id !== space.id)
            throw Error('Сначала завершите слияние с «' + pending.target.title + '»');
        if (space.encrypted && !passphrase) throw Error('Введите парольную фразу зашифрованного хранилища');
        if (!services.API.isOnline) throw Error('Для слияния нужен доступ к интернету');
        const paused = PAUSED_SYNC;
        const journal = pending || {
            source_database: current.couchDB_DBNAME,
            target: { id: space.id, database: space.database, title: space.title, encrypted: !!space.encrypted },
            suffix: 'arcalink-merge-' + crypto.randomUUID(),
            sync: Object.fromEntries(SYNC_FLAGS.map(key => [key, !!current[key]])),
        };
        this.busy = true;
        try {
            // Persist the continuation before pausing or changing the selected database. No credentials here.
            await adapter.write(this.mergeJournal, JSON.stringify(journal));
            this.mergeRecovery = journal;
            await services.setting.applyPartial(paused, true);
            await services.control.applySettings();
            await services.replicator.onCloseActiveReplication();
            await this.waitForReflection();
            const access = await this.api('connect', { id: space.id });
            if (access.database !== journal.target.database) throw Error('Сервер вернул другое хранилище');
            const target = { ...current, ...paused, couchDB_URI: access.url.replace(/\/$/, ''), couchDB_DBNAME: access.database,
                couchDB_USER: access.user, couchDB_PASSWORD: access.password, additionalSuffixOfDatabaseName: journal.suffix,
                encrypt: !!space.encrypted, passphrase: space.encrypted ? passphrase : '', isConfigured: true };
            upsertRemoteConfigurationInPlace(target as any, 'couchdb', { id: 'arcalink-pilot', name: 'ArcaLink', activate: true });
            await this.checkDestinationKey(target);
            await services.setting.applyPartial(target, true);
            await p.folders.copyBindings();
            // Open a fresh namespace, never reset the source DB or export its deletion history.
            if (await services.databaseEvents.initialiseDatabase(true, true, true) !== true)
                throw Error('Не удалось подготовить локальные заметки');
            // Validate destination encryption before uploading anything; then retain native conflict revisions.
            if (!await services.replication.onBeforeReplicate(true)
                || !await services.replication.replicateAllFromRemoteForRebuild(true))
                throw Error('Не удалось скачать заметки. Проверьте соединение и парольную фразу');
            await this.waitForReflection();
            if (!await services.replication.replicateAllToRemoteForRebuild(true))
                throw Error('Не удалось загрузить заметки');
            if (!await p.core.rebuilder.completePreparedRebuild()) throw Error('Не удалось завершить слияние');
            const old = await this.session();
            await adapter.write(this.sessionPath, JSON.stringify({ email: this.pending?.email || old.email,
                deviceId: this.pending?.device.id || old.deviceId, workspaceId: space.id, workspaceTitle: space.title }));
            this.pending = null;
            await services.setting.applyPartial(journal.sync, true);
            await services.control.applySettings();
            await adapter.remove(this.mergeJournal);
            this.mergeRecovery = null;
            new Notice('Подключено хранилище «' + space.title + '». Слияние завершено, прежнее серверное хранилище сохранено.', 12000);
        } catch (e: any) {
            // A failed transfer must never silently resume background sync (including after restart).
            await services.setting.applyPartial(paused, true);
            await services.control.applySettings();
            throw Error('Слияние с «' + space.title + '» не завершено. Автосинхронизация приостановлена. Выберите это хранилище и нажмите «Подключить», чтобы продолжить.\n' + e.message);
        } finally { this.busy = false; }
    }
    async showCatalog() {
        this.plugin.pilotSettingsTab = 'vaults';
        this.plugin.app.setting.open();
        this.plugin.app.setting.openTabById(this.plugin.manifest.id);
        this.plugin.app.setting.activeTab?.display();
    }
    encryptionDialog(value: boolean) { const m = new Modal(this.plugin.app); m.titleEl.setText(value ? 'Включить шифрование' : 'Отключить шифрование'); m.contentEl.createEl('p', { text: 'Заметки будут скопированы в новое серверное хранилище с выбранным режимом. Старое хранилище сохранится; для копии нужно свободное место в квоте аккаунта. Перед переносом синхронизируйте все устройства и закройте редактирование. Остальные устройства подключите к новому серверному хранилищу с подтверждением слияния. Общие папки и совместные заметки видны серверу в обоих режимах.' }); let passphrase = '', confirmed = false; new Setting(m.contentEl).setName('Новая парольная фраза').setDesc(value ? 'Не менее 12 символов. Запишите её: восстановление невозможно.' : 'После отключения сервер сможет читать личные заметки.').addText(t => { t.inputEl.type = 'password'; t.setDisabled(!value); t.onChange(v => passphrase = v); }); new Setting(m.contentEl).setName('Все устройства синхронизированы, редактирование закрыто').addToggle(t => t.onChange(v => confirmed = v)); new Setting(m.contentEl).addButton(b => b.setButtonText('Перенести заметки').setCta().onClick(async () => { b.setDisabled(true); try {
        if (!confirmed)
            throw Error('Сначала подтвердите готовность устройств');
        await this.migrateEncryption(value, passphrase);
        m.close();
        this.plugin.app.setting.activeTab?.display();
    }
    catch (e: any) {
        new Notice(e.message);
    }
    finally {
        b.setDisabled(false);
    } })); m.open(); }
    get journal() { return this.plugin.pilotDirectory + '/encryption-migration.json'; }
    async pendingMigration() { try {
        return JSON.parse(await this.plugin.app.vault.adapter.read(this.journal));
    }
    catch {
        return null;
    } }
    async resumeMigration() { const pending = await this.pendingMigration(); if (!pending)
        throw Error('Незавершённого переноса нет'); const s = this.plugin.core.services.setting.currentSettings(); if (pending.target.encrypted && (!s.encrypt || s.couchDB_DBNAME !== pending.target.database || !s.passphrase)) {
        this.encryptionDialog(true);
        return;
    } return this.migrateEncryption(!!pending.target.encrypted, s.passphrase || ''); }
    async migrateEncryption(encrypted: boolean, passphrase: string) {
        if (await this.pendingMerge()) throw Error('Сначала завершите слияние хранилищ');
        if (this.busy)
            throw Error('Перенос уже выполняется');
        const p = this.plugin, current = JSON.parse(JSON.stringify(p.core.services.setting.currentSettings())), pending = await this.pendingMigration();
        if (!current.isConfigured)
            throw Error('Сначала подключите хранилище');
        if (pending && pending.target.encrypted !== encrypted)
            throw Error('Сначала завершите ранее начатый перенос');
        if (!pending && !!current.encrypt === encrypted)
            return;
        if (encrypted && passphrase.length < 12)
            throw Error('Парольная фраза должна содержать не менее 12 символов');
        if (!p.core.services.API.isOnline)
            throw Error('Для переноса нужен доступ к интернету');
        this.busy = true;
        try {
            const s = current, sync = pending?.sync || { liveSync: !!s.liveSync, syncOnSave: !!s.syncOnSave, syncOnStart: !!s.syncOnStart }, w = pending?.target || await this.api('create', { title: p.app.vault.getName() + (encrypted ? ' — с шифрованием' : ' — без шифрования'), encrypted }), access = await this.api('connect', { id: w.id });
            const target = { ...s, couchDB_URI: access.url.replace(/\/$/, ''), couchDB_DBNAME: access.database, couchDB_USER: access.user, couchDB_PASSWORD: access.password, encrypt: encrypted, passphrase: encrypted ? passphrase : '', liveSync: false, syncOnSave: false, syncOnStart: false };
            upsertRemoteConfigurationInPlace(target as any, 'couchdb', { id: 'arcalink-pilot', name: 'ArcaLink', activate: true });
            // Private resume journal precedes every settings mutation; source remote is never reset.
            await p.app.vault.adapter.write(this.journal, JSON.stringify({ source_database: pending?.source_database || s.couchDB_DBNAME, session: pending?.session || await this.session(), target: w, sync }));
            await p.core.services.setting.suspendAllSync();
            await p.core.services.control.applySettings();
            await p.core.services.setting.applyPartial(target, true);
            await p.core.services.control.applySettings();
            await p.folders.copyBindings();
            const r = p.core.rebuilder;
            await p.core.services.replicator.runBoundedRemoteActivity(async () => {
                await r.resetLocalDatabase();
                await r.prepareLocalDatabaseForRebuild();
                if (!await p.core.services.replication.replicateAllToRemoteForRebuild(true))
                    throw Error('Не удалось загрузить заметки. Старое хранилище и локальные файлы сохранены. Продолжите перенос через настройки.');
                if (!await r.completePreparedRebuild())
                    throw Error('Перенос не завершён. Автосинхронизация остановлена, исходное хранилище сохранено.');
            }, { label: 'pilot-encryption-migration' });
            const session = await this.session();
            await p.app.vault.adapter.write(this.sessionPath, JSON.stringify({ ...session, workspaceId: w.id, workspaceTitle: w.title }));
            await p.core.services.setting.applyPartial(sync, true);
            await p.core.services.control.applySettings();
            await p.app.vault.adapter.remove(this.journal);
            new Notice('Перенос завершён. Старое серверное хранилище сохранено. Подключите остальные устройства к «' + w.title + '».', 12000);
        }
        finally {
            this.busy = false;
        }
    }
    renderRecovery(el: HTMLElement) {
        void this.pendingMerge().then(pending => {
            if (pending && el.isConnected) new Setting(el).setName('Незавершённое слияние хранилищ').setDesc('Автосинхронизация приостановлена. Выберите «' + pending.target.title + '», подтвердите слияние и нажмите «Подключить». Прежнее серверное хранилище сохранено.');
        }).catch(e => { if (el.isConnected) new Setting(el).setName('Ошибка журнала слияния').setDesc(e.message); });
        void this.pendingMigration().then(pending => { if (!pending || !el.isConnected)
        return; new Setting(el).setName('Незавершённый перенос шифрования').setDesc('Исходное серверное хранилище и локальные заметки сохранены. Продолжите перенос перед дальнейшими изменениями подключения.').addButton(b => b.setButtonText('Продолжить перенос').setCta().onClick(async () => { b.setDisabled(true); try {
        await this.resumeMigration();
        this.plugin.app.setting.activeTab?.display();
    }
    catch (e: any) {
        new Notice(e.message);
    }
    finally {
        b.setDisabled(false);
    } })); }); }
    dispose() { this.pending = null; }
}
