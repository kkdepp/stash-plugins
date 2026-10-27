# Changelog — kkdepp_lib

All notable changes to this plugin. Versions follow SemVer and match the `version` field of `kkdepp_lib.yml`
and the git tag `kkdepp_lib-vX.Y.Z`.

## 1.1.0 — 2026-10-27

### Added
- `py/stash_client.py`: a small Stash GraphQL client and logger using only Python's standard library, so the
  plugins using this library no longer need the `stashapp-tools` package.

### Changed
- README: new **Limitations** section (preview links need symbolic links; no locking on Windows).

## 1.0.1 — 2026-10-27

### Changed
- Settings > Plugins links to the plugin's page (README and changelog).
- For plugin authors: the documented way to load the Python modules is now by file path (as Task Scheduler
  1.9.0 does), not through `sys.path`.

## 1.0.0 — 2026-10-27

### Added
- First release: shared code for the kkdepp plugins, so that a fix reaches every plugin using it with one update.
  - Preview player for videos and images (from Task Scheduler 1.8.1).
  - Temporary file links for that player (from Task Scheduler 1.8.1), API version 1.
