# Publishing ArcaLink Sync to the Obsidian Community directory

The Community release is intentionally separate from the internal `arcalink-livesync-prototype` release line. The initial public version is `1.0.0`; the Community plugin ID is `arcalink-sync`.

Development takes place in GitLab. GitHub is used only for release publication, which requires a separate explicit command from the project owner. An ordinary development push or deployment does not authorize updating GitHub.

## Build the Community artifact

From the product monorepo root (in the exported GitHub repository use `npm run build` instead):

```sh
ARCALINK_RELEASE_CHANNEL=community node prototypes/livesync/scripts/build-plugin.mjs
```

The Community build writes the installable directory to `prototypes/livesync/dist/arcalink-sync/`. It does not create a ZIP or require the OS `zip` utility: Obsidian installs the individual release assets.

From the product monorepo, export only the plugin, corresponding build source, pinned dependency lockfiles, and required visual assets to a **new** absolute directory. This export helper is not needed in the GitHub repository:

```sh
node prototypes/livesync/scripts/export-community.mjs /absolute/new/public-plugin
```

The exporter refuses an existing directory. It never copies the monorepo's Git history, server implementations, website pages, account fixtures, deployment credentials, or internal reports. The single SVG under `control-plane-java/` is a build asset, not the website.

In the exported public repository, use Node.js 22 and run:

```sh
npm ci
npm run build
npm run check
```

The root manifest and built files are the Community release, not the internal `arcalink-livesync-prototype` package. Preserve the public repository's existing history. Remove obsolete `src/main.js` and `sync_logic.js` from the old HTTP prototype when replacing its build; their history remains available in prior Git commits.

Before release, verify all of the following:

- `manifest.json` has ID `arcalink-sync` and version `1.0.4`.
- `versions.json` maps `1.0.4` to the tested minimum Obsidian version.
- `main.js` contains no self-update downloader, installer, update journal, or update controls.
- The release includes `main.js`, `manifest.json`, and `styles.css` as individual GitHub Release assets.
- The public repository root contains `README.md`, `LICENSE`, `manifest.json`, `versions.json`, the corresponding source, build instructions, and third-party notices.
- The public source preserves the Self-hosted LiveSync MIT notice and identifies the pinned upstream revision.
- The public README discloses the required account, network use, paid features, and handling of unencrypted/shared content.

## Repository description and languages

Use this bilingual GitHub About description, with Russian first:

> Синхронизация заметок Obsidian через ArcaLink: Free, облачные хранилища и Telegram. / Obsidian note sync through ArcaLink: Free, cloud storage, and Telegram.

The README presents Russian first and retains the English documentation. The manifest description remains English for the Obsidian catalogue. Update the GitHub About field only as part of separately authorized release publication.

## GitHub release

Create a GitHub release with tag `1.0.4` — without a `v` prefix — and attach these files individually:

- `main.js`
- `manifest.json`
- `styles.css`

Do not publish a GitHub release until its source commit, manifest version, tag, and attached files all match.

## Obsidian submission

Submit the repository through [community.obsidian.md](https://community.obsidian.md) after linking the repository owner's GitHub account. Address the automated review results before selecting **Publish**.

If Obsidian classifies ArcaLink Sync as a fork under its directory policy, obtain explicit public written approval from the Self-hosted LiveSync author before continuing the directory submission. The MIT license already permits commercial use and distribution; this approval concerns only the directory's separate fork-admission policy.
