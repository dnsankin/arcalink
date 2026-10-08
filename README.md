# ArcaLink Sync

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
