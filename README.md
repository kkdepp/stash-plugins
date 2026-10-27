# kkdepp Stash plugins

Plugins for [Stash](https://github.com/stashapp/stash), tested on **Stash v0.31.x**.

| Plugin | What it does |
|--------|--------------|
| [Task Scheduler](plugins/task_scheduler/) | Scheduled library scans with pre / post scripts, an optional Identify step, run history and an instant file preview. |
| [kkdepp_lib](plugins/kkdepp_lib/) | Shared code used by the plugins above. Installed automatically with them. |

## Install from Stash (recommended)

1. In Stash: **Settings > Plugins > Available Plugins > Add Source**.
2. Fill in:
   - **Name:** `kkdepp`
   - **Source URL:** `https://kkdepp.github.io/stash-plugins/main/index.yml`
   - **Local Path:** `kkdepp`
3. Pick the plugins to install from the new source. Required plugins (such as `kkdepp_lib`) are installed with them.

Updates then show up under **Installed Plugins** (Check for updates).

## Manual installation

Copy a plugin folder from `plugins/` into Stash's plugins directory, together with the plugins it requires (the
`# requires:` line of its manifest), side by side in the same parent folder. Then **Settings > Plugins > Reload
plugins**.

Each plugin's README lists its requirements and settings, and its `CHANGELOG.md` what changed in each version.

## Versions

Each plugin is versioned on its own (SemVer), with a git tag `<plugin-id>-vX.Y.Z` per release. The version shown
in Stash ends with the commit it was built from (for example `1.9.1-0f043ca`).

## License

GNU General Public License v3.0 or later: see [LICENSE](LICENSE). `build_site.sh` comes from Stash's
[plugins repository template](https://github.com/stashapp/plugins-repo-template) (AGPL-3.0).
