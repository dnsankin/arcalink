import { requestPilot, responseData, responseError } from './pilot-http.mjs';
import { Notice, Modal, Setting, requestUrl } from 'obsidian';
import { safeRelative } from './folder-model.mjs';
import {telegramUserLabel,telegramUserDescription} from './telegram-users.mjs';
const BASE = 'https://arcalink.ru/sync/api/telegram/';
const hash = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
export class TelegramInbox {
    plugin: any;
    busy = false;
    disposed = false;
    botConfiguration:{account:string|undefined,configured:boolean}|null=null;
    get configured(){return this.botConfiguration?.account===this.plugin.core?.services.setting.currentSettings()?.couchDB_USER&&this.botConfiguration?.configured===true;}
    constructor(plugin: any) { this.plugin = plugin; }
    async api(action: string, body: any = {}, authorization = this.plugin.collaboration.auth()) { const r = await requestPilot(requestUrl, { url: this.plugin.unifiedVault.base + '/telegram/' + action, method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body), throw: false }); if (r.status !== 200)
        throw Error(responseError(r, 'Telegram недоступен')); return action === 'content' ? r.arrayBuffer : responseData(r); }
    async parents(path: string) { const parts = path.split('/'); parts.pop(); let folder = ''; for (const part of parts) {
        folder = folder ? folder + '/' + part : part;
        if (!await this.plugin.app.vault.adapter.exists(folder))
            await this.plugin.app.vault.createFolder(folder);
    } }
    async receipts() { try {
        return JSON.parse(await this.plugin.app.vault.adapter.read(this.plugin.pilotDirectory + '/telegram-imports.json'));
    }
    catch {
        return {};
    } }
    async wasDeleted(path: string) {
        // Include tombstones: an absent disk file can be an intentional synced deletion.
        const entry = await this.plugin.core.localDatabase.getDBEntryMeta(path, undefined, true);
        return !!entry && (entry.deleted === true || entry._deleted === true);
    }
    async import() {
        if (this.busy || this.disposed || !this.plugin.core.services.setting.currentSettings().isConfigured || this.plugin.workspaces.busy)
            return 0;
        this.busy = true;
        let count = 0;
        try {
            if (await this.plugin.workspaces.pendingMerge()) return 0;
            const authorization = this.plugin.collaboration.auth(), workspace = this.plugin.core.services.setting.currentSettings().couchDB_DBNAME, received = await this.receipts();
            const connected = () => { if (this.disposed || this.plugin.workspaces.busy || this.plugin.collaboration.auth() !== authorization || this.plugin.core.services.setting.currentSettings().couchDB_DBNAME !== workspace) throw Error('Подключение изменилось. Импорт Telegram продолжится в выбранном хранилище.'); };
            let offset = 0, index: any = null;
            while (!this.disposed) {
                connected();
                const page = await this.api('files', { offset, ...(index ? { index_token: index } : {}) }, authorization);
                index = page.index_token;
                const files = page.files || [];
                for (const f of files) {
                    if (this.disposed)
                        break;
                    if (f.entry_type === 'directory' || f.is_deleted || !f.current_content_hash)
                        continue;
                    if (!safeRelative(f.path) || this.plugin.folders.contains(f.path))
                        throw Error('Папка Telegram пересекается с общей папкой или содержит недопустимый путь');
                    const digest = String(f.current_content_hash).split(':').pop()!.toLowerCase(), key = workspace + ':' + f.id + ':' + digest;
                    if (received[key])
                        continue;
                    if (await this.wasDeleted(f.path)) {
                        connected();
                        continue;
                    }
                    if (Number(f.current_size_bytes) > 10 * 1024 * 1024)
                        throw Error('Вложение Telegram превышает 10 МБ: ' + f.path);
                    const data = await this.api('content', { path: f.path, hash: f.current_content_hash }, authorization);
                    connected();
                    if (await hash(data) !== digest)
                        throw Error('Контрольная сумма Telegram не совпала');
                    let path = f.path, file = this.plugin.app.vault.getAbstractFileByPath(path);
                    if (file) {
                        if (await hash(await this.plugin.app.vault.readBinary(file)) !== digest) {
                            const dot = path.lastIndexOf('.'), slash = path.lastIndexOf('/');
                            path = dot > slash ? path.slice(0, dot) + ' (Telegram ' + digest.slice(0, 12) + ')' + path.slice(dot) : path + ' (Telegram ' + digest.slice(0, 12) + ')';
                            file = this.plugin.app.vault.getAbstractFileByPath(path);
                            if (file && await hash(await this.plugin.app.vault.readBinary(file)) !== digest)
                                throw Error('Конфликт импортируемого файла: ' + path);
                        }
                    }
                    if (!file) {
                        await this.parents(path);
                        connected();
                        if (await this.wasDeleted(f.path) || (path !== f.path && await this.wasDeleted(path))) {
                            connected();
                            continue;
                        }
                        connected();
                        await this.plugin.app.vault.createBinary(path, data);
                        count++;
                    }
                    received[key] = { path, time: Date.now() };
                    await this.plugin.app.vault.adapter.write(this.plugin.pilotDirectory + '/telegram-imports.json', JSON.stringify(received));
                }
                if (files.length < 100)
                    break;
                offset += files.length;
                if (offset > 100000)
                    throw Error('Слишком много файлов Telegram');
            }
            return count;
        }
        finally {
            this.busy = false;
        }
    }
    init() { this.plugin.registerInterval(window.setInterval(() => { if (this.disposed)
        return; void this.import().catch(() => { }); }, 30000)); }
    render(el: HTMLElement, expanded = false) {
        const account=this.plugin.core?.services.setting.currentSettings()?.couchDB_USER;
        const root = el.createDiv({cls:'arcalink-telegram-settings'});
        const section = root.createEl('details');
        section.open = expanded;
        section.createEl('summary', { text: 'Telegram-бот' });
        section.createEl('p', { text: 'Один бот отправляет одинаковые сообщения и вложения во все отмеченные серверные хранилища. Папка и разрешённый пользователь общие для бота. Подключение ещё одного получателя не отключает остальных.' });
        section.createEl('p', { text: 'Плагин забирает сообщения каждые 30 секунд, пока Obsidian открыт в подключённом хранилище. При закрытом приложении сообщения ждут на сервере. Для каждого получателя откройте хотя бы один подключённый клиент. После импорта заметки синхронизируются в выбранном режиме шифрования; сообщения боту видны серверу.' });
        section.createEl('p', { text: 'Сохранение применяет выбранных получателей к новым сообщениям бота. Прежние заметки остаются в своих хранилищах.' });
        let token = '', folder = 'Inbox/Telegram', username = '', version = '', loaded = false;
        const selected = new Set<string>();
        const state = new Setting(section).setName('Состояние бота').setDesc('Загрузка…');
        const destinations = section.createDiv({ cls: 'arcalink-telegram-destinations' });
        const targetInfo = section.createEl('p');
        new Setting(section).setName('Токен бота').setDesc('Получите у @BotFather. Оставьте пустым, чтобы сохранить текущий токен.').addText(t => { t.inputEl.type = 'password'; t.onChange(v => token = v.trim()); });
        let folderInput: any, nameInput: any;
        new Setting(section).setName('Папка входящих сообщений во всех получателях').addText(t => { folderInput = t; t.setValue(folder).onChange(v => folder = v.trim()); });
        new Setting(section).setName('Ограничение по имени пользователя Telegram').setDesc('Необязательно: имя без @ ограничивает приём одним пользователем. Для нескольких пользователей оставьте поле пустым. Каждый пользователь должен отдельно привязаться одноразовым кодом.').addText(t => { nameInput = t; t.onChange(v => username = v.trim()); });
        const run = (b: any, task: () => Promise<any>, enabled = () => loaded) => async () => { b.setDisabled(true); try {
            await task();
        } catch (e: any) { new Notice(e.message); }
        finally { b.setDisabled(!enabled()); } };
        const reload = () => { if (!root.isConnected) return; const expanded = section.open; root.remove(); this.render(el, expanded); };
        let saveButton: any, linkButton: any, importButton: any;
        new Setting(section).addButton(b => { saveButton = b; b.setButtonText('Сохранить бота и получателей').setCta().setDisabled(true).onClick(run(b, async () => {
            if (!safeRelative(folder) || this.plugin.folders.contains(folder)) throw Error('Выберите папку вне общих папок');
            await this.api('save', { folder, username, bot_token: token, replace_existing: true, workspace_ids: [...selected], routing_version: version });
            token = ''; new Notice(selected.size ? 'Бот подключён к выбранным хранилищам' : 'Получатели отключены. Сохранённые заметки остаются на месте.'); reload();
        })); }).addButton(b => { importButton = b; b.setButtonText('Забрать сообщения').setDisabled(true).onClick(run(b, async () => new Notice('Импортировано файлов: ' + await this.import()))); });
        new Setting(section).setName('Обновить список получателей').addButton(b => b.setButtonText('Обновить').onClick(reload));
        const users = root.createDiv({cls:'arcalink-telegram-users'});
        users.createEl('h3',{text:'Привязанные пользователи Telegram'});
        users.createEl('p',{text:'Для каждого пользователя создайте отдельный код и передайте ему команду /start КОД. ID — постоянный идентификатор пользователя Telegram. Отключение пользователя не удаляет заметки и не отключает остальных.'});
        const userState = users.createEl('p',{text:'Загрузка пользователей…'});
        const userList = users.createDiv();
        let userRestriction = '', canLink = false, userRefresh = 0;
        const renderUsers = (r: any) => {
            if(typeof r.bot?.configured==='boolean'&&account===this.plugin.core?.services.setting.currentSettings()?.couchDB_USER)this.botConfiguration={account,configured:r.bot.configured};
            userList.empty();
            const links = (r.links || []).filter((link: any) => link.status === 'active');
            userRestriction = r.bot.allowed_username || '';
            userState.setText(links.length ? 'Привязано пользователей: ' + links.length : 'Пользователи ещё не привязаны. Нажмите «Добавить пользователя».');
            canLink = Boolean(r.active_here); linkButton.setDisabled(!canLink);
            for (const link of links) new Setting(userList).setName(telegramUserLabel(link)).setDesc(telegramUserDescription(link,userRestriction)).addButton(b => b.setButtonText('Отключить пользователя').onClick(run(b, async () => { await this.api('revoke', { id: link.id }); new Notice('Пользователь отключён от бота'); await refreshUsers(); })));
        };
        const refreshUsers = async () => {
            const attempt = ++userRefresh;
            try { const r = await this.api('status'); if (root.isConnected && attempt === userRefresh) { if (!loaded) reload(); else renderUsers(r); } }
            catch (e: any) { if (root.isConnected && attempt === userRefresh) { userState.setText('Не удалось обновить список пользователей: ' + e.message); } }
        };
        new Setting(users).addButton(b => { linkButton = b; b.setButtonText('Добавить пользователя').setCta().setDisabled(true).onClick(run(b, async () => {
            const result = await this.api('link', { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow' }), r = result.telegram_link_request;
            const m = new Modal(this.plugin.app); m.titleEl.setText('Добавить пользователя Telegram');
            m.contentEl.createEl('p', {text:userRestriction?'Сейчас приём ограничен именем @'+userRestriction+'. Для добавления других пользователей очистите ограничение в настройках бота и сохраните их.':'Передайте команду только тому пользователю, которого хотите подключить. Код одноразовый; для следующего пользователя создайте новый.'});
            m.contentEl.createEl('p', { text: 'Отправьте вашему боту: /start ' + r.one_time_code + '. Код действует до ' + new Date(r.expires_at).toLocaleString('ru-RU') }); new Setting(m.contentEl).addButton(b => b.setButtonText('Копировать команду').onClick(() => void navigator.clipboard.writeText('/start ' + r.one_time_code))); m.onClose = () => { void refreshUsers(); }; m.open();
        },() => loaded && canLink)); }).addButton(b => b.setButtonText('Обновить список пользователей').onClick(run(b,refreshUsers,()=>true)));
        void this.api('status').then((r: any) => {
            if (!section.isConnected) return;
            const bot = r.bot; folder = bot.default_inbox_folder || folder; username = bot.allowed_username || ''; folderInput.setValue(folder); nameInput.setValue(username); version = r.routing_version;
            loaded = true; saveButton.setDisabled(false); linkButton.setDisabled(!r.active_here); importButton.setDisabled(!r.active_here);
            const spaces = r.workspaces || [];
            for (const space of spaces) if (space.selected) selected.add(space.id);
            const describe = () => targetInfo.setText(selected.size ? 'Получатели после сохранения: ' + spaces.filter((s: any) => selected.has(s.id)).map((s: any) => s.title).join(', ') : 'Не выбрано ни одного получателя. Сохранение отключит доставку во все серверные хранилища.');
            for (const space of spaces) new Setting(destinations).setName(space.title).addToggle(t => t.setValue(selected.has(space.id)).onChange(value => { if (value) selected.add(space.id); else selected.delete(space.id); describe(); })).nameEl.setAttribute('data-arcalink-user-content','');
            describe();
            const active = spaces.filter((s: any) => s.selected).map((s: any) => s.title);
            state.setDesc(bot.configured ? '@' + bot.bot_username + (active.length ? '. Получатели: ' + active.join(', ') : '. Получатели нового сервиса не подключены.') + (bot.status === 'error' ? ' Бот сообщает об ошибке. Проверьте токен и доступность Telegram.' : '') : 'Бот не настроен');
            renderUsers(r);
        }).catch((e: any) => { state.setDesc(e.message); userState.setText('Не удалось загрузить пользователей: ' + e.message); });
    }
    dispose() { this.disposed = true; }
}
