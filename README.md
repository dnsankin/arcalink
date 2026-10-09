# ArcaLink Sync

[Русский](#русский) · [English](#english)

## Русский

ArcaLink Sync синхронизирует заметки Obsidian между устройствами через сервис ArcaLink. Плагин поддерживает личные хранилища, общие папки, совместное редактирование, шифрование личных заметок и получение сообщений и вложений из Telegram.

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

### Язык интерфейса

Переключатель находится **вверху настроек плагина**. Доступны **«Как в Obsidian»**, **«Русский»** и **«English»**. Выбор сохраняется для плагина; настройки и уведомления используют выбранный язык.

### Установка

После принятия ArcaLink Sync в каталог сообщества Obsidian:

1. Откройте **Настройки → Сторонние плагины**.
2. Нажмите **Обзор** и найдите **ArcaLink Sync**.
3. Установите и включите плагин.
4. Откройте его настройки, войдите в аккаунт и явно подключите локальное хранилище в режиме, доступном на вашем тарифе.
5. После сохранения первого подключения перезапустите Obsidian через предложенный диалог, чтобы начать синхронизацию. Можно перезапустить позже: сохранённое подключение будет использовано при следующем запуске.

Обновления устанавливает Obsidian из GitHub Releases. Плагин не скачивает и не устанавливает собственные обновления.

Старый HTTP-прототип (0.1.x) использует другой механизм синхронизации. Перед переходом сохраните резервную копию локального хранилища. После установки войдите и явно подключите хранилище: старые настройки подключения автоматически не переносятся. Внутренняя сборка `arcalink-livesync-prototype` имеет другой ID. Отключите другой плагин синхронизации всего хранилища перед подключением этого.

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

## Interface language

The language selector is at the top of the plugin settings. Choose **Same as Obsidian**, **Русский**, or **English**. The preference is saved for this plugin and settings and notifications use the selected language.

## Installation

After ArcaLink Sync is accepted into the Obsidian Community directory:

1. Open **Settings → Community plugins**.
2. Select **Browse** and search for **ArcaLink Sync**.
3. Install and enable the plugin.
4. Open its settings, sign in, and explicitly connect the local vault using the mode available on your plan.
5. After the first connection is saved, use the restart prompt to restart Obsidian and start synchronization. You can choose to restart later; the saved connection will be used on the next launch.

Updates are installed by Obsidian from GitHub Releases. The plugin does not download or install its own updates.

The old HTTP prototype (0.1.x) uses a different synchronization engine. Before upgrading, back up the local vault. Sign in and connect the vault explicitly after installation; old prototype connection settings are not automatically migrated. The internal `arcalink-livesync-prototype` build uses a separate plugin ID. Disable another whole-vault sync plugin before connecting this one.

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
