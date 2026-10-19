# ArcaLink Sync

[Русский](#русский) · [English](#english)

## Русский

ArcaLink Sync синхронизирует заметки Obsidian между устройствами через сервис ArcaLink. Плагин поддерживает личные хранилища, общие папки, совместное редактирование, шифрование личных заметок и получение сообщений и вложений из Telegram.

### История версий

Текущая версия: **[1.0.14](https://github.com/dnsankin/arcalink/releases/tag/1.0.14)**. После обновления перезапустите Obsidian.

Версия 1.0.12 отозвана из-за ошибки запуска. Если она установлена, обновитесь до 1.0.14; настройки подключения сохраняются.

| Версия | Дата | Изменения |
| --- | --- | --- |
| [1.0.14](https://github.com/dnsankin/arcalink/releases/tag/1.0.14) | 19.10.2026 | На смартфоне над заметкой появился статус подключения и синхронизации. Нажатие открывает подробности и настройки. Для Free отдельно показано ожидание второго устройства. Поддерживаются русский и английский; механизм синхронизации не менялся. |
| [1.0.13](https://github.com/dnsankin/arcalink/releases/tag/1.0.13) | 19.10.2026 | Восстановлены запуск и доступ к настройкам у существующих хранилищ. Выбор папок представлен деревом с поиском: зелёная галочка включает обмен на устройстве, красная — облачную копию и обмен на всех устройствах. Снятие галочки исключает папку; облачное изменение требует подтверждения. Сохранённые настройки и независимые локальные исключения сохраняются. |
| [1.0.12](https://github.com/dnsankin/arcalink/releases/tag/1.0.12) | 18.10.2026 | В настройках синхронизации добавлен выбор папок: исключить только на этом устройстве или исключить на всех устройствах и удалить облачную копию. Перед удалением показан расчёт и запрашивается подтверждение; локальные файлы сохраняются. Общее правило действует на Free и платных тарифах, сохраняется при смене тарифа и может быть отменено. |
| [1.0.11](https://github.com/dnsankin/arcalink/releases/tag/1.0.11) | 16.10.2026 | На вкладке «Синхронизация» добавлены пояснения о фоновой работе Android и текущем пределе размера одного файла на устройстве. Уточнены отличие от квоты хранилища и отдельные ограничения общих папок/Telegram. Поддерживаются русский и английский; механизм синхронизации и настройки не меняются. |
| [1.0.10](https://github.com/dnsankin/arcalink/releases/tag/1.0.10) | 14.10.2026 | Исправлена ложная отмена синхронизации с сообщением «сбой модуля» при одновременных запусках. Параллельные запуски ждут общую проверку подключения; настоящие ошибки продолжают блокировать запуск. Старые ответы после смены подключения или выгрузки плагина игнорируются. |
| [1.0.9](https://github.com/dnsankin/arcalink/releases/tag/1.0.9) | 14.10.2026 | Облачные файлы, недогруженные после обрыва сети, остаются в очереди и повторно загружаются с увеличением интервала. Очередь сохраняется при перезапуске. Перед повтором проверяется актуальная ревизия; новая версия или удаление отменяют старую попытку. |
| [1.0.8](https://github.com/dnsankin/arcalink/releases/tag/1.0.8) | 14.10.2026 | Восстановлена кнопка папки обменника в строке состояния. Отсутствующая папка создаётся при открытии, включая вложенные папки. Добавлен пункт «Выйти из приложения» в меню трея. |
| [1.0.7](https://github.com/dnsankin/arcalink/releases/tag/1.0.7) | 13.10.2026 | Белый значок трея на macOS. Восстановлен пункт «Открыть папку обменника»: используется ранее сохранённый путь, добавлены понятные сообщения об открытии и отсутствии папки. |
| [1.0.6](https://github.com/dnsankin/arcalink/releases/tag/1.0.6) | 13.10.2026 | Стартовые уведомления о сбоях связи на мобильном ждут 15 секунд; восстановившиеся ошибки не показываются. Исправлено закрытие окна в трей на Windows, добавлено управление значком Dock и папкой обмена. |
| [1.0.5](https://github.com/dnsankin/arcalink/releases/tag/1.0.5) | 10.10.2026 | Исправлено восстановление авторизации после сетевых сбоев и параллельных запросов. Улучшены сообщения об ошибках входа; временные сбои сохраняют настройки подключения. |

Подробности каждого выпуска доступны по ссылке версии. В 1.0.6–1.0.8 механизм синхронизации заметок не менялся.

### Аккаунт, подключение и тарифы

Для работы нужны аккаунт ArcaLink и интернет. Плагин подключается к `https://arcalink.ru` для входа, обнаружения устройств, управления серверными хранилищами, синхронизации, проверки занятого места, совместной работы и получения сообщений из Telegram. На Free сервер помогает устройствам найти друг друга и при необходимости передаёт данные между двумя устройствами онлайн, без сохранения содержимого заметок в облачном хранилище.

| Тариф | Стоимость | Синхронизация и место |
| --- | --- | --- |
| Free | Бесплатно | Оба устройства должны быть онлайн одновременно. Серверное хранилище не предоставляется. |
| Begin | 100 ₽ за 30 дней | 300 МБ серверного хранилища. Устройства могут синхронизироваться в разное время. |
| Pro | 250 ₽ за 30 дней | 1 ГБ серверного хранилища, общие папки, одновременное редактирование и до трёх приглашённых участников. |

Для получения сообщений из Telegram нужны платный тариф и настроенный личный бот. Поддерживаются текст, фотографии и вложения голосовых сообщений; распознавание речи не выполняется. Перед оплатой проверьте действующие условия на сайте ArcaLink: они имеют приоритет.

Если оплаченный период закончился, аккаунт переходит на Free с предупреждением. Локальные файлы и настройки подключения сохраняются. Серверные хранилища сохраняются **14 дней после перехода**, затем удаляются. Продлите тариф в этот период, чтобы восстановить доступ к облачной копии. Для обмена на Free оба устройства должны быть онлайн.

Плагин не содержит клиентской аналитики и рекламы. Сервер ArcaLink обрабатывает необходимые для работы сервиса сведения об аккаунте, устройствах, подписке, хранилищах и синхронизации. Подробнее — в [пользовательском соглашении ArcaLink](https://arcalink.ru/user-agreement).

### Данные и шифрование

Для личных хранилищ доступно сквозное шифрование, если оно включено при настройке. При выключенном шифровании сервер может читать содержимое личных заметок. Совместные заметки, общие папки и сообщения, получаемые из Telegram, не защищены сквозным шифрованием личного хранилища и доступны серверу.

Сохраняйте собственные резервные копии важных заметок: **восстановление предыдущей версии заметки не предоставляется**. Не включайте одновременно другой плагин синхронизации всего хранилища.

### Исключение папок

В разделе **Синхронизация → Исключённые папки → Выбрать папки** папки показаны деревом с поиском и двумя галочками:

- **Зелёная «Локально»** — включён обмен на этом устройстве. Снимите её, чтобы исключить папку только здесь; остальные устройства продолжают обмен.
- **Красная «Облако»** — включены облачная копия и обмен на всех устройствах. Снятие требует расчёта и отдельного подтверждения: серверные копии выбранной папки удаляются, локальные файлы на устройствах сохраняются.

Без ранее сохранённых исключений обе галочки включены. Вложенные папки наследуют исключение родителя; для возврата в обмен измените правило родителя. Общее исключение временно отключает локальную галочку, сохраняя независимый локальный выбор. Недоступные галочки показаны серыми.

Общее правило применяется и к устройствам, которые были отключены: перед следующим обменом они получают актуальные исключения. Обновите плагин на всех устройствах; старые версии не смогут продолжить обмен хранилища с общими исключениями. Во время применения правил обмен может быть временно приостановлен.

Выбор можно изменить. После снятия общего исключения локальные файлы снова участвуют в синхронизации и могут занять место в облаке. Независимые локальные исключения других устройств сохраняются. Общие папки и совместные заметки управляются отдельно; пересекающуюся с ними папку выбрать для общей очистки нельзя. Общее исключение также приостанавливает импорт соответствующих файлов из Telegram, но не удаляет оригиналы Telegram.

Для некоторых существующих хранилищ перед первым общим исключением требуется проверка режима шифрования. Если сервер не может её выполнить, изменение не применяется и облачная копия не удаляется. Локальные исключения остаются доступны.

### Статус на смартфоне

Над открытой заметкой показана плашка ArcaLink: подключение, обмен, отсутствие сети, пауза или сообщение, требующее внимания. Нажмите её, чтобы открыть подробности и настройки синхронизации. На Free отдельно показано ожидание второго устройства.

Зелёное «Подключено» означает доступность соединения, а не завершение передачи всех файлов. Стрелки ↑/↓ показывают счётчики обмена за текущий сеанс; это не количество полностью синхронизированных файлов.

### Язык интерфейса

Переключатель находится **вверху настроек плагина**. Доступны **«Как в Obsidian»**, **«Русский»** и **«English»**. Выбор сохраняется для плагина; настройки и уведомления используют выбранный язык.

### Установка

После принятия ArcaLink Sync в каталог сообщества Obsidian:

1. Откройте **Настройки → Сторонние плагины**.
2. Нажмите **Обзор** и найдите **ArcaLink Sync**.
3. Установите и включите плагин.
4. Откройте его настройки, войдите в аккаунт и явно подключите локальное хранилище в режиме, доступном на вашем тарифе.
5. После сохранения первого подключения перезапустите Obsidian через предложенный диалог, чтобы начать синхронизацию. Можно перезапустить позже: сохранённое подключение будет использовано при следующем запуске.

### Сборка из исходников

Публичный репозиторий содержит только плагин и необходимые для сборки ресурсы. Сборка скачивает закреплённую версию исходников Self-hosted LiveSync, проверяет SHA-256 архива и устанавливает зависимости по сохранённым lock-файлам. Исходники сервера и сайта ArcaLink в этот репозиторий не входят.

Установите Node.js 22 и npm, затем выполните:

```sh
npm ci
npm run build
npm run check
```

Сборка создаёт `main.js`, `manifest.json` и `styles.css` в корне репозитория. Разрабатывайте и проверяйте изменения только в отдельном тестовом хранилище.

### Поддержка

Сайт: [arcalink.ru](https://arcalink.ru). Почта: [dnsankin@yandex.ru](mailto:dnsankin@yandex.ru).

### Авторские права, исходный код и лицензия

Copyright (C) 2026 ИП Санкин Денис Николаевич — изменения и собственные компоненты ArcaLink.

ArcaLink Sync использует и изменяет код [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync), Copyright (c) 2021 vorotamoroz, распространяемый по лицензии MIT. Закреплённая ревизия исходного проекта и уведомления о лицензиях зависимостей включены в исходники и материалы релиза.

Изменения ArcaLink и объединённая поставка плагина распространяются по [GNU General Public License version 3 only](./LICENSE) (`GPL-3.0-only`). Авторские права третьих лиц и уведомления об их разрешительных лицензиях сохраняют силу для соответствующих компонентов.

## English

ArcaLink Sync synchronizes Obsidian notes between devices through the ArcaLink service. It supports personal vaults, shared folders, collaborative editing, optional encryption for personal notes, and importing messages and attachments from Telegram.

## Version history

Current version: **[1.0.14](https://github.com/dnsankin/arcalink/releases/tag/1.0.14)**. Restart Obsidian after updating.

Version 1.0.12 was withdrawn because of a startup issue. If installed, update to 1.0.14; connection settings are retained.

| Version | Date | Changes |
| --- | --- | --- |
| [1.0.14](https://github.com/dnsankin/arcalink/releases/tag/1.0.14) | 2026-10-19 | Phones now show connection and sync status above the note. Tap for details and sync settings. Free separately shows when it is waiting for another device. Available in Russian and English; the sync mechanism is unchanged. |
| [1.0.13](https://github.com/dnsankin/arcalink/releases/tag/1.0.13) | 2026-10-19 | Restored startup and settings access for existing vaults. Folder selection is now a searchable tree: green enables sync on this device, red enables the cloud copy and sync on all devices. Clearing a checkbox excludes the folder; cloud changes require confirmation. Saved settings and independent local exclusions are retained. |
| [1.0.12](https://github.com/dnsankin/arcalink/releases/tag/1.0.12) | 2026-10-18 | Added folder selection in Sync settings: exclude on this device, or exclude everywhere and remove the cloud copy. Removal requires a preview and confirmation; local files are kept. Workspace-wide rules work on Free and paid plans, survive plan changes, and can be removed. |
| [1.0.11](https://github.com/dnsankin/arcalink/releases/tag/1.0.11) | 2026-10-16 | Added guidance in Sync settings about Android background operation and the current per-file size limit on this device. Clarified the difference from the storage quota and separate limits for shared folders/Telegram. Available in Russian and English; sync behavior and settings are unchanged. |
| [1.0.10](https://github.com/dnsankin/arcalink/releases/tag/1.0.10) | 2026-10-14 | Fixed a false “module failure” cancellation during simultaneous sync starts. Concurrent starts share one connection preflight; real failures still block sync. Late results after a connection change or plugin unload are ignored. |
| [1.0.9](https://github.com/dnsankin/arcalink/releases/tag/1.0.9) | 2026-10-14 | Cloud files left incomplete after a network interruption remain queued and retry with increasing delays. The queue survives restarts. Each attempt checks the current revision; a newer revision or deletion cancels the old attempt. |
| [1.0.8](https://github.com/dnsankin/arcalink/releases/tag/1.0.8) | 2026-10-14 | Restored the exchange-folder status-bar button. Missing folders, including nested folders, are created when opened. Added a Quit application tray action. |
| [1.0.7](https://github.com/dnsankin/arcalink/releases/tag/1.0.7) | 2026-10-13 | White tray icon on macOS. Restored the exchange-folder menu action, including the previously saved path and clear messages when the folder opens or does not exist. |
| [1.0.6](https://github.com/dnsankin/arcalink/releases/tag/1.0.6) | 2026-10-13 | Mobile startup connection warnings wait 15 seconds and disappear if the connection recovers. Fixed closing the window to the tray on Windows; added Dock visibility and exchange-folder controls. |
| [1.0.5](https://github.com/dnsankin/arcalink/releases/tag/1.0.5) | 2026-10-10 | Fixed authentication recovery after network failures and concurrent requests. Improved sign-in errors; temporary failures preserve connection settings. |

Follow each version link for full release notes. Versions 1.0.6–1.0.8 do not change the note synchronisation mechanism.

## Account, network, and paid features

An ArcaLink account and an internet connection are required. The plugin connects to `https://arcalink.ru` to authenticate the account, discover devices, manage server vaults, synchronize data, check storage usage, provide collaboration, and receive Telegram imports. Free uses server signalling and, when needed, a relay to transfer notes between two online devices without retaining their contents in cloud storage.

| Plan | Price | Synchronization and storage |
| --- | --- | --- |
| Free | Free | Two devices must be online together; no cloud storage. |
| Begin | 100 RUB per 30 days | 300 MB of cloud storage; devices can synchronize at different times. |
| Pro | 250 RUB per 30 days | 1 GB of cloud storage, shared folders, simultaneous editing, and up to three invited participants. |

Telegram import requires a paid plan and a configured personal bot. It accepts text, photos, and voice-message attachments; it does not transcribe speech. The current conditions shown before payment on the ArcaLink website take precedence.

When a paid plan expires, the account switches to Free with a warning. Local files and connection settings are preserved. Server vaults are retained for 14 days after the switch and then deleted; renew within that period to restore cloud access. Free transfers require both devices online.

The plugin contains no client-side analytics or advertising. Account, device, subscription, storage, and synchronization data required to provide the service is processed by the ArcaLink server. See the [ArcaLink User Agreement](https://arcalink.ru/user-agreement).

## Data and encryption

Personal vaults can use end-to-end encryption when encryption is enabled during setup. If encryption is disabled, the server can read personal note contents. Shared notes, shared folders, and Telegram imports are not covered by personal-vault end-to-end encryption and can be read by the server.

Keep your own backups of important notes: restoring a previous version of a note is not provided. Do not enable another whole-vault synchronization plugin for the same vault at the same time.

## Folder exclusions

Open **Sync → Excluded folders → Choose folders** for a searchable folder tree with two checkboxes:

- **Green “On this device”** — sync is enabled on this device. Clear it to exclude the folder here; other devices keep syncing it.
- **Red “Cloud”** — the cloud copy and sync on all devices are enabled. Clearing it requires a preview and explicit confirmation: selected server copies are removed and local files on devices are kept.

Both checkboxes start enabled unless exclusions were already saved. Children inherit their parent's exclusion; change the parent rule to include them again. A common exclusion disables the effective local checkbox while retaining the independent local preference. Unavailable checkboxes are grey.

Offline devices receive the current rules before exchanging data again. Update the plugin on every device: older versions cannot keep exchanging data for a workspace with common exclusions. Synchronization may pause briefly while rules are applied.

Rules can be changed. Removing a common exclusion lets local files sync again and consume cloud space. Independent local exclusions on other devices are kept. Shared folders and collaborative notes are managed separately; folders overlapping them cannot be selected for workspace-wide cleanup. A common exclusion also pauses import of matching Telegram files, without deleting Telegram originals.

Some existing vaults need their encryption mode verified before the first workspace-wide exclusion. If the server cannot complete that check, the change is not applied and the cloud copy is not removed. Local exclusions remain available.

## Phone sync status

A bar above the open note shows the ArcaLink connection, data exchange, offline state, pause, or an issue needing attention. Tap it for details and sync settings. Free separately indicates when it is waiting for another device.

A green “Connected” label means a connection is available; it does not confirm that every file has finished transferring. The ↑/↓ arrows show data-exchange counters for the current session, not the number of fully synchronised files.

## Interface language

The language selector is at the top of the plugin settings. Choose **Same as Obsidian**, **Русский**, or **English**. The preference is saved for this plugin and settings and notifications use the selected language.

## Installation

After ArcaLink Sync is accepted into the Obsidian Community directory:

1. Open **Settings → Community plugins**.
2. Select **Browse** and search for **ArcaLink Sync**.
3. Install and enable the plugin.
4. Open its settings, sign in, and explicitly connect the local vault using the mode available on your plan.
5. After the first connection is saved, use the restart prompt to restart Obsidian and start synchronization. You can choose to restart later; the saved connection will be used on the next launch.

## Build from source

The public repository contains only the plugin and the assets needed to build it. It downloads a pinned, SHA-256-verified Self-hosted LiveSync source archive and installs dependencies from committed lockfiles. It does not include the ArcaLink server or website.

With Node.js 22 and npm installed, run:

```sh
npm ci
npm run build
npm run check
```

The build generates `main.js`, `manifest.json`, and `styles.css` in the repository root. Develop and test only in a separate test vault.

## Support

Visit [arcalink.ru](https://arcalink.ru) or email [dnsankin@yandex.ru](mailto:dnsankin@yandex.ru).

## Copyright, upstream code, and license

Copyright (C) 2026 ИП Санкин Денис Николаевич for the ArcaLink modifications and original components.

ArcaLink Sync uses and modifies code from [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync), Copyright (c) 2021 vorotamoroz, under the MIT License. The pinned upstream revision and bundled dependency notices are included with the source and release materials.

ArcaLink modifications and the combined plugin distribution are provided under the [GNU General Public License version 3 only](./LICENSE) (`GPL-3.0-only`). Existing third-party copyrights and permissive license notices remain in force for their respective components.
