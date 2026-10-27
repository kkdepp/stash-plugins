# Changelog — task_scheduler

All notable changes to this plugin. Versions follow SemVer and match the `version` field of
`task_scheduler.yml` and the git tag `task_scheduler-vX.Y.Z`.

## 1.9.2 — 2026-10-27

### Changed
- Settings > Plugins links to the plugin's page (README and changelog).

## 1.9.1 — 2026-10-27

### Changed
- The plugin is listed as **Task Scheduler** in Settings > Plugins, with an English description (it was listed
  as "task_scheduler" with a French one). Tasks, history and settings are kept.

## 1.9.0 — 2026-10-27

### Changed
- The preview player and its file links now come from the new **kkdepp_lib** plugin (shared code for several
  plugins: one update fixes them all). It must be installed next to Task Scheduler; a plugin source installs it
  automatically. Without it, everything works except the preview, which says what is missing.

### Removed
- The plugin's own copies of the player and link code (`media-player.js`, `media_links.py`). Copies left in the
  plugin folder by 1.8.x are no longer used and can be deleted.

## 1.8.2 — 2026-10-27

### Fixed
- File browser: **In stash** showed "?" on every row of a folder Stash does not know (a folder not scanned yet,
  or above the library paths), and **Size in stash** failed for every selected file. Files there now show "No",
  and sub-folders holding library paths are counted. Stash also no longer logs a "folder not found" error
  for each of these checks.

## 1.8.1 — 2026-10-26

### Fixed
- Preview: no file could be played (Stash answered "not found" for every preview link) because of the way the
  plugin's media folder was declared to Stash.

## 1.8.0 — 2026-10-26

### Added
- **Instant preview** in the file browser: a ▶ button on videos (mp4, m4v, webm, mov) and images (jpg, png,
  gif, webp, avif) opens a full-screen player, whether or not Stash knows the file. Previous / Next go through
  the previewable files of the folder as listed (filters and sort applied); keys: Page Up / Page Down, arrows
  (when the video does not have the focus), Esc to close.
  - The file is played as is, without scan or conversion: nothing is added to Stash and Stash's job queue is
    not involved. A file the browser cannot decode shows a message instead.
  - How: the plugin links that one file into its own `media/` folder under a random name, served by Stash
    behind its login; the link is removed when the player closes (or, if the page was left, a few minutes
    later). Only files inside a Stash library path can be previewed; the file itself is never touched.

## 1.7.3 — 2026-10-26

### Changed
- History: the file paths are no longer listed again under the Stash errors (they are in the error
  lines). The block starts with two buttons: **Copy paths** (each file named in the errors, once) and
  **Copy logs** (the error lines with their time, one per line).

## 1.7.2 — 2026-10-26

### Fixed
- History on phones: the Details of a run were split in two narrow columns (the Stash errors and
  their file paths were squeezed to one letter per line). They now take the card's full width,
  under the "Details" label.

## 1.7.1 — 2026-10-26

### Fixed
- File browser on phones: the Date column was hidden. Each row now takes two lines (name on the first;
  date, size, in stash and size in stash below it), and every column can still be sorted.

## 1.7.0 — 2026-10-26

### Added
- History: the "Stash errors" block lists the **files named in the errors** (each once) with a
  **Copy paths** button (one path per line; also works when Stash is served over plain http).

### Changed
- History: the Timeline is shown above the Stash errors. Blocks left open stay open when the history
  reloads at the end of a run.
- New / Edit task dialog adapts to the window: in a short window the file list keeps a usable height and
  the left column scrolls, with tighter spacing; on phones the dialog fits the visible screen (the Next
  button is no longer hidden under the browser bar).
- History on phones: full screen, each run shown as a card.

### Fixed
- The file list of the New / Edit task dialog was squeezed to a single, cut-off row in short windows.

## 1.6.0 — 2026-10-26

