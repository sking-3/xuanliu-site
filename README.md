# Books source

The checked-in UI follows the published `ui-motion-20261124-3` and
`reader-widgets-20261124-1` releases. `audit/ui-baseline.json` binds the recovered
source bytes and asset versions. The A-share feature page is rebased separately;
existing stock-source stop handling and account-position compatibility remain in
place. Deploy changed files without deleting existing server data or reader assets.

## Reader assets

The 16 original readers retain their inline content, navigation and scripts.
Their immutable images, datasets and original source HTML already live on the
VPS. The approximately 1.1 GB corpus is not duplicated in this repository.
`academy/source-manifest.json` records every retained asset's exact path, size,
Git blob and SHA-256 from `suoha888/Trader-Archives` commit
`5e18e9a752719264508dc00be093e75c8b7f1824`; `academy/LICENSE` retains its MIT license.
Static checks accept only these declared raw assets as separately mounted files.
All UI JavaScript, stylesheets and other local dependencies must exist locally.

For a new server, first obtain that exact upstream checkout, then restore its
assets without replacing this repository's UI:

```sh
git clone https://github.com/suoha888/Trader-Archives.git /path/to/trader-archives
git -C /path/to/trader-archives checkout 5e18e9a752719264508dc00be093e75c8b7f1824
python3 scripts/restore_academy_assets.py /path/to/trader-archives --site /path/to/books
python3 scripts/restore_academy_assets.py /path/to/trader-archives --site /path/to/books --verify-only
```

`scripts/build_trader_academy.py` preserves the original import/reproduction logic.
Run it against a staging directory when rebuilding reader markup, then compare
the resulting UI before publishing; do not run it over a live feature checkout.

## Offline UI checks

```sh
python3 audit/site-static.py
node audit/shell-unit.cjs
node audit/reader-follow-unit.cjs
node audit/home-widget-preservation-unit.cjs
```

The home-widget test keeps the original renderers and a dated, real sentiment
snapshot under `audit/fixtures/home-widget-before/`. They are test fixtures only
and are never published as new financial data.
