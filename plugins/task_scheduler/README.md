# Task Scheduler

A Stash plugin to plan and run library scans: pick folders or files, choose when, and let the plugin queue the
scan, run your scripts around it, optionally identify the new scenes, and keep a history of every run.

Tested on Stash v0.31.x, on Linux (including the official Docker image). See [CHANGELOG.md](CHANGELOG.md) for
what changed in each version.

## Quick start

1. **Install** the plugin and its library (see [Installation](#installation)), then Settings > Plugins >
   **Reload plugins**.
2. **Open it**: Settings > Tools > **Open Task Scheduler** (or the link next to "Task Queue" in Settings > Tasks).
   The page lives at `/task-scheduler`.
3. **Check the scheduler status** next to the global switch: it must read **● Scheduler running**. If it says
   *stopped* or *not set up*, follow [Scheduling](#scheduling).
4. **Create a task**: **+ New Task**, then the four steps of the wizard (see [Create a task](#create-a-task)).
5. **Run it**: a manual task starts with **Run** on its row; a scheduled one starts at its time. Then open its
   **History** to see what happened.

## Installation

**From Stash (recommended).** Settings > Plugins > Available Plugins > **Add Source**, with the source URL
`https://kkdepp.github.io/stash-plugins/main/index.yml` (name and local path of your choice, e.g. `kkdepp`).
Install **Task Scheduler**: its library, **kkdepp_lib**, is installed with it.

**By hand.** Copy the `task_scheduler` and `kkdepp_lib` folders side by side into Stash's plugins directory
(same parent folder), then **Reload plugins**.

**Requirements**

- Stash v0.31.x able to run Python plugins: `python3` (standard library only, no pip package needed).
- **kkdepp_lib 1.1.0 or later** next to this plugin: it provides the Stash client and the preview. Without it,
  the plugin's page says what to install.
- For scheduled runs: something that runs the scheduler every minute, see the next section. Manual runs work
  without it.

## Scheduling

Stash has no timer for plugins. Scheduled tasks start, and the queue advances, during a **scheduler pass** that
something must run once a minute. A scheduled start that falls while no pass runs is marked **Missed** (never
started late). The status next to the global switch tells what runs the passes and when the last one ran.

Pick **one** of the two options.

### Option 1: cron inside the Stash container (official Docker image)

Nothing to configure: the plugin writes its own crontab entry (`/etc/crontabs/root`, marked `# task_scheduler`,
running `task_scheduler.py --tick` every minute) and starts BusyBox `crond`. The status reads
**● Scheduler running (cron)**.

**The catch: neither survives a restart or re-creation of the container** (the crontab is not in a volume and the
Stash image does not start `crond`). The plugin re-arms both at the first visit to any Stash page, but until
someone opens Stash, scheduled starts are missed. To re-arm at once, run this at each container start (adapt the
path to where the plugin is installed):

```sh
python3 /root/.stash/plugins/task_scheduler/task_scheduler.py --ensure-cron || true
```

It is idempotent (it only adds the entry or starts `crond` when missing) and prints what it did; `|| true` keeps a
failure from blocking Stash. Two ways to run it:

- **In the container's start command**: override the entrypoint so it runs the command, then starts Stash. With
  Docker Compose, in the Stash service:
  ```yaml
  entrypoint: sh -c "(python3 /root/.stash/plugins/task_scheduler/task_scheduler.py --ensure-cron || true) && exec /usr/bin/stash"
  ```
  `exec` makes Stash replace the shell, so it receives the container's stop signal directly and shuts down
  cleanly. Check the Stash binary's path in your image (here `/usr/bin/stash`) and keep any arguments your
  current entrypoint passes to it.
- **In the container's healthcheck** (Docker Compose), which runs periodically and so also repairs cron later.
  Append it to your existing healthcheck command rather than replacing it, for example:
  ```yaml
  healthcheck:
    test: ["CMD-SHELL", "<your existing check> && (python3 /root/.stash/plugins/task_scheduler/task_scheduler.py --ensure-cron >/dev/null 2>&1; true)"]
  ```
  Set `init: true` on the service: a healthcheck that starts processes in a container whose main process does not
  reap them leaves zombies behind.

Errors of the cron pass go to `/tmp/ts-tick.log` in the container. The cron entry copies `STASH_PORT`,
`STASH_HOST`, `STASH_SCHEME` and `STASH_CONFIG_FILE` from the environment of the process that writes it; the API
key is never written there (see [Security notes](#security-notes)).

### Option 2: external trigger (any install: bare metal, other images)

Anything that can run a command every minute can run the pass through Stash's API: host cron, a systemd timer,
Windows Task Scheduler, a home automation… It needs no `crond` and no setup after a restart. The status reads
**● Scheduler running (external trigger)**.

```sh
curl -fsS -X POST http://localhost:9999/graphql \
  -H "Content-Type: application/json" -H "ApiKey: YOUR_API_KEY" \
  -d '{"query":"mutation { runPluginOperation(plugin_id: \"task_scheduler\", args: { action: \"tick\" }) }"}'
```

- Replace the address with your Stash's, and `YOUR_API_KEY` with the key from Settings > Security (leave the
  header out if Stash has no login). The key stays in your own scheduler: keep that file readable by you only.
- Example, host crontab: `* * * * * /usr/local/bin/stash-tick.sh`, with the command above in that script.
- While an external trigger runs, the plugin leaves cron alone.

## Create a task

**+ New Task** opens a four-step wizard:

1. **Name & Paths**: name the task and pick what to scan in the file browser.
   - Folders and files, with date, size, **In stash** (does Stash already know it?) and **Size in stash**
     (what Stash recorded at its last scan). Click a column header to sort; use the filter row (date, size,
     in stash) to narrow the list.
   - Tick folders or single files. The size of each selection is measured (a very large folder shows "≥ X"
     after 30 s). Click a selected path to jump to it in the browser.
   - ▶ on a video or an image opens the [preview](#preview-a-file).
2. **Scan Options & Schedule**: Stash's own scan options (covers, previews, phashes…), and when to run:
   - **Manual**: only when you click **Run** (or **Run All Manual**);
   - **Once**: at a date and time;
   - **Daily** / **Weekly**: at a time (and days). Times are shown in your browser's time zone.
3. **Scripts** (optional): shell commands run before and after the scan, once per selected path. `{path}` is
   replaced by the quoted path; `TS_PATH`, `TS_TASK_NAME` and `TS_PHASE` are set. For each script, choose whether
   a failure stops the run or is ignored.
4. **Identify** (optional, off by default): run Stash's Identify on the task's paths after the scan, with the
   stash-boxes / scrapers you pick (or Stash's defaults). It applies **Stash's own saved Identify settings**; the
   wizard warns when they overwrite existing values. Identify has no dry-run in Stash.

A run goes: pre-scan scripts > scan > post-scan scripts > Identify. Runs wait in a queue, one at a time.

## Follow and control runs

- **Run** on a manual task's row, **Run All Manual** for every manual task (queued in list order); **Stop** on a
  queued or running task. Scheduled tasks start only at their planned time.
- The **global switch** (Enabled / Disabled) pauses every schedule; manual runs still work.
- A row shows the task's stage while it runs, its next run, and "⚠ N Stash errors" when Stash logged errors
  during the last run (click it for the history).
- **History** (per task, kept 7 days by default, see [Settings](#settings)): every run with its result
  (Done / Error / Stopped / Missed), duration, trigger, paths and sizes, a **Timeline** of each step, and the
  **errors Stash logged** during the run, with **Copy paths** / **Copy logs** buttons. A run in progress appears
  as "Current run" and updates live.

## Preview a file

▶ next to a video (mp4, m4v, webm, mov) or an image (jpg, png, gif, webp, avif) in the file browser opens a
full-screen player, whether or not Stash knows the file. Previous / Next follow the list as shown; keys:
Page Up / Page Down, arrows (when the video does not have the focus), Esc to close.

The file is played as is: nothing is scanned, added to Stash or transcoded. To play it, the plugin creates a
symbolic link to that one file in its `media/` folder under a random name, served by Stash behind its login; the
link is removed when the player closes (or about 10 minutes after the page stopped checking in). Only files
inside a Stash library path can be previewed, and the file itself is never touched. Formats the browser cannot
decode show a message instead.

## Troubleshooting

| What you see | What to do |
|---|---|
| **○ Scheduler stopped** | No pass ran recently. With option 1, the plugin is re-arming cron (hover the status for the last attempt); make it permanent with `--ensure-cron` at container start. With option 2, check your trigger. |
| **○ Scheduler not set up** | The container has no cron daemon: use [option 2](#option-2-external-trigger-any-install-bare-metal-other-images). |
| A task shows **Missed** | Its start time passed while no scheduler pass ran, or while its previous run was still active (the reason is shown with it). It runs again at its next scheduled time. |
| **In stash** shows **?** | Stash could not be asked; hover it for the error. |
| The page or ▶ says it needs **kkdepp_lib** (or a newer one) | Install or update kkdepp_lib next to this plugin (1.1.0 or later), enable it, then reload the page. |
| A script failed | Hover the script status on the task row for its output, or open the run's Timeline in the History. |
| Anything else | Stash's log (Settings > Logs; lines start with `[TaskScheduler]`), and `/tmp/ts-tick.log` in the container for cron passes. |

## Settings

| Setting | Description |
|---------|-------------|
| History retention (days) | Days of run history kept for each task (empty or 0 = 7). |

## Files written in the plugin folder

`tasks.json` (the tasks), `history.json` (run history), `global_state.json`, `script_defaults.json`, `logs/`
(script output), `.runs/` (script runner state), lock / heartbeat files, and for the preview `media/` (temporary
links) with `.media_links.json`. Keep them when updating the plugin.

## Security notes

- **Scripts run shell commands** inside the Stash container, as Stash's user. Anyone who can edit tasks in your
  Stash can run commands there: only use this plugin on an instance whose users you trust.
- The cron pass calls Stash's API from inside the container. It reads the API key from Stash's `config.yml` at
  run time and sends it to `localhost` only; the key is never written to the crontab, a file or a log.
- The external trigger uses a key you keep in your own scheduler; the plugin never stores it.

## License

GNU General Public License v3.0 or later: see the repository's [LICENSE](../../LICENSE).