### Added
- **Current run in the history**: while a task is queued or running, its history opens on a "Current run"
  row: phase, elapsed time, what Stash is doing, the Stash errors so far and the timeline so far. It is
  updated every 5 s while the history is open, and the history reloads itself when the run ends.
- **Run timeline**: every run now records its steps with their time (queued, scripts started and done,
  scan and Identify sent / started / finished, warnings, the end of the run), shown as a folded
  "Timeline" in the history. Each finished phase gives its duration and how many Stash errors were logged
  during it; ignored script failures, skipped Identify sources and fields Stash's Identify settings
  overwrite are tinted as warnings, a failure or a stop as an error. Up to 100 steps per run.
  Runs recorded before 1.6.0 have no timeline.

## 1.5.1 — 2026-10-26

### Fixed
- **Stash errors of a run could be missed**: Stash only keeps its last 30 log lines in memory, which a busy
  scan fills in minutes. When Stash writes a log file (Settings > System > Logging), the plugin now reads it
  from where it stood when the run started, so every error line is caught. The file's path is taken from
  Stash's own configuration when the run starts; a rotated file is followed. Without a log file the plugin
  keeps using the last 30 lines, and the history says the list may be incomplete.
- A task could follow the wrong Stash job after Stash was restarted, because Stash numbers its jobs from 1
  again. The plugin now checks the job's creation time and ends the run in error ("Stash was restarted
  during the scan / identify: its job was lost") instead.

## 1.5.0 — 2026-10-26

### Added
- **Identify step**: a task can run a Stash Identify on its selected paths after the scan and the post-scan
  scripts (order of a run: pre-scan scripts > scan > post-scan scripts > Identify). New wizard step
  "Identify": choose one or more stash-boxes and scrapers (only those Stash can use for Identify) and their
  order; "Use Stash's default sources" picks the ones saved in Stash's Identify settings. Off by default.
  - The settings applied are Stash's own saved Identify defaults, read when the Identify starts. The wizard
    warns when they overwrite existing values (and the log says so at run time).
  - Skipped when the scan or a post-scan script fails. A source no longer offered by Stash is skipped and
    noted in the history; if none is left, the task ends in error (phase "identify").
  - Scenes only: images are not identified. Stop works during the Identify too.
- **Errors logged by Stash during a run** are kept with the run: shown as "⚠ N Stash errors" on the task row
  (click for the history) and listed in the history (up to 50 per run, the rest counted). Stash's log lines
  carry no job id, so anything Stash logs as an error while the run is active is included.
- A failed Stash job (scan or Identify) now shows Stash's own error message.

### Changed
- The task row shows the Identify stage after the other stages.

## 1.4.0 — 2026-10-25

### Added
- File browser: **filter row** under the name filter, kept while browsing and reset when the New / Edit
  dialog opens:
  - **Date**: Any / Before / After / Between (both days included, in either order);
  - **Size**: Any / Less than / More than / Between, in MB, GB or TB;
  - **In stash**: All / Yes / No;
  - **Clear filters**.
  Items whose value is not known yet (folder not measured, Stash not answered yet) stay visible, and a
  partial folder size ("≥ X") hides an item only when that is enough to decide.
- File browser: **file sizes** are shown as soon as a folder opens (they come with the listing at no extra
  cost). Folder sizes are still measured on selection only.

### Changed
- Items that are in Stash are shown in grey italics across the whole row, not only the name.

## 1.3.1 — 2026-10-25

### Fixed
- File browser: **In stash** stayed at "?" in folders with very many files known to Stash below them
  (more than 50,000). Each sub-folder is now checked on its own, whatever the folder size: Stash only
  returns a count per sub-folder (about 1 s for a thousand sub-folders), and the rows on screen are
  checked first. The "?" now only means Stash could not be asked (hover for the error).

## 1.3.0 — 2026-10-25

