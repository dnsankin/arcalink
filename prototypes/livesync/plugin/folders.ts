import {blobDigest, uploadSharedBlob, downloadSharedBlob} from './shared-folder-blobs.mjs';
import {chooseSharedFolder} from './shared-folder-picker';
import { TFile, Notice, Modal, Setting, editorInfoField } from 'obsidian';
import { Compartment, StateEffect, EditorState, Prec } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap } from '@codemirror/view';
import * as Y from 'yjs';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { SharedFolderProvider } from './shared-folder-provider';
import { IndexeddbPersistence } from 'y-indexeddb';
import { safeRelative, folderPaths, bytesToBase64, base64ToBytes } from './folder-model.mjs';
import { textChange } from './collab-diff.mjs';
import { createSyncFeedback, folderSyncFailure } from './sync-feedback.mjs';
import { Logger, LOG_LEVEL_VERBOSE } from 'octagonal-wheels/common/logger';
const uuid = () => crypto.randomUUID().replace(/-/g, '');
export class SharedFolders {
    plugin: any;
    app: any;
    records: any[] = [];
    entries = new Map<string, any>();
    views = new Map<any, any>();
    disposed = false;
    transferCount = 0;
    queue = Promise.resolve();
    lastRefresh = 0;
    refreshAttempt = 0;
    refreshedScope: unknown[] | undefined;
    pendingRefresh: { scope: unknown[]; promise: Promise<boolean> } | undefined;
    syncFeedback = createSyncFeedback({ diagnose: async () => null, notify: (message: string) => {
        if (!this.plugin.startupSyncNotices?.defer(message)) return new Notice(message, 10000);
    } });
    constructor(plugin: any) { this.plugin = plugin; this.app = plugin.app; }
    get registry() { return this.plugin.pilotDirectory + '/shared-folders.json'; }
    contains(path: string) { return this.records.some(r => path.toLowerCase() === r.mount.toLowerCase() || path.toLowerCase().startsWith(r.mount.toLowerCase() + '/')); }
    record(path: string) { return this.records.find(r => path === r.mount || path.startsWith(r.mount + '/')); }
    async save() { this.queue = this.queue.catch(() => { }).then(() => this.app.vault.adapter.write(this.registry, JSON.stringify(this.records))); await this.queue; }
    validateMount(mount: string) { this.plugin.folderPolicies?.assertSharedMount(mount);if (!safeRelative(mount) || mount === 'ArcaLink Shared' || this.records.some(r => mount.toLowerCase().startsWith(r.mount.toLowerCase() + '/') || r.mount.toLowerCase().startsWith(mount.toLowerCase() + '/') || r.mount.toLowerCase() === mount.toLowerCase()))
        throw Error('Выберите обычную папку вне других общих папок'); }
    async init() {
        if (await this.app.vault.adapter.exists(this.registry))
            this.records = JSON.parse(await this.app.vault.adapter.read(this.registry));
        const views = this.views, attach = (view: any) => this.attach(view), filePath = (view: any) => this.filePath(view);
        try {
            await this.discover();
        }
        catch { /* Discovery is retried after authentication. */ }
        this.plugin.registerEditorExtension(ViewPlugin.fromClass(class {
            constructor(view: any) { (this as any).view = view; views.set(view, { path: null, c: new Compartment() }); window.setTimeout(() => { void attach(view); }, 0); }
            update(u: any) { if (views.get(u.view)?.path !== filePath(u.view))
                window.setTimeout(() => { void attach(u.view); }, 0); }
            destroy() { const view = (this as any).view, info = views.get(view); if (info?.added) queueMicrotask(() => { try { view.dispatch({ effects: info.c.reconfigure([]) }); } catch { /* The editor may already be destroyed. */ } }); views.delete(view); }
        }));
        for (const event of ['create', 'modify', 'delete'])
            this.plugin.registerEvent(this.app.vault.on(event, (file: any) => { void this.changed(event, file).catch(e => new Notice(e.message)); }));
        this.plugin.registerEvent(this.app.vault.on('rename', (file: any, old: string) => void this.renamed(file, old).catch(e => new Notice(e.message))));
        for (const r of this.records)
            void this.ensure(r).catch(e => new Notice(e.message));
    }
    refreshScope() {
        const s = this.plugin.core.services.setting.currentSettings();
        return [s.isConfigured, s.remoteType, s.couchDB_URI, s.couchDB_DBNAME, s.couchDB_USER,
            s.couchDB_PASSWORD, s.additionalSuffixOfDatabaseName, this.plugin.unifiedVault.base];
    }
    sameRefreshScope(scope: unknown[]) { return this.refreshScope().every((value, index) => value === scope[index]); }
    async discover(isCurrent?: () => boolean) {
        const scope = this.refreshScope();
        const current = () => !this.disposed && this.sameRefreshScope(scope) && (!isCurrent || isCurrent());
        if (!scope[0] || !current()) return;
        const result = await this.plugin.collaboration.api('folders', {});
        if (!current()) return;
        for (const id of result.removed || []) {
            if (!current()) return;
            await this.detachSharedFolder(id);
        }
        for (const r of result.folders) {
            if (this.records.some(x => x.id === r.id))
                continue;
            this.validateMount(r.mount);
            this.records.push(r);
        }
        await this.save();
        if (current()) { this.lastRefresh = Date.now(); this.refreshedScope = scope; }
    }
    async refreshBeforeSync() {
        if (this.disposed) return false;
        const scope = this.refreshScope();
        // Concurrent admission checks must share the result, not invalidate each other.
        if (this.pendingRefresh && this.sameRefreshScope(this.pendingRefresh.scope)) return this.pendingRefresh.promise;
        if (this.refreshedScope && this.sameRefreshScope(this.refreshedScope)
            && Date.now() - this.lastRefresh < 10000 && !this.syncFeedback.messages.length) return true;
        const attempt = ++this.refreshAttempt;
        const current = () => !this.disposed && attempt === this.refreshAttempt && this.sameRefreshScope(scope);
        const promise = (async () => {
            try {
                await this.discover(current);
                if (!current()) return false;
                this.syncFeedback.clear();
                for (const r of this.records)
                    void this.ensure(r).catch(e => new Notice(e.message));
                return true;
            }
            catch (e: any) {
                if (current()) {
                    Logger('Shared-folder discovery failed before synchronisation', LOG_LEVEL_VERBOSE);
                    Logger(e, LOG_LEVEL_VERBOSE);
                    this.syncFeedback.report(folderSyncFailure(e));
                }
                return false;
            }
            finally { if (attempt === this.refreshAttempt) this.pendingRefresh = undefined; }
        })();
        this.pendingRefresh = { scope, promise };
        return promise;
    }
    async copyBindings() {
        // Previously admitted discovery cannot validate a newly selected workspace.
        this.refreshAttempt++;
        this.pendingRefresh = undefined;
        this.refreshedScope = undefined;
        this.lastRefresh = 0;
        for (const r of this.records) {
        if (this.entries.get(r.id)?.denied)
            continue;
        try {
            await this.plugin.collaboration.api('mount', { id: r.id, mount: r.mount });
        }
        catch (e: any) {
            if (e.status !== 403)
                throw e;
        }
    } this.lastRefresh = 0; }
    async create(mount: string) {
        this.validateMount(mount);
        const files = this.app.vault.getFiles().filter((f: any) => f.path.startsWith(mount + '/'));
        if (!files.length)
            throw Error('Выберите существующую папку с файлами');
        for (const file of files)
            if (!safeRelative(file.path.slice(mount.length + 1)))
                throw Error('Недопустимое имя файла в общей папке');
        const result = await this.plugin.collaboration.api('create', { title: mount, kind: 'folder' });
        await this.plugin.collaboration.api('mount', { id: result.id, mount });
        const r = { ...result, mount };
        this.records.push(r);
        await this.save();
        const e = await this.ensure(r);
        // Upload and register one file at a time; do not retain an entire folder seed.
        for (const file of files) {
            const data = new Uint8Array(await this.app.vault.readBinary(file));
            const reference = file.extension === 'md' ? null : await this.upload(e, data);
            this.assertWritable(e);
            const f = new Y.Map();
            f.set('path', file.path.slice(mount.length + 1));
            f.set('type', reference ? 'blob' : 'text');
            if (reference) { f.set('content', reference.hash); f.set('size', reference.size); }
            else { const text = new Y.Text(); text.insert(0, new TextDecoder().decode(data)); f.set('content', text); }
            e.doc.transact(() => e.files.set(uuid(), f), 'seed');
        }
        await this.project(e);
        new Notice('Папка опубликована. Теперь создайте приглашение для редактора или читателя.');
        return r;
    }
    mountDialog(result: any) { const m = new Modal(this.app); m.titleEl.setText('Подключить общую папку «' + result.title + '»'); let mountInput:any; let mount = 'Общие папки/' + result.title.replace(/[\\:*?"<>|/]/g, '_'); new Setting(m.contentEl).setName('Локальная папка').setDesc('Выберите новую или пустую папку. Сервер видит её содержимое.').addText(t => {mountInput=t;t.setValue(mount).onChange(v => mount = v.trim());}).addButton(b=>b.setButtonText('Выбрать папку').onClick(()=>chooseSharedFolder(this.app,{title:'Выбрать папку',description:'Выберите пустую папку для подключения. Новую папку можно указать в поле пути.',action:'Выбрать папку',unavailable:path=>{try{this.validateMount(path);return this.app.vault.getFiles().some((f:any)=>f.path.startsWith(path+'/'))?'Папка должна быть пустой':'';}catch(e:any){return e.message;}},select:async path=>{mount=path;mountInput.setValue(path);}}))); new Setting(m.contentEl).addButton(b => b.setButtonText('Подключить').setCta().onClick(async () => { b.setDisabled(true); try {
        await this.mount(result, mount);
        m.close();
    }
    catch (e: any) {
        new Notice(e.message);
    }
    finally {
        b.setDisabled(false);
    } })); m.open(); }
    async mount(result: any, mount: string) { const previous = this.records.find(r => r.id === result.id); if (previous) {
        await this.plugin.collaboration.api('mount', { id: result.id, mount: previous.mount });
        const old = this.entries.get(result.id);
        previous.role = result.role;
        await this.save();
        if (old) {
            old.provider?.destroy();
            old.persistence?.destroy();
            for (const undo of old.undo.values())
                undo.destroy();
            old.doc.destroy();
            this.entries.delete(result.id);
        }
        await this.ensure(previous);
        this.refresh();
        return previous;
    } if (result.kind !== 'folder')
        throw Error('Это приглашение в заметку'); this.validateMount(mount); if (this.app.vault.getFiles().some((f: any) => f.path.startsWith(mount + '/')))
        throw Error('Папка должна быть пустой, чтобы сохранить ваши локальные файлы'); await this.plugin.collaboration.api('mount', { id: result.id, mount }); const r = { ...result, mount }; this.records.push(r); await this.save(); await this.plugin.initializeCloudFeatures(); await this.ensure(r); return r; }
    async ensure(r: any) {
        if (this.entries.has(r.id))
            return this.entries.get(r.id).promise;
        const e: any = { record: r, doc: new Y.Doc(), files: null, denied: false, ready: false, projecting: Promise.resolve(), disk: new Map(), paths: new Map(), undo: new Map() };
        e.files = e.doc.getMap('files');
        this.entries.set(r.id, e);
        e.promise = (async () => {
            e.persistence = new IndexeddbPersistence('arcalink-folder:' + this.plugin.core.services.setting.currentSettings().couchDB_USER + ':' + r.id, e.doc);
            await e.persistence.whenSynced;
            if (this.disposed)
                return e;
            try {
                const a = await this.plugin.collaboration.api('authorize', { id: r.id });
                if (a.kind !== 'folder')
                    throw Error('Некорректная общая папка');
                r.role = a.role;
                if (r.role !== 'viewer') await this.restoreReferences(e);
                await this.save();
            }
            catch (error: any) {
                if (error.code === 'collaboration_retention_paused') this.storagePaused(e);
                else if ([400, 401, 403, 404].includes(error.status))
                    this.deny(e);
                else
                    new Notice('Общая папка офлайн. Локальные копии сохранены.');
            }
            if (e.denied)
                return e;
            e.provider = new SharedFolderProvider({ url: this.plugin.collaboration.socketUrl, name: r.id, document: e.doc, token: () => JSON.stringify({ authorization: this.plugin.collaboration.auth(), folder_protocol: 2 }), onSynced: ({ state }: any) => { if (state) {
                    e.ready = true;
                    this.scheduleProject(e);
                    this.refresh();
                } }, onAuthenticated: ({ scope }: any) => { void this.authenticated(e, scope); }, onAuthenticationFailed: ({ reason }: any) => { if (reason === 'Service temporarily unavailable' || reason === 'Storage paused') {
                    if (reason === 'Storage paused') this.storagePaused(e);
                    e.provider.disconnect();
                    window.setTimeout(() => { if (!this.disposed && !e.denied)
                        e.provider.connect(); }, 3000);
                }
                else
                    this.deny(e); }, onClose: ({ event }: any) => { if (event?.code === 4403)
                    this.deny(e);
                else if (event?.reason === 'Storage paused') this.storagePaused(e);
                else if (event?.code === 4429) {
                    e.provider.disconnect();
                    new Notice('Общая папка превысила лимит размера или места владельца. Локальные правки сохранены.');
                } } });
            e.provider.setAwarenessField('user', { name: r.role === 'viewer' ? 'Читатель' : 'Участник', color: '#4b75c9', colorLight: '#dceaff' });
            e.files.observeDeep(() => { this.scheduleProject(e); this.refresh(); });
            e.ready = e.files.size > 0;
            if (e.ready)
                this.scheduleProject(e);
            return e;
        })();
        return e.promise;
    }
    async authenticated(e: any, scope: string) {
        const generation = e.authorization = (e.authorization || 0) + 1;
        e.record.role = scope === 'read-write' ? (e.record.role === 'viewer' ? 'editor' : e.record.role) : 'viewer';
        void this.save(); this.refresh();
        if (scope !== 'read-write') return;
        try {
            const access = await this.plugin.collaboration.api('authorize', { id: e.record.id });
            if (this.disposed || e.denied || e.authorization !== generation) return;
            e.record.role = access.role; await this.save(); this.refresh();
        } catch { /* Socket scope remains authoritative while offline. */ }
    }
    storagePaused(e: any) { e.record.role = 'viewer'; void this.save(); this.refresh(); if (!(this as any).retentionNotified) { (this as any).retentionNotified = true; new Notice('Серверная копия общей папки недоступна. Локальные файлы сохранены. Подключение возобновится после оплаты тарифа.'); } }
    deny(e: any) { e.denied = true; e.provider?.disconnect(); this.refresh(); new Notice('Доступ к общей папке закрыт. Локальные копии сохранены.'); }
    filePath(view: any) { return view.state.field(editorInfoField, false)?.file?.path || null; }
    refresh() { for (const view of this.views.keys())
        setTimeout(() => void this.attach(view, true), 0); }
    async attach(view: any, force = false) { try {
        const v = this.views.get(view), path = this.filePath(view);
        if (!v || this.disposed || (!force && v.path === path))
            return;
        const loading = v.path !== path || !v.bound;
        v.path = path;
        const attachment = v.attachment = (v.attachment || 0) + 1;
        const r = path && this.record(path);
        if (!r) {
            if (v.added)
                view.dispatch({ effects: v.c.reconfigure([]) });
            v.bound = null;
            return;
        }
        if (loading) {
            const locked = [EditorState.readOnly.of(true), Prec.highest(EditorView.editable.of(false))];
            view.dispatch({ effects: v.added ? v.c.reconfigure(locked) : StateEffect.appendConfig.of(v.c.of(locked)) });
            v.added = true; v.bound = null;
        }
        const e = await this.ensure(r);
        if (this.disposed || !this.views.has(view) || v.attachment !== attachment || this.filePath(view) !== path)
            return;
        const id = [...e.paths].find(([, p]) => r.mount + '/' + p === path)?.[0], f = id && e.files.get(id), text = f?.get('content');
        const bound = (text instanceof Y.Text ? String(e.doc.clientID) + ':' + String(text._item?.id?.client) + ':' + String(text._item?.id?.clock) : 'none') + ':' + r.role + ':' + e.ready + ':' + e.denied;
        if (v.bound === bound)
            return;
        v.bound = bound;
        let ex: any[] = [EditorState.readOnly.of(true), Prec.highest(EditorView.editable.of(false))];
        if (text instanceof Y.Text && e.ready && !e.denied) {
            if (!e.undo.has(id))
                e.undo.set(id, new Y.UndoManager(text));
            ex = [yCollab(text, e.provider.awareness, { undoManager: r.role === 'viewer' ? false : e.undo.get(id) }), Prec.highest(keymap.of(yUndoManagerKeymap)), EditorState.readOnly.of(r.role === 'viewer'), Prec.highest(EditorView.editable.of(r.role !== 'viewer'))];
        }
        // Detach before hydrating: a snapshot must never become a local CRDT edit.
        const locked = [EditorState.readOnly.of(true), Prec.highest(EditorView.editable.of(false))];
        view.dispatch({ effects: v.added ? v.c.reconfigure(locked) : StateEffect.appendConfig.of(v.c.of(locked)) });
        v.added = true;
        if (text instanceof Y.Text && e.ready && !e.denied && view.state.doc.toString() !== text.toString())
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text.toString() } });
        view.dispatch({ effects: v.c.reconfigure(ex) });
    }
    catch (error: any) {
        if (!this.disposed)
            new Notice(error.message);
    } }
    async parents(path: string) { const parts = path.split('/'); parts.pop(); let folder = ''; for (const part of parts) {
        folder = folder ? folder + '/' + part : part;
        if (!await this.app.vault.adapter.exists(folder))
            await this.app.vault.createFolder(folder);
    } }
    assertWritable(e: any) {
        if (this.disposed || e.denied || e.record.role === 'viewer')
            throw Error('Общая папка недоступна для записи. Локальные файлы сохранены.');
    }
    async restoreReferences(e: any) {
        const refs = [...e.files.values()].filter((f: any) => f.get('type') === 'blob');
        for (let start = 0; start < refs.length; start += 256) {
            const batch = refs.slice(start, start + 256);
            try {
                await this.plugin.collaboration.api('blob-check', {id:e.record.id, references:batch.map((f: any) => ({hash:f.get('content'),size:f.get('size')}))});
                continue;
            } catch (error: any) { if (error.status !== 409) throw error; }
            for (const f of batch) {
                try { await this.plugin.collaboration.api('blob-check', {id:e.record.id,references:[{hash:f.get('content'),size:f.get('size')}]}); continue; }
                catch (error: any) { if (error.status !== 409) throw error; }
                const file = this.app.vault.getAbstractFileByPath(e.record.mount + '/' + f.get('path'));
                if (!(file instanceof TFile)) continue; // The server may have removed this stale offline record.
                const data = new Uint8Array(await this.app.vault.readBinary(file)), ref = await this.upload(e, data);
                this.assertWritable(e);
                e.doc.transact(() => { f.set('content',ref.hash);f.set('size',ref.size); }, 'restore');
            }
        }
    }
    async upload(e: any, data: Uint8Array) {
        this.assertWritable(e);
        this.transferCount++;
        try { return await uploadSharedBlob((action: string, body: any) => this.plugin.collaboration.api(action, body), e.record.id, data); }
        finally { this.transferCount--; }
    }
    async download(e: any, hash: string, size: number) {
        this.transferCount++;
        try { return await downloadSharedBlob((action: string, body: any) => this.plugin.collaboration.api(action, body), e.record.id, hash, size); }
        finally { this.transferCount--; }
    }
    scheduleProject(e: any) {
        void this.project(e).catch((error: any) => {
            if (this.disposed || e.denied) return;
            Logger(error, LOG_LEVEL_VERBOSE);
            if (e.projectionError !== error.message) new Notice(error.message);
            e.projectionError = error.message;
        });
    }
    async project(e: any) {
        e.projecting = e.projecting.catch(() => { }).then(async () => {
            if (this.disposed || e.denied || !e.ready || e.rescanning) return;
            const next = folderPaths(e.files);
            // Materialize every changed file before processing removals. A failed
            // download must never turn a partial projection into local deletions.
            for (const [id, relative] of next) {
                const f = e.files.get(id), content = f.get('content'), type = f.get('type');
                const snapshot = type === 'text' ? content.toString() : content, size = f.get('size');
                const path = e.record.mount + '/' + relative, old = e.paths.get(id);
                let file = this.app.vault.getAbstractFileByPath(path);
                const previous = e.disk.get(id);
                const signature = file instanceof TFile && Number.isFinite(file.stat?.mtime) ? file.stat.mtime + ':' + file.stat.size : null;
                if (type === 'blob' && old === relative && signature && e.signatures?.get(id) === signature && e.disk.get(id) === snapshot && !e.dirtyPaths?.has(path)) continue;
                let currentData = file instanceof TFile ? new Uint8Array(await this.app.vault.readBinary(file)) : null;
                let current = currentData ? await blobDigest(currentData) : null;
                if (this.disposed || e.denied) return;
                if (type === 'blob' && current === snapshot && (old === undefined || old === relative)) {
                    e.disk.set(path, snapshot); e.disk.set(id, snapshot);
                    e.signatures ||= new Map(); if (signature) e.signatures.set(id,signature); continue;
                }
                const data = type === 'text' ? new TextEncoder().encode(snapshot) : type === 'blob'
                    ? await this.download(e, snapshot, size)
                    : base64ToBytes(snapshot);
                // Membership, path or content may change while awaiting the network.
                if (this.disposed || e.denied || e.files.get(id) !== f || f.get('path') !== relative
                    || f.get('type') !== type || (type === 'text' ? f.get('content').toString() : f.get('content')) !== snapshot || f.get('size') !== size)
                    return; // A newer observer projection is already queued; never apply this stale snapshot.
                const encoded = type === 'blob' ? snapshot : await blobDigest(data);
                await this.parents(path);
                if (old && old !== relative) {
                    const source = this.app.vault.getAbstractFileByPath(e.record.mount + '/' + old);
                    if (source instanceof TFile && !this.app.vault.getAbstractFileByPath(path)) {
                        e.disk.set(source.path, null);
                        await this.app.fileManager.renameFile(source, path);
                    }
                }
                file = this.app.vault.getAbstractFileByPath(path);
                currentData = file instanceof TFile ? new Uint8Array(await this.app.vault.readBinary(file)) : null;
                current = currentData ? await blobDigest(currentData) : null;
                if (file instanceof TFile) {
                    if (current !== encoded && current !== previous) {
                        if (encoded === previous && e.record.role !== 'viewer') continue;
                        await this.app.vault.adapter.writeBinary(this.plugin.pilotDirectory + '/folder-conflict-' + id + '-' + Date.now(), currentData!.buffer);
                        new Notice('Внешняя и удалённая правки совпали. Локальная копия сохранена в каталоге плагина.');
                    }
                    e.disk.set(path, encoded); e.disk.set(id, encoded);
                    if (current !== encoded) await this.app.vault.modifyBinary(file, data.buffer);
                } else {
                    e.disk.set(path, encoded); e.disk.set(id, encoded);
                    await this.app.vault.createBinary(path, data.buffer);
                }
                const stored = this.app.vault.getAbstractFileByPath(path);
                e.signatures ||= new Map();
                if (stored instanceof TFile && Number.isFinite(stored.stat?.mtime)) e.signatures.set(id,stored.stat.mtime + ':' + stored.stat.size);
            }
            // Abort deletions if another remote transaction arrived during projection.
            if ([...folderPaths(e.files)].some(([id, relative]) => next.get(id) !== relative) || next.size !== e.files.size)
                return; // Preserve removals for the queued projection of the new structure.
            for (const [id, relative] of e.paths) {
                if (next.has(id)) continue;
                const path = e.record.mount + '/' + relative, file = this.app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) {
                    const data = new Uint8Array(await this.app.vault.readBinary(file));
                    if (e.disk.get(id) !== await blobDigest(data))
                        await this.app.vault.adapter.writeBinary(this.plugin.pilotDirectory + '/folder-conflict-' + id + '-' + Date.now(), data.buffer);
                    if (this.disposed || e.denied || e.files.has(id)) return;
                    e.disk.set(path, null); await this.app.vault.trash(file, true);
                }
                e.disk.delete(id);
            }
            e.paths = next;
            e.projectionError = null;
            this.refresh();
        });
        await e.projecting;
    }
    async rescanMissing(r: any, progress: (done: number, total: number, added: number) => void = () => {}) {
        const e = await this.ensure(r);
        this.assertWritable(e);
        if (!e.provider?.synced) throw Error('Дождитесь подключения общей папки и повторите сверку.');
        if (e.rescanning) throw Error('Сверка этой папки уже выполняется.');
        e.rescanning = true;
        let added = 0, checked = 0;
        try {
            await e.projecting;
            if (e.changing) await e.changing;
            const files = this.app.vault.getFiles().filter((f: any) => f.path.startsWith(r.mount + '/'));
            const known = () => new Set([...folderPaths(e.files).values()]);
            let paths = known();
            for (const file of files) {
                this.assertWritable(e);
                if (!e.provider.synced) throw Error('Соединение прервано. Добавленные файлы сохранены; повторите сверку после подключения.');
                const relative = file.path.slice(r.mount.length + 1);
                if (!paths.has(relative) && this.app.vault.getAbstractFileByPath(file.path) === file) {
                    if (!safeRelative(relative)) throw Error('Недопустимое имя файла: ' + relative);
                    const stamp = file.stat?.mtime + ':' + file.stat?.size;
                    const data = new Uint8Array(await this.app.vault.readBinary(file));
                    const reference = file.extension === 'md' ? null : await this.upload(e, data);
                    this.assertWritable(e);
                    // A peer or local watcher may have added the same path while uploading.
                    if (stamp !== file.stat?.mtime + ':' + file.stat?.size) throw Error('Файл изменился во время сверки. Повторите сверку: ' + relative);
                    paths = known();
                    if (!paths.has(relative) && this.app.vault.getAbstractFileByPath(file.path) === file) {
                        const f = new Y.Map();
                        f.set('path', relative); f.set('type', reference ? 'blob' : 'text');
                        if (reference) { f.set('content', reference.hash); f.set('size', reference.size); }
                        else { const text = new Y.Text(); text.insert(0, new TextDecoder().decode(data)); f.set('content', text); }
                        e.files.set(uuid(), f); paths.add(relative); added++;
                    }
                }
                progress(++checked, files.length, added);
            }
            return {checked, added};
        } finally {
            e.rescanning = false;
            this.scheduleProject(e);
        }
    }
    async changed(event: string, file: any) {
        const r = this.record(file.path);
        if (!r || !(file instanceof TFile))
            return;
        const e = await this.ensure(r);
        if (this.disposed || e.denied || !e.ready)
            return;
        e.dirtyPaths ||= new Map(); const changedPath=file.path; e.dirtyPaths.set(changedPath,(e.dirtyPaths.get(changedPath)||0)+1);
        e.changing = (e.changing || Promise.resolve()).catch(() => {}).then(() => this.applyChange(e, event, file)).finally(() => { const remaining=e.dirtyPaths.get(changedPath)-1; if(remaining)e.dirtyPaths.set(changedPath,remaining);else e.dirtyPaths.delete(changedPath); });
        return e.changing;
    }
    async applyChange(e: any, event: string, file: any) {
        const r = e.record;
        await e.projecting;
        if (this.disposed || e.denied || !e.ready) return;
        let id = [...folderPaths(e.files)].find(([, p]) => r.mount + '/' + p === file.path)?.[0] || [...e.paths].find(([, p]) => r.mount + '/' + p === file.path)?.[0];
        if (event === 'delete') {
            if (e.disk.has(file.path) && e.disk.get(file.path) === null) {
                e.disk.delete(file.path);
                return;
            }
            if (r.role === 'viewer') {
                await this.project(e);
                return;
            }
            if (id)
                e.files.delete(id);
            return;
        }
        if (!this.app.vault.getAbstractFileByPath(file.path))
            return;
        const data = new Uint8Array(await this.app.vault.readBinary(file)), encoded = await blobDigest(data);
        if (encoded === e.disk.get(file.path))
            return;
        if (r.role === 'viewer') {
            await this.app.vault.adapter.writeBinary(this.plugin.pilotDirectory + '/folder-local-' + Date.now() + '-' + uuid(), data.buffer);
            if (!id) {
                await this.app.vault.trash(file, true);
            }
            else
                await this.project(e);
            new Notice('Эта папка доступна только для чтения. Локальная правка сохранена в каталоге плагина.');
            return;
        }
        if ([...this.views.keys()].some(v => this.filePath(v) === file.path) && id && file.extension === 'md') return;
        const existing = id && e.files.get(id), previousContent = existing?.get('content');
        const reference = file.extension === 'md' ? null : await this.upload(e, data);
        this.assertWritable(e);
        if (!this.app.vault.getAbstractFileByPath(file.path) || (id && (e.files.get(id) !== existing || existing.get('content') !== previousContent)))
            throw Error('Файл общей папки изменился во время загрузки. Локальная копия сохранена.');
        if (id) {
            const f = e.files.get(id);
            if (file.extension === 'md' && f.get('type') === 'text') {
                const text = f.get('content'), value = new TextDecoder().decode(data), change = textChange(text.toString(), value);
                e.doc.transact(() => { if (change.remove)
                    text.delete(change.from, change.remove); if (change.insert)
                    text.insert(change.from, change.insert); }, 'disk');
            }
            else if (file.extension === 'md') {
                const text = new Y.Text(); text.insert(0, new TextDecoder().decode(data));
                e.doc.transact(() => { f.set('type', 'text'); f.set('content', text); f.delete('size'); }, 'disk');
            } else
                e.doc.transact(() => { f.set('type', 'blob'); f.set('content', reference!.hash); f.set('size', reference!.size); }, 'disk');
        }
        else {
            const relative = file.path.slice(r.mount.length + 1);
            if (!safeRelative(relative))
                throw Error('Недопустимое имя файла в общей папке');
            const f = new Y.Map();
            f.set('path', relative);
            f.set('type', file.extension === 'md' ? 'text' : 'blob');
            if (file.extension === 'md') {
                const text = new Y.Text();
                text.insert(0, new TextDecoder().decode(data));
                f.set('content', text);
            }
            else { f.set('content', reference!.hash); f.set('size', reference!.size); }
            e.files.set(uuid(), f);
        }
        e.disk.set(file.path, encoded); e.disk.set(id || [...e.files].find(([, f]: any) => r.mount + '/' + f.get('path') === file.path)?.[0], encoded);
        await this.project(e);
    }
    async renamed(file: any, old: string) { const r = this.record(old); if (!r)
        return; const e = await this.ensure(r); if (e.denied)
        return; if (e.disk.has(old) && e.disk.get(old) === null) {
        e.disk.delete(old);
        return;
    } if (file.path === r.mount || old === r.mount || !file.path.startsWith(r.mount + '/') || r.role === 'viewer') {
        e.disk.set(file.path, null);
        await this.app.fileManager.renameFile(file, old);
        new Notice('Перемещение за границы общей папки недоступно. Используйте копирование.');
        return;
    } for (const [id, path] of e.paths)
        if (r.mount + '/' + path === old || (r.mount + '/' + path).startsWith(old + '/')) {
            const target = file.path + (r.mount + '/' + path).slice(old.length);
            const relative = target.slice(r.mount.length + 1);
            if (!safeRelative(relative)) {
                e.disk.set(file.path, null);
                await this.app.fileManager.renameFile(file, old);
                throw Error('Недопустимое имя');
            }
            e.files.get(id)?.set('path', relative);
        } await this.project(e); }
    async leave(id: string) {
        const record = this.records.find(r => r.id === id);
        if (record?.role === 'owner') throw Error('Владелец не может покинуть свою папку');
        await this.plugin.collaboration.api('leave', {id});
        this.refreshAttempt++;
        this.pendingRefresh = undefined;
        this.refreshedScope = undefined;
        this.lastRefresh = 0;
        await this.detachSharedFolder(id);
        new Notice('Вы отказались от общего доступа. Локальные файлы сохранены.');
    }
    async detachSharedFolder(id: string) {
        const entry = this.entries.get(id);
        if (entry) {
            entry.denied = true;
            entry.provider?.disconnect();
            entry.provider?.destroy();
            entry.persistence?.destroy();
            for (const undo of entry.undo.values()) undo.destroy();
            entry.doc.destroy();
            this.entries.delete(id);
        }
        this.records = this.records.filter(r => r.id !== id);
        await this.save();
        this.refresh();
    }
    async stopSharing(id: string) {
        await this.plugin.collaboration.api('stop-sharing', {id});
        this.refreshAttempt++;
        this.pendingRefresh = undefined;
        this.refreshedScope = undefined;
        this.lastRefresh = 0;
        await this.detachSharedFolder(id);
        new Notice('Общий доступ прекращён. Папка и её файлы остаются в синхронизации хранилища.');
    }
    confirmAccessChange(title: string, folder: string, detail: string, task: () => Promise<void>, participant?: string) {
        const modal = new Modal(this.app);
        modal.modalEl.addClass('arcalink-access-confirmation');
        modal.titleEl.setText(title);
        modal.contentEl.createEl('p', {text:folder,attr:{'data-arcalink-user-content':''}});
        if (participant) modal.contentEl.createEl('p', {text:participant,attr:{'data-arcalink-user-content':''}});
        modal.contentEl.createEl('p', {text:detail});
        const error = modal.contentEl.createEl('p', {attr:{role:'alert'}});
        new Setting(modal.contentEl)
            .addButton(b => b.setButtonText('Отмена').onClick(() => modal.close()))
            .addButton(b => b.setButtonText('Подтверждаю').setCta().onClick(async () => {
                b.setDisabled(true);
                error.setText('');
                try { await task(); modal.close(); }
                catch (e:any) { error.setText(e.message || 'Не удалось изменить доступ. Повторите попытку.'); }
                finally { b.setDisabled(false); }
            }));
        modal.open();
    }
    render(el: HTMLElement, gate:(control:HTMLElement)=>void=()=>{}) {
        new Setting(el).setName('Общие папки').setDesc('Приглашайте редакторов и читателей. Сервер видит содержимое только выбранной общей папки. Размер ограничен свободным местом в хранилище владельца.')
            .addButton(b => { b.setButtonText('Поделиться папкой').onClick(() => chooseSharedFolder(this.app,{title:'Поделиться папкой',description:'Выберите папку для совместной работы. Сервер и приглашённые участники получат доступ к её содержимому.',action:'Поделиться папкой',unavailable:path=>{try{this.validateMount(path);return this.app.vault.getFiles().some((f:any)=>f.path.startsWith(path+'/'))?'':'Папка пуста';}catch(e:any){return e.message;}},select:async path=>{await this.create(path);await load();}})); gate(b.buttonEl); })
            .addButton(b => b.setButtonText('Присоединиться').onClick(() => this.plugin.collaboration.prompt('Общая папка', 'Код приглашения', async (code: string) => {
                const r = await this.plugin.collaboration.api('join', { code });
                if (r.kind !== 'folder') throw Error('Это приглашение в заметку');
                this.mountDialog(r);
            })));
        const actions = new Setting(el).setName('Папки с общим доступом');
        const list = el.createDiv({cls:'arcalink-folder-access'});
        let loading = false;
        const load = async () => {
            if (loading) return;
            loading = true;
            refresh.setDisabled(true);
            list.empty();
            list.createEl('p', {text:'Загрузка общих папок…'});
            const scope = this.refreshScope();
            try {
                const result = await this.plugin.collaboration.api('folder-access', {});
                if (this.disposed || !this.sameRefreshScope(scope)) { list.empty(); return; }
                list.empty();
                if (!Array.isArray(result.folders)) throw Error('Invalid folder access response');
                if (!result.folders.length) list.createEl('p', {text:'В этом хранилище нет подключённых общих папок.'});
                new Setting(list).setName('Общих папок: ' + result.folders.length);
                for (const id of result.removed || []) {
            if (!current()) return;
            await this.detachSharedFolder(id);
        }
        for (const r of result.folders) {
                    const roleLabel = (role: string) => role === 'owner' ? 'Владелец' : role === 'editor' ? 'Редактор' : 'Только чтение';
                    const card = list.createDiv({cls:'arcalink-folder-access-card'});
                    const row = new Setting(card).setName('Папка').setDesc(roleLabel(r.role));
                    row.settingEl.addClass('arcalink-folder-access-header');
                    row.nameEl.createSpan({text:': '+r.mount,attr:{'data-arcalink-user-content':''}});
                    const folderOwner = r.owner || (r.members || []).find((member:any) => member.role === 'owner');
                    const ownerLine = card.createDiv();
                    ownerLine.createSpan({text:'Владелец папки: '});
                    ownerLine.createSpan({text:folderOwner?.email || folderOwner?.account_id || 'Не удалось определить',attr:{'data-arcalink-user-content':''}});
                    const members = card.createDiv({cls:'arcalink-folder-access-members'});
                    members.createEl('h4',{text:'Участники и права'});
                    for (const member of r.members || []) {
                        if (r.role === 'owner' && member.role !== 'owner') {
                            const participant = new Setting(members).setName(member.email || member.account_id).setDesc(roleLabel(member.role));
                            participant.nameEl.setAttribute('data-arcalink-user-content','');
                            participant.addButton(b => b.setButtonText(member.role === 'editor' ? 'Сделать читателем' : 'Сделать редактором').onClick(async () => {
                                b.setDisabled(true);
                                try { await this.plugin.collaboration.api('member-access', {id:r.id,account_id:member.account_id,role:member.role === 'editor' ? 'viewer' : 'editor'}); await load(); }
                                catch (e:any) { new Notice(e.message); } finally { b.setDisabled(false); }
                            })).addButton(b => b.setButtonText('Отозвать доступ участника').onClick(() => this.confirmAccessChange('Отозвать доступ участника', r.mount, 'Участник потеряет доступ к общей папке. Его локальные файлы сохранятся.', async () => {
                                await this.plugin.collaboration.api('member-access', {id:r.id,account_id:member.account_id,role:'remove'});
                                new Notice('Доступ участника отозван. Его локальные файлы сохраняются.');
                                await load();
                            }, member.email || member.account_id)));
                        } else {
                            const line = members.createDiv();
                            line.createSpan({text:member.email || member.account_id,attr:{'data-arcalink-user-content':''}});
                            line.createSpan({text:' · ' + roleLabel(member.role)});
                        }

                    }
                    if (r.role === 'owner') {
                        const invitations = members.createDiv();
                        invitations.createEl('p', {text:'Активные приглашения'});
                        if (!(r.invitations || []).length) invitations.createEl('p', {text:'Нет активных приглашений.'});
                        for (const invitation of r.invitations || []) {
                            new Setting(invitations).setName(roleLabel(invitation.role)).setDesc('Новый код заменит прежний код этой роли. Участники сохранят свой доступ.')
                                .addButton(b => b.setButtonText('Отозвать приглашение').onClick(async () => {
                                    b.setDisabled(true);
                                    try { await this.plugin.collaboration.api('revoke-invitation', {id:r.id,invitation_id:invitation.id}); await load(); }
                                    catch (e:any) { new Notice(e.message); } finally { b.setDisabled(false); }
                                }));
                        }
                    }
                    if (r.role !== 'owner') members.createEl('p', {text:'Показаны ваши права. Список участников доступен владельцу папки.'});
                    if (r.role !== 'viewer') row.addButton(b => b.setButtonText('Досинхронизировать файлы').onClick(() => {
                        const modal = new Modal(this.app);
                        modal.titleEl.setText('Досинхронизировать общую папку');
                        modal.contentEl.createEl('p', {text:'Папка: ' + r.mount});
                        modal.contentEl.createEl('p', {text:'Недостающие файлы с этого устройства будут добавлены в общую папку. Уже общие файлы не перезаписываются и не удаляются. Запускайте на устройстве с полной копией.'});
                        const status = modal.contentEl.createEl('p');
                        new Setting(modal.contentEl).addButton(start => start.setButtonText('Начать сверку').setCta().onClick(async () => {
                            start.setDisabled(true);
                            status.setText('Проверка подключения и подготовка сверки…');
                            try {
                                const result = await this.rescanMissing(r, (done, total, added) => status.setText('Проверено: ' + done + ' / ' + total + '. Добавлено: ' + added));
                                const e = this.entries.get(r.id);
                                status.setText('Сверка завершена. Проверено: ' + result.checked + '. Добавлено: ' + result.added + (e?.provider?.hasUnsyncedChanges ? '. Изменения ещё отправляются на сервер. Не закрывайте Obsidian.' : '. Изменения переданы на сервер.'));
                            } catch (error: any) { status.setText(error.message); }
                            finally { start.setDisabled(false); }
                        }));
                        modal.open();
                    }));
                    if (r.role !== 'owner') row.addButton(b => b.setButtonText('Отказаться от общего доступа').onClick(() => this.confirmAccessChange('Отказаться от общего доступа', r.mount, 'Доступ будет прекращён на всех ваших устройствах. Локальные файлы сохранятся.', async () => {
                        await this.leave(r.id);
                        await load();
                    })));
                    if (r.role === 'owner') row
                        .addButton(b => { b.setButtonText('Пригласить редактора').onClick(async () => { await this.invite(r, 'editor'); await load(); }); gate(b.buttonEl); })
                        .addButton(b => { b.setButtonText('Пригласить читателя').onClick(async () => { await this.invite(r, 'viewer'); await load(); }); gate(b.buttonEl); })
                        .addButton(b => b.setButtonText('Прекратить общий доступ').onClick(() => this.confirmAccessChange('Прекратить общий доступ', r.mount, 'Доступ всех участников будет отозван. Папка останется в синхронизации хранилища.', async () => {
                            await this.stopSharing(r.id);
                            await load();
                        })));
                }
            } catch {
                list.empty();
                list.createEl('p', {text:'Не удалось загрузить доступ к папкам. Проверьте вход в аккаунт и повторите запрос.'});
            } finally { loading = false; refresh.setDisabled(false); }
        };
        let refresh: any;
        actions.addButton(b => { refresh = b; b.setButtonText('Обновить список').onClick(() => void load()); });
        void load();
    }
    async invite(r: any, role: string) { try {
        const code = await this.plugin.collaboration.invite(r.id, role);
        const m = new Modal(this.app);
        m.titleEl.setText(role === 'viewer' ? 'Приглашение читателя' : 'Приглашение редактора');
        m.contentEl.createEl('p', { text: 'Передайте этот код пользователю ArcaLink. Приглашение даёт доступ ко всей выбранной папке.' });
        new Setting(m.contentEl).addText(t => t.setValue(code)).addButton(b => b.setButtonText('Копировать').onClick(() => void navigator.clipboard.writeText(code)));
        m.open();
    }
    catch (e: any) {
        new Notice(e.message);
    } }
    dispose() { this.disposed = true; this.syncFeedback.clear(); for (const [view, info] of this.views) if (info.added) try { view.dispatch({ effects: info.c.reconfigure([]) }); } catch { /* An editor being destroyed needs no binding. */ } for (const e of this.entries.values()) {
        e.provider?.destroy();
        e.persistence?.destroy();
        for (const undo of e.undo.values())
            undo.destroy();
        e.doc.destroy();
    } this.views.clear(); }
}
