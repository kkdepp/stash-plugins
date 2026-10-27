# Task Scheduler

A Stash plugin to plan and run library scans: pick folders or files, choose when, and let the plugin queue the
scan, run your scripts around it and keep a history of every run.

Tested on Stash v0.31.x. See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## Features

- **Tasks**: a name, one or more folders or files, Stash's scan options, and a schedule: manual, once, daily or
  weekly. A scheduled start that cannot happen in its own minute is marked **Missed**, never started late.
- **File browser** in the New / Edit dialog: folders and files with date, size, whether Stash already knows them
  ("In stash", "Size in stash"), filters (date, size, in stash) and sorting.
- **Pre / post scan scripts**: shell command lines run once per selected path before and after the scan
  (`{path}` is replaced by the quoted path; `TS_PATH`, `TS_TASK_NAME` and `TS_PHASE` are set). Each script can
  stop the run on failure or be ignored.
- **Identify step** (optional, off by default): runs Stash's Identify on the task's paths after the scan, with
  the stash-boxes / scrapers you pick. It applies **Stash's own saved Identify settings**; the wizard warns
  when those overwrite existing values. Identify has no dry-run in Stash.
- **Run history** (per task, kept 7 days by default): result, duration, trigger, paths and sizes, a timeline of
  every step, and the errors Stash logged during the run, with **Copy paths** / **Copy logs** buttons.
  A run in progress is shown live.
- **Instant preview**: a ▶ button on videos (mp4, m4v, webm, mov) and images (jpg, png, gif, webp, avif) in the
  file browser opens a full-screen player, whether or not Stash knows the file. Nothing is scanned or
  transcoded; see "Preview" below.

## Where to find it

Settings > Tools > **Open Task Scheduler**, or the link next to the "Task Queue" heading in Settings > Tasks.
The page lives at `/task-scheduler`.

## Requirements

- The **kkdepp_lib** plugin (shared code: preview player and file links), installed next to this one. A plugin
  source installs it automatically; without it everything works except the preview.
- Stash v0.31.x running Python plugins: `python3` and the `stashapp-tools` package (`stashapi`) in the
  Stash container.
- For scheduled runs: a `crond` in the container (BusyBox `crond` in the official Alpine image). The plugin
  writes its own crontab entry (`/etc/crontabs/root`, marked `# task_scheduler`) and starts `crond` if needed,
  and repairs both when the page sees no recent scheduler pass. Manual runs work without cron.

## Installation

Copy this folder and the `kkdepp_lib` folder side by side into Stash's plugins directory (same parent folder),
then Settings > Plugins > **Reload plugins**.

## Settings

| Setting | Description |
|---------|-------------|
| History retention (days) | Days of run history kept for each task (empty or 0 = 7). |

## Files written in the plugin folder

`tasks.json` (the tasks), `history.json` (run history), `global_state.json`, `script_defaults.json`, `logs/`
(script output), `.runs/` (script runner state), lock / heartbeat files, and for the preview `media/` (temporary
links) with `.media_links.json`. Keep them when updating the plugin.

## Preview

To play a file, the plugin creates a symbolic link to that one file in its `media/` folder under a random name.
Stash serves it behind its own login (plugin assets route), with seeking. The link is removed when the player
closes, or about 10 minutes after the page stopped checking in. Only regular files under a Stash library path
can be linked, never folders, and removing a link never touches the file itself. Formats the browser cannot
decode show a message: there is no transcoding fallback.

## Security notes

- **Scripts run shell commands** inside the Stash container, as Stash's user. Anyone who can edit tasks in your
  Stash can run commands there: only use this plugin on an instance whose users you trust.
- The cron pass calls Stash's API from inside the container. It reads the API key from Stash's `config.yml` at
  run time and sends it to `localhost` only; the key is never written to the crontab, a file or a log.

## License

GNU General Public License v3.0 or later: see the repository's [LICENSE](../../LICENSE).
