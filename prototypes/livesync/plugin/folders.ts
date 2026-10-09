import { TFile, Notice, Modal, Setting, editorInfoField } from 'obsidian';
import { Compartment, StateEffect, EditorState, Prec } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap } from '@codemirror/view';
import * as Y from 'yjs';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { IndexeddbPersistence } from 'y-indexeddb';
import { safeRelative, folderPaths, bytesToBase64, base64ToBytes, MAX_FILE_BYTES, MAX_FOLDER_BYTES, MAX_FILES } from './folder-model.mjs';
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
    queue = Promise.resolve();
    lastRefresh = 0;
    refreshAttempt = 0;
    syncFeedback = createSyncFeedback({ diagnose: async () => null, notify: (message: string) => new Notice(message, 10000) });
    constructor(plugin: any) { this.plugin = plugin; this.app = plugin.app; }
    get registry() { return this.plugin.pilotDirectory + '/shared-folders.json'; }
    contains(path: string) { return this.records.some(r => path.toLowerCase() === r.mount.toLowerCase() || path.toLowerCase().startsWith(r.mount.toLowerCase() + '/')); }
    record(path: string) { return this.records.find(r => path === r.mount || path.startsWith(r.mount + '/')); }
    async save() { this.queue = this.queue.catch(() => { }).then(() => this.app.vault.adapter.write(this.registry, JSON.stringify(this.records))); await this.queue; }
    validateMount(mount: string) { if (!safeRelative(mount) || mount === 'ArcaLink Shared' || this.records.some(r => mount.toLowerCase().startsWith(r.mount.toLowerCase() + '/') || r.mount.toLowerCase().startsWith(mount.toLowerCase() + '/') || r.mount.toLowerCase() === mount.toLowerCase()))
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
    async discover() { if (!this.plugin.core.services.setting.currentSettings().isConfigured)
        return; const result = await this.plugin.collaboration.api('folders', {}); for (const r of result.folders) {
        if (this.records.some(x => x.id === r.id))
            continue;
        this.validateMount(r.mount);
        this.records.push(r);
    } await this.save(); this.lastRefresh = Date.now(); }
    async refreshBeforeSync() { if (this.disposed) return false; if (Date.now() - this.lastRefresh < 10000 && !this.syncFeedback.messages.length)
        return true; const attempt = ++this.refreshAttempt; try {
        await this.discover();
        if (this.disposed || attempt !== this.refreshAttempt) return false;
        this.syncFeedback.clear();
        for (const r of this.records)
            void this.ensure(r).catch(e => new Notice(e.message));
        return true;
    }
    catch (e: any) {
        if (!this.disposed && attempt === this.refreshAttempt) {
            Logger('Shared-folder discovery failed before synchronisation', LOG_LEVEL_VERBOSE);
            Logger(e, LOG_LEVEL_VERBOSE);
            this.syncFeedback.report(folderSyncFailure(e));
        }
        return false;
    } }
    async copyBindings() { for (const r of this.records) {
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
        if (files.length > MAX_FILES)
            throw Error('В общей папке допускается до 100 файлов');
        const seed: {path:string;type:string;content:string}[] = [];
        let total = 0;
        for (const f of files) {
            if (!safeRelative(f.path.slice(mount.length + 1)) || f.stat.size > MAX_FILE_BYTES)
                throw Error('Проверьте имена файлов: лимит вложения — 1 МБ');
            const binary = await this.app.vault.readBinary(f);
            total += binary.byteLength;
            if (total > MAX_FOLDER_BYTES / 1.5)
                throw Error('Содержимое общей папки слишком большое: вместе со служебными данными допускается до 4 МБ');
            seed.push({ path: f.path.slice(mount.length + 1), type: f.extension === 'md' ? 'text' : 'binary', content: f.extension === 'md' ? await this.app.vault.read(f) : bytesToBase64(new Uint8Array(binary)) });
        }
        const result = await this.plugin.collaboration.api('create', { title: mount, kind: 'folder' });
        await this.plugin.collaboration.api('mount', { id: result.id, mount });
        const r = { ...result, mount };
        this.records.push(r);
        await this.save();
        const e = await this.ensure(r);
        e.doc.transact(() => { for (const item of seed) {
            const f = new Y.Map();
            f.set('path', item.path);
            f.set('type', item.type);
            if (item.type === 'text') {
                const text = new Y.Text();
                text.insert(0, item.content);
                f.set('content', text);
            }
            else
                f.set('content', item.content);
            e.files.set(uuid(), f);
        } }, 'seed');
        await this.project(e);
        new Notice('Папка опубликована. Теперь создайте приглашение для редактора или читателя.');
        return r;
    }
    mountDialog(result: any) { const m = new Modal(this.app); m.titleEl.setText('Подключить общую папку «' + result.title + '»'); let mount = 'Общие папки/' + result.title.replace(/[\\:*?"<>|/]/g, '_'); new Setting(m.contentEl).setName('Локальная папка').setDesc('Выберите новую или пустую папку. Сервер видит её содержимое.').addText(t => t.setValue(mount).onChange(v => mount = v.trim())); new Setting(m.contentEl).addButton(b => b.setButtonText('Подключить').setCta().onClick(async () => { b.setDisabled(true); try {
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
            e.provider = new HocuspocusProvider({ url: this.plugin.collaboration.socketUrl, name: r.id, document: e.doc, token: () => this.plugin.collaboration.auth(), onSynced: ({ state }: any) => { if (state) {
                    e.ready = true;
                    void this.project(e);
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
            e.files.observeDeep(() => { void this.project(e); this.refresh(); });
            e.ready = e.files.size > 0;
            if (e.ready)
                void this.project(e);
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
    storagePaused(e: any) { e.record.role = 'viewer'; void this.save(); this.refresh(); if (!(this as any).retentionNotified) { (this as any).retentionNotified = true; new Notice('Серверная копия общей папки недоступна. Локальные файлы сохранены. Подключение возобновится после оплаты Pro.'); } }
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
    async project(e: any) {
        e.projecting = e.projecting.catch(() => { }).then(async () => {
            if (this.disposed || e.denied || !e.ready)
                return;
            const next = folderPaths(e.files);
            for (const [id, relative] of e.paths) {
                if (next.has(id))
                    continue;
                const path = e.record.mount + '/' + relative, file = this.app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) {
                    const data = bytesToBase64(new Uint8Array(await this.app.vault.readBinary(file)));
                    if (e.disk.get(id) !== data) {
                        await this.app.vault.adapter.writeBinary(this.plugin.pilotDirectory + '/folder-conflict-' + id + '-' + Date.now(), base64ToBytes(data).buffer);
                    }
                    e.disk.set(path, null);
                    await this.app.vault.trash(file, true);
                }
                e.disk.delete(id);
            }
            for (const [id, relative] of next) {
                const f = e.files.get(id), path = e.record.mount + '/' + relative, old = e.paths.get(id);
                await this.parents(path);
                if (old && old !== relative) {
                    const source = this.app.vault.getAbstractFileByPath(e.record.mount + '/' + old);
                    if (source instanceof TFile && !this.app.vault.getAbstractFileByPath(path)) {
                        e.disk.set(source.path, null);
                        await this.app.fileManager.renameFile(source, path);
                    }
                }
                const content = f.get('content'), data = f.get('type') === 'text' ? new TextEncoder().encode(content.toString()) : base64ToBytes(content), encoded = bytesToBase64(data);
                let file = this.app.vault.getAbstractFileByPath(path);
                const previous = e.disk.get(id);
                if (file instanceof TFile) {
                    const current = bytesToBase64(new Uint8Array(await this.app.vault.readBinary(file)));
                    // A projection for another file must not overwrite an unprocessed local edit.
                    if (current !== encoded && current !== previous) {
                        if (encoded === previous && e.record.role !== 'viewer')
                            continue;
                        await this.app.vault.adapter.writeBinary(this.plugin.pilotDirectory + '/folder-conflict-' + id + '-' + Date.now(), base64ToBytes(current).buffer);
                        new Notice('Внешняя и удалённая правки совпали. Локальная копия сохранена в каталоге плагина.');
                    }
                    e.disk.set(path, encoded);
                    e.disk.set(id, encoded);
                    if (current !== encoded)
                        await this.app.vault.modifyBinary(file, data.buffer);
                }
                else {
                    e.disk.set(path, encoded);
                    e.disk.set(id, encoded);
                    await this.app.vault.createBinary(path, data.buffer);
                }
            }
            e.paths = next;
            this.refresh();
        });
        await e.projecting;
    }
    async changed(event: string, file: any) {
        const r = this.record(file.path);
        if (!r || !(file instanceof TFile))
            return;
        const e = await this.ensure(r);
        if (this.disposed || e.denied || !e.ready)
            return;
        await e.projecting;
        let id = [...e.paths].find(([, p]) => r.mount + '/' + p === file.path)?.[0];
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
        const data = new Uint8Array(await this.app.vault.readBinary(file)), encoded = bytesToBase64(data);
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
        if (data.length > MAX_FILE_BYTES || e.files.size >= MAX_FILES && !id)
            throw Error('Лимит общей папки: 100 файлов, до 1 МБ каждый');
        if (Y.encodeStateAsUpdate(e.doc).length + data.length > MAX_FOLDER_BYTES && !id)
            throw Error('Общая папка превысит лимит 4 МБ');
        if ([...this.views.keys()].some(v => this.filePath(v) === file.path) && id && file.extension === 'md')
            return;
        if (id) {
            const f = e.files.get(id);
            if (f.get('type') === 'text') {
                const text = f.get('content'), value = new TextDecoder().decode(data), change = textChange(text.toString(), value);
                e.doc.transact(() => { if (change.remove)
                    text.delete(change.from, change.remove); if (change.insert)
                    text.insert(change.from, change.insert); }, 'disk');
            }
            else
                f.set('content', encoded);
        }
        else {
            const relative = file.path.slice(r.mount.length + 1);
            if (!safeRelative(relative))
                throw Error('Недопустимое имя файла в общей папке');
            const f = new Y.Map();
            f.set('path', relative);
            f.set('type', file.extension === 'md' ? 'text' : 'binary');
            if (file.extension === 'md') {
                const text = new Y.Text();
                text.insert(0, new TextDecoder().decode(data));
                f.set('content', text);
            }
            else
                f.set('content', encoded);
            e.files.set(uuid(), f);
        }
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
    render(el: HTMLElement, gate:(control:HTMLElement)=>void=()=>{}) { new Setting(el).setName('Общие папки').setDesc('Приглашайте редакторов и читателей. Сервер видит содержимое только выбранной общей папки. Пилот: до 100 файлов, 1 МБ на файл, 4 МБ на папку.').addButton(b => { b.setButtonText('Поделиться папкой').onClick(() => this.plugin.collaboration.prompt('Поделиться папкой', 'Путь существующей папки (сервер будет видеть её содержимое)', async (path: string) => this.create(path))); gate(b.buttonEl); }).addButton(b => b.setButtonText('Присоединиться').onClick(() => this.plugin.collaboration.prompt('Общая папка', 'Код приглашения', async (code: string) => { const r = await this.plugin.collaboration.api('join', { code }); if (r.kind !== 'folder')
        throw Error('Это приглашение в заметку'); this.mountDialog(r); }))); for (const r of this.records) {
        const row = new Setting(el).setName(r.mount).setDesc(r.role === 'owner' ? 'Вы владелец' : r.role === 'viewer' ? 'Только чтение' : 'Редактирование разрешено');
        row.nameEl.setAttribute('data-arcalink-user-content','');
        if (r.role === 'owner')
            row.addButton(b => { b.setButtonText('Пригласить редактора').onClick(() => void this.invite(r, 'editor'));gate(b.buttonEl); }).addButton(b => { b.setButtonText('Пригласить читателя').onClick(() => void this.invite(r, 'viewer'));gate(b.buttonEl); }).addButton(b => b.setButtonText('Отозвать доступ').onClick(() => this.plugin.collaboration.prompt('Отозвать доступ ко всей папке', 'Введите ОТОЗВАТЬ', async (value: string) => { if (value !== 'ОТОЗВАТЬ')
                throw Error('Отзыв отменён'); await this.plugin.collaboration.api('revoke', { id: r.id }); new Notice('Доступ участников и приглашения отозваны. Их локальные копии остаются у них.'); })));
    } }
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