### Added
- File browser: **In stash** column (Yes / No). An item is in Stash when at least one scene or image file
  in Stash is that file or lies under that folder. It is checked when a folder opens; rows that are in
  Stash are shown in grey italics. Folders with more than 50,000 known files below them show "?" (open a
  sub-folder or select the item instead).
- File browser: **Size in stash** column: total size and number of the scene / image files Stash knows
  under an item, as recorded at its last scan. Asked only when the item is selected (and for the paths
  already selected when editing a task).
- Both columns sort like the others. What Stash knows is asked again each time the New / Edit dialog
  opens, so a scan in between is taken into account.

### Changed
- Smaller, tighter column headers in the file browser.

## 1.2.1 — 2026-10-25

### Fixed
- The scan option "Generate image perceptual hashes" had no effect: it was never sent to Stash. Tasks with
  the option ticked now generate image phashes; it stays off by default.

## 1.2.0 — 2026-10-25

### Added
- **Run history**: every finished run is recorded (start, end, duration, result Done / Error / Stopped /
  Missed, trigger Manual / Run All / Scheduled, error or missed reason, paths and their sizes) in
  `history.json` in the plugin folder. A history button on each task row opens it in a modal, newest first.
- Plugin setting **History retention (days)** (`historyDays`, Settings > Plugins; empty or 0 = 7). Older
  entries are pruned on every scheduler pass and when the history is opened. Deleting a task deletes its
  history; an unreadable `history.json` is kept as `history.json.corrupt` before being rewritten.
- File browser: **files** are listed (after folders) and can be selected; Stash scans a single file path.
- File browser: **Name / Date / Size** column headers, click to sort (click again to reverse).
- **Size** of the selected items, measured on selection only (recursive for folders, symlinks not followed,
  one item at a time, cached for the page session). A walk stops after 30 s and the total is shown as
  "≥ X". Sizes are saved with the task and shown in the wizard (per path and total), under the paths in
  the task table and in the history.
- Clicking a selected path in the New / Edit task dialog opens its parent folder in the browser and
  highlights the item.
- Task table: more than 2 paths fold behind a "+N" chip that expands the full list (scrollable).

### Changed
- Task row layout: a wide Run / Stop / Scheduled button in its own column next to the name; the enable
  switch, History, Edit and Delete on the right, Delete set apart. Hidden buttons keep their place.
- Editing a finished task (Done, Error, Stopped, Missed) whose paths, options, schedule or scripts changed
  resets it to Pending (Run button, dates cleared); a rename, an unchanged save or the enable switch does not.
- The Missed status is shown in red.
- The browser lists folders through the plugin backend instead of Stash's `directory` query.
- Browser calls (`listdir`, `sizes`, `getmtimes`) no longer take the plugin lock, so a slow mount cannot
  delay the scheduler.

### Fixed
- Folder and breadcrumb paths containing quotes or apostrophes broke navigation in the browser.

## 1.1.0 — 2026-10-25

### Added
- **Missed runs**: a scheduled start that could not happen in its own minute (scheduler not running,
  previous run still active) is never started late; it is marked Missed with its reason. A recurring task
  keeps its schedule (next run unchanged); a missed one-time task shows no next run and no dates.
- Times are shown in the browser's time zone; daily / weekly times note the Stash time zone when it differs.

### Changed
- Dates are stored timezone-aware (ISO 8601 with offset); older values without offset are read as Stash's
  local time.
- Daylight-saving changes are handled: a time skipped in spring starts right after the jump, a time repeated
  in autumn runs once.

## 1.0.1 — 2026-10-25

### Fixed
- The task table emptied itself when a refresh call failed; it now keeps the last known list and shows an
  error bar.
- The cron line no longer copies the Stash API key into the crontab; the cron tick reads it at run time from
  Stash's `config.yml` (documented exception, see the repository CLAUDE.md).

## 1.0.0

- Initial release (changes before 1.0.1 were not recorded).
