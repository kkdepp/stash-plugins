#!/usr/bin/env python3
"""
Task Scheduler — backend Python
Stash plugin: scheduled library scans (version: see task_scheduler.yml)
"""

import sys
import os
import json
import re
import shlex
import shutil
import time
import threading
import subprocess
import signal
import stat as statmod
try:
    import fcntl
except ImportError:      # not available outside Linux/macOS (tests only)
    fcntl = None
import datetime

# ── Stash plugin bootstrap ──────────────────────────────────────────────────
PLUGIN_DIR = os.path.dirname(os.path.realpath(__file__))
TASKS_FILE = os.path.join(PLUGIN_DIR, "tasks.json")

try:
    import stashapi.log as log
    from stashapi.stashapp import StashInterface
except ImportError:
    # Stub for tests outside Stash
    class _Log:
        def info(self, m):  print("[INFO]", m, file=sys.stderr)
        def warning(self, m): print("[WARNING]", m, file=sys.stderr)
        def error(self, m): print("[ERROR]", m, file=sys.stderr)
        def debug(self, m): print("[DEBUG]", m, file=sys.stderr)
    log = _Log()
    class StashInterface:
        def __init__(self, ctx): pass
        def run_plugin_task(self, *a, **kw): pass
        def metadata_scan(self, paths, flags): return None

# ── Persistance ─────────────────────────────────────────────────────────────

_lock = threading.Lock()

def _atomic_write_json(path, data):
    """Write to a temp file then rename, so a reader never sees a half-written file."""
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)

def load_tasks():
    with _lock:
        if not os.path.exists(TASKS_FILE):
            return []
        try:
            with open(TASKS_FILE, "r") as f:
                return json.load(f)
        except Exception as e:
            # Unreadable file: keep a copy so the data is never silently lost
            log.error(f"load_tasks: {e}")
            try:
                shutil.copyfile(TASKS_FILE, TASKS_FILE + ".corrupt")
            except Exception:
                pass
            return []

def save_tasks(tasks):
    with _lock:
        try:
            _atomic_write_json(TASKS_FILE, tasks)
        except Exception as e:
            log.error(f"save_tasks: {e}")

def next_task_name(tasks):
    """Retourne 'Task XX' avec XX = max existant + 1 (minimum 01)."""
    nums = []
    for t in tasks:
        name = t.get("name", "")
        if name.startswith("Task "):
            try:
                nums.append(int(name[5:]))
            except ValueError:
                pass
    n = max(nums) + 1 if nums else 1
    return f"Task {n:02d}"

# ── Scheduler loop ───────────────────────────────────────────────────────────

_scheduler_thread = None

# Times are the Stash container's local time (its /etc/localtime), always stored
# timezone-aware ("2026-10-25T10:29+01:00") so the browser can convert them.
# Values written before 1.1.0 have no offset: they are read as local time.

DAY_INDEX = {"Mon": 0, "Tue": 1, "Wed": 2, "Thu": 3, "Fri": 4, "Sat": 5, "Sun": 6}
MAX_CATCHUP_MINUTES = 7 * 24 * 60   # occurrences older than this are not examined
MISSED_NOT_RUNNING = "the scheduler was not running at that time"
MISSED_STILL_ACTIVE = "the previous run was still active"

def _now():
    return datetime.datetime.now().astimezone()

def _iso(dt):
    return dt.isoformat(timespec="minutes")

def _parse_dt(value):
    """Aware datetime from a stored value, or None. Naive values are local time."""
    if not value or not isinstance(value, str):
        return None
    try:
        dt = datetime.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.astimezone()

def _minute(dt):
    return dt.replace(second=0, microsecond=0)

def _sched_hm(sc):
    """(hour, minute) of a daily/weekly schedule, or None."""
    m = re.match(r"^(\d{1,2}):(\d{2})$", str(sc.get("time") or ""))
    if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
        return None
    return int(m.group(1)), int(m.group(2))

def _day_matches(sc, d):
    if sc.get("type") == "daily":
        return True
    return d.weekday() in {DAY_INDEX[x] for x in sc.get("days") or [] if x in DAY_INDEX}

def recurring_occurrences(sc, after, until):
    """Planned starts of a daily/weekly schedule in (after, until], as
    [(slot, instant)]: slot = "YYYY-MM-DD HH:MM" (local wall clock), instant =
    the aware local minute it falls on. Walks real minutes, so DST is handled:
    a time skipped by the spring jump starts on the first minute after it, a
    time repeated in autumn only counts once (same slot)."""
    hm = _sched_hm(sc)
    if hm is None or sc.get("type") not in ("daily", "weekly"):
        return []
    out, seen = [], set()
    t = _minute(after).timestamp() + 60
    end = until.timestamp()
    prev = datetime.datetime.fromtimestamp(t - 60).astimezone()
    while t <= end:
        cur = datetime.datetime.fromtimestamp(t).astimezone()
        wall = cur.replace(tzinfo=None)
        prev_wall = prev.replace(tzinfo=None)
        planned = wall.replace(hour=hm[0], minute=hm[1])
        hit = (wall.hour, wall.minute) == hm
        if not hit and wall - prev_wall > datetime.timedelta(minutes=1):
            hit = prev_wall < planned < wall          # planned time fell in a DST gap
        if hit and _day_matches(sc, wall):
            slot = planned.strftime("%Y-%m-%d %H:%M")
            if slot not in seen:
                seen.add(slot)
                out.append((slot, cur))
        prev = cur
        t += 60
    return out

def next_run(t, now, global_on):
    """Next planned start of a task as an aware datetime, or None."""
    sc = t.get("schedule") or {}
    if not t.get("enabled", True) or not global_on:
        return None
    if sc.get("type") == "once":
        at = _parse_dt(sc.get("at"))
        if at is None or t.get("status") == "missed" or _minute(at) < _minute(now):
            return None
        return at
    occ = recurring_occurrences(sc, now, now + datetime.timedelta(days=8))
    return occ[0][1] if occ else None

def _mark_missed(t, when, reason):
    """Record a missed start. The status only changes when the task is idle: a
    task still running keeps its status and carries the missed run as a note."""
    t["missed_at"] = _iso(when)
    t["missed_reason"] = reason
    if not is_active_task(t) and not is_waiting_task(t):
        t["status"] = "missed"
        if (t.get("schedule") or {}).get("type") == "once":
            t["started"] = "—"
            t["ended"] = "—"
    log.warning(f"[TaskScheduler] '{t.get('name')}': run of {_iso(when)} missed ({reason})")
    record_history(t, "missed", started=_iso(when), ended=None, detail=reason, trigger="schedule")

# ── Run history ──────────────────────────────────────────────────────────────
#
# history.json = {"<task id>": [entry, ...]} (oldest first). One entry per finished
# run: {"started", "ended", "result": done|error|stopped|missed, "trigger":
# manual|run_all|schedule, "paths", "detail"}. Entries older than the plugin
# setting historyDays (default 7) are dropped on every scheduler pass.

HISTORY_FILE = os.path.join(PLUGIN_DIR, "history.json")
HISTORY_DAYS_DEFAULT = 7
HISTORY_MAX_PER_TASK = 500          # hard cap, in case pruning never runs

def _read_history():
    try:
        with open(HISTORY_FILE) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as e:
        # Unreadable file: keep a copy before it gets rewritten
        log.error(f"[TaskScheduler] Could not read the history: {e}")
        try:
            shutil.copyfile(HISTORY_FILE, HISTORY_FILE + ".corrupt")
        except Exception:
            pass
        return {}

def _write_history(data):
    try:
        _atomic_write_json(HISTORY_FILE, data)
    except Exception as e:
        log.error(f"[TaskScheduler] Could not save the history: {e}")

def record_history(t, result, started=None, ended=None, detail=None, trigger=None):
    """Append a finished run to the task's history (caller holds the plugin lock)."""
    entry = {
        "started": started if started is not None else t.get("started"),
        "ended":   ended if ended is not None or result == "missed" else (t.get("ended") or _now_str()),
        "result":  result,
        "trigger": trigger or t.get("trigger") or "manual",
        "paths":   list(t.get("paths") or []),
    }
    if entry["started"] in ("", "—"):
        entry["started"] = None
    sizes = _clean_sizes(t.get("sizes"), entry["paths"])
    if sizes:
        entry["sizes"] = sizes
    if detail:
        entry["detail"] = detail
    if result != "missed":              # a run missed while another one is active is not that run
        errs = t.pop("stash_errors", None) or []
        dropped = t.pop("stash_errors_dropped", 0)
        partial = t.pop("log_partial", False)
        for k in ("log_cursor", "log_file", "log_pos", "log_ino"):
            t.pop(k, None)
        if errs:
            entry["stash_errors"] = errs
        if partial:
            entry["stash_errors_partial"] = True      # read from Stash's last 30 lines only
        if dropped:
            entry["stash_errors_dropped"] = dropped
        if errs or dropped:
            t["last_stash_errors"] = len(errs) + dropped
        else:
            t.pop("last_stash_errors", None)
        events = t.pop("events", None)
        if events:
            entry["events"] = events
        if t.get("events_dropped"):
            entry["events_dropped"] = t["events_dropped"]
        for k in EVENT_KEYS:
            t.pop(k, None)
    data = _read_history()
    runs = data.setdefault(str(t.get("id")), [])
    runs.append(entry)
    del runs[:-HISTORY_MAX_PER_TASK]
    _write_history(data)

def history_days(stash):
    """Retention from the plugin setting historyDays (Settings > Plugins); default 7.
    0 also means the default: an unset NUMBER setting may come back as 0."""
    if stash is not None:
        try:
            q = stash.call_GQL('query { configuration { plugins(include: ["task_scheduler"]) } }')
            v = (((q or {}).get("configuration") or {}).get("plugins") or {}).get("task_scheduler", {}).get("historyDays")
            if isinstance(v, (int, float)) and v >= 1:
                return int(v)
        except Exception as e:
            log.debug(f"[TaskScheduler] historyDays not readable, using {HISTORY_DAYS_DEFAULT}: {e}")
    return HISTORY_DAYS_DEFAULT

def prune_history(days, now):
    """Drop entries older than `days`. Returns the data. (A deleted task's history is
    removed by the delete action itself, never inferred from tasks.json.)"""
    data = _read_history()
    limit = now - datetime.timedelta(days=days)
    out = {}
    for tid, runs in data.items():
        kept = [r for r in runs if (_parse_dt(r.get("ended") or r.get("started")) or now) >= limit]
        if kept:
            out[tid] = kept
    if out != data:
        _write_history(out)
    return out

# ── Errors logged by Stash during a run ──────────────────────────────────────
#
# From the moment a run starts, every pass copies the new Error lines Stash logged into
# the task (task["stash_errors"]); they move into the history entry when the run ends.
# Stash's log lines carry no job id, so whatever Stash logs as an error during the run
# is kept. Source, read at run start from Stash's own configuration (never hardcoded):
#   - Stash's log file (Settings > System > Logging): read from the position it had when
#     the run started, so no line is missed. A rotated file is read again from its start
#     (lines written to the old file after the last pass are lost);
#   - otherwise the `logs` query, which only returns Stash's last 30 lines: lines that
#     scroll out between two passes are lost, and the history says the list may be partial.

STASH_ERRORS_MAX = 50            # lines kept per run; the others are only counted
STASH_ERROR_MSG_MAX = 500        # characters kept per line
LOG_READ_MAX = 4 * 1024 * 1024   # bytes of the log file read per pass at most
ERROR_LEVELS = ("error", "fatal", "panic")

# Stash's log file (logrus text format):
#   time="2026-10-26 18:12:06" level=warning msg="[Plugin / task_scheduler] ..."
_LOG_LINE = re.compile(r'^time="([^"]*)"\s+level=(\w+)\s+msg=(.*)$')

def _parse_log_time(value):
    """Aware datetime of a Stash log time ("2026-10-26T13:52:38.330058478+01:00", or the log
    file's local "2026-10-26 18:12:06"), or None. Python's fromisoformat does not take
    nanoseconds: the fraction is cut to microseconds."""
    m = re.match(r"^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:?\d\d)?$",
                 str(value or "").strip())
    if not m:
        return None
    frac = "." + (m.group(3) or "0")[:6].ljust(6, "0")
    tz = m.group(4) or ""
    if tz == "Z":
        tz = "+00:00"
    elif tz and ":" not in tz:
        tz = tz[:3] + ":" + tz[3:]
    try:
        dt = datetime.datetime.fromisoformat(m.group(1) + "T" + m.group(2) + frac + tz)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.astimezone()

def _parse_log_line(line):
    """(time, level, message) of a line of Stash's log file, or None."""
    m = _LOG_LINE.match(line.strip())
    if not m:
        return None
    when, level, rest = m.groups()
    if rest.startswith('"'):
        q = re.match(r'"((?:[^"\\]|\\.)*)"', rest)
        body = q.group(1) if q else rest[1:]
        try:
            msg = json.loads('"' + body + '"')
        except ValueError:
            msg = body.replace('\\"', '"').replace("\\\\", "\\")
    else:
        msg = rest
    return when, level.lower(), msg

def stash_log_file(stash):
    """Path of Stash's log file from its configuration, or None when it logs to no file."""
    try:
        q = stash.call_GQL("query { configuration { general { logFile } } }")
        path = (((q or {}).get("configuration") or {}).get("general") or {}).get("logFile") or ""
        return path.strip() or None
    except Exception as e:
        log.debug(f"[TaskScheduler] Could not read Stash's log file setting: {e}")
        return None

def _add_error(t, when, msg):
    errs = t.setdefault("stash_errors", [])
    if len(errs) < STASH_ERRORS_MAX:
        errs.append({"time": when, "message": msg[:STASH_ERROR_MSG_MAX]})
    else:
        t["stash_errors_dropped"] = t.get("stash_errors_dropped", 0) + 1

def _use_memory_log(t, reason):
    """Read this run's errors from Stash's last 30 lines from now on."""
    for k in ("log_file", "log_pos", "log_ino"):
        t.pop(k, None)
    t["log_cursor"] = _now().isoformat()
    t["log_partial"] = True
    log.warning(f"[TaskScheduler] '{t.get('name')}': {reason}: Stash errors are read from Stash's last "
                "30 log lines instead (some may be missed)")

def begin_error_watch(t, stash=None):
    """Errors Stash logs from now on belong to this run."""
    for k in ("stash_errors", "stash_errors_dropped", "log_file", "log_pos", "log_ino", "log_partial"):
        t.pop(k, None)
    t["log_cursor"] = _now().isoformat()
    path = stash_log_file(stash) if stash is not None else None
    if not path:
        t["log_partial"] = True               # no log file configured in Stash
        return
    try:
        st = os.stat(path)
    except OSError as e:
        _use_memory_log(t, f"Stash's log file is not readable ({e})")
        return
    t["log_file"], t["log_pos"], t["log_ino"] = path, st.st_size, st.st_ino

def _read_log_file(t):
    """New Error lines of the log file since the task's position. True on change, None when
    the file cannot be read any more."""
    path, pos = t["log_file"], t.get("log_pos", 0)
    try:
        st = os.stat(path)
        if st.st_ino != t.get("log_ino") or st.st_size < pos:
            pos = 0                           # rotated or truncated: a new file
        chunk = b""
        if st.st_size > pos:
            with open(path, "rb") as f:
                f.seek(pos)
                chunk = f.read(LOG_READ_MAX)
    except OSError as e:
        _use_memory_log(t, f"Stash's log file is not readable any more ({e})")
        return None
    end = chunk.rfind(b"\n")
    used = end + 1 if end >= 0 else (len(chunk) if len(chunk) >= LOG_READ_MAX else 0)   # whole lines only
    changed = pos + used != t.get("log_pos") or st.st_ino != t.get("log_ino")
    t["log_pos"], t["log_ino"] = pos + used, st.st_ino
    for line in chunk[:used].decode("utf-8", "replace").splitlines():
        e = _parse_log_line(line)
        if e and e[1] in ERROR_LEVELS and "[TaskScheduler]" not in e[2]:     # our own lines are not Stash's
            when = _parse_log_time(e[0])
            _add_error(t, when.isoformat() if when else e[0], e[2])
            changed = True
    return changed

def _read_memory_log(watched, stash):
    try:
        entries = (stash.call_GQL("query { logs { time level message } }") or {}).get("logs") or []
    except Exception as e:
        log.debug(f"[TaskScheduler] Could not read Stash's log: {e}")
        return False
    lines = []
    for e in entries:
        msg = str(e.get("message") or "")
        if str(e.get("level") or "").lower() not in ERROR_LEVELS or "[TaskScheduler]" in msg:
            continue
        when = _parse_log_time(e.get("time"))
        if when is not None:
            lines.append((when, str(e.get("time")), msg))
    lines.sort(key=lambda x: x[0])
    changed = False
    for t in watched:
        cursor = _parse_log_time(t["log_cursor"])
        if cursor is None:
            continue
        for when, raw, msg in lines:
            if when <= cursor:
                continue
            _add_error(t, raw, msg)
            t["log_cursor"] = raw
            cursor = when
            changed = True
    return changed

def collect_stash_errors(tasks, stash):
    """Copy the Error lines Stash logged since each watched task's position. True on change."""
    watched = [t for t in tasks if t.get("log_cursor")]
    if not watched:
        return False
    changed, memory = False, []
    for t in watched:
        if t.get("log_file"):
            r = _read_log_file(t)
            if r is None:
                memory.append(t)
                changed = True
            else:
                changed = r or changed
        else:
            memory.append(t)
    if memory and stash is not None:
        changed = _read_memory_log(memory, stash) or changed
    return changed

# ── Run timeline ─────────────────────────────────────────────────────────────
#
# Each step of the current run (queued, scripts, scan, Identify, end) is appended to
# task["events"] as {time, kind, text}, kind = info | ok | warn | error. The list is
# returned with the task (live view of the current run) and moves into the history
# entry when the run ends. Stash's error lines are not copied in: each finished phase
# says how many were logged during it.

EVENTS_MAX = 100
EVENT_KEYS = ("events", "events_dropped", "phase_started", "phase_errors", "job_running")
TRIGGER_LABELS = {"manual": "Manual", "run_all": "Run All", "schedule": "Scheduled"}
PHASE_LABELS = {"pre": "Pre-scan scripts", "scan": "Scan", "post": "Post-scan scripts", "identify": "Identify"}

def add_event(t, kind, text):
    ev = t.setdefault("events", [])
    if len(ev) < EVENTS_MAX:
        ev.append({"time": _now().isoformat(timespec="seconds"), "kind": kind, "text": text})
    else:
        t["events_dropped"] = t.get("events_dropped", 0) + 1

def _error_count(t):
    return len(t.get("stash_errors") or []) + t.get("stash_errors_dropped", 0)

def _fmt_secs(s):
    s = max(0, int(s))
    if s < 60:
        return f"{s} s"
    if s < 3600:
        return f"{s // 60} m {s % 60:02d} s"
    return f"{s // 3600} h {s % 3600 // 60:02d} m"

def phase_begin(t):
    """A phase starts now: its duration and its Stash errors are counted from here."""
    t["phase_started"] = _now().isoformat(timespec="seconds")
    t["phase_errors"] = _error_count(t)

def phase_summary(t, phase):
    """' (8 m 27 s) — 10 Stash errors during the scan' for the phase that just ended."""
    out = ""
    began = _parse_dt(t.get("phase_started"))
    if began:
        out += f" ({_fmt_secs((_now() - began).total_seconds())})"
    n = _error_count(t) - t.get("phase_errors", 0)
    if n > 0:
        out += f" — {n} Stash error{'s' if n > 1 else ''} during the {PHASE_LABELS[phase].lower()}"
    return out

def phase_end(t, phase, kind, text, note=""):
    """Record the end of a phase, e.g. 'Scan finished (8 m 27 s) — 10 Stash errors during the scan'."""
    add_event(t, kind, text + phase_summary(t, phase) + note)
    t.pop("phase_started", None)
    t["phase_errors"] = _error_count(t)         # errors already reported are not counted again

# ── Identify (after the post-scan scripts) ───────────────────────────────────
#
# task["identify"] = {"enabled": bool, "sources": [{"type": "stashbox", "endpoint", "name"} |
# {"type": "scraper", "id", "name"}]}, in the order Stash tries them. Settings are Stash's
# own saved Identify defaults (Tasks > Identify), read when the Identify starts.

IDENTIFY_OPTION_FIELDS = ("fieldOptions { field strategy createMissing } setCoverImage setOrganized "
                          "performerGenders skipMultipleMatches skipMultipleMatchTag "
                          "skipSingleNamePerformers skipSingleNamePerformerTag")

def _clean_identify(v):
    out, seen = [], set()
    v = v if isinstance(v, dict) else {}
    for s in v.get("sources") or []:
        if not isinstance(s, dict):
            continue
        if s.get("type") == "stashbox" and s.get("endpoint"):
            item = {"type": "stashbox", "endpoint": str(s["endpoint"])}
            item["name"] = str(s.get("name") or item["endpoint"])
        elif s.get("type") == "scraper" and s.get("id"):
            item = {"type": "scraper", "id": str(s["id"])}
            item["name"] = str(s.get("name") or item["id"])
        else:
            continue
        key = _source_key(item)
        if key not in seen:
            seen.add(key)
            out.append(item)
    return {"enabled": bool(v.get("enabled")) and bool(out), "sources": out}

def _source_key(s):
    return ("stashbox", s.get("endpoint")) if s.get("type") == "stashbox" else ("scraper", s.get("id"))

def _has_identify(t):
    idf = t.get("identify") or {}
    return bool(idf.get("enabled") and idf.get("sources"))

def _opts_input(o):
    """Stash's saved options (query result) as IdentifyMetadataOptionsInput: unset fields left out."""
    if not isinstance(o, dict):
        return {}
    out = {}
    for k, v in o.items():
        if v is None:
            continue
        if k == "fieldOptions":
            v = [{fk: fv for fk, fv in (f or {}).items() if fv is not None} for f in v or []]
            if not v:
                continue
        out[k] = v
    return out

def _overwritten(opts):
    return [f.get("field") for f in (opts or {}).get("fieldOptions") or [] if f.get("strategy") == "OVERWRITE"]

def identify_input(t, stash):
    """(metadataIdentify input, names of the chosen sources Stash no longer offers, fields overwritten)."""
    q = stash.call_GQL(
        "query { listScrapers(types: [SCENE]) { id scene { supported_scrapes } } "
        "configuration { general { stashBoxes { endpoint } } defaults { identify { "
        "sources { source { stash_box_endpoint scraper_id } options { %s } } options { %s } } } } }"
        % (IDENTIFY_OPTION_FIELDS, IDENTIFY_OPTION_FIELDS)) or {}
    # Identify only uses scrapers that can scrape a scene from its file ("fragment")
    scrapers = {s.get("id") for s in q.get("listScrapers") or []
                if "FRAGMENT" in ((s.get("scene") or {}).get("supported_scrapes") or [])}
    conf = q.get("configuration") or {}
    boxes = {b.get("endpoint") for b in (conf.get("general") or {}).get("stashBoxes") or []}
    defaults = (conf.get("defaults") or {}).get("identify") or {}
    per_source = {}
    for ds in defaults.get("sources") or []:
        src = ds.get("source") or {}
        key = ("stashbox", src["stash_box_endpoint"]) if src.get("stash_box_endpoint") else ("scraper", src.get("scraper_id"))
        opts = _opts_input(ds.get("options"))
        if opts:
            per_source[key] = opts
    sources, skipped, overwrite = [], [], set()
    for s in (t.get("identify") or {}).get("sources") or []:
        available = s.get("endpoint") in boxes if s.get("type") == "stashbox" else s.get("id") in scrapers
        if not available:
            skipped.append(s.get("name") or s.get("endpoint") or s.get("id"))
            continue
        item = {"source": {"stash_box_endpoint": s["endpoint"]} if s.get("type") == "stashbox" else {"scraper_id": s["id"]}}
        opts = per_source.get(_source_key(s))
        if opts:
            item["options"] = opts
            overwrite.update(_overwritten(opts))
        sources.append(item)
    inp = {"paths": list(t.get("paths") or []), "sources": sources}
    general = _opts_input(defaults.get("options"))
    if general:
        inp["options"] = general
        overwrite.update(_overwritten(general))
    return inp, skipped, sorted(x for x in overwrite if x)

def start_identify(t, stash):
    """Queue the Identify job of a task whose scan (and post-scan scripts) succeeded.
    Returns False when the task failed instead."""
    try:
        inp, skipped, overwrite = identify_input(t, stash)
    except Exception as e:
        _fail_task(t, f"Could not prepare the Identify: {e}", "identify")
        return False
    for name in skipped:
        log.warning(f"[TaskScheduler] '{t.get('name')}': Identify source '{name}' is not available in Stash any more, skipped")
    if not inp["sources"]:
        _fail_task(t, "Identify: none of the chosen sources is available in Stash any more", "identify")
        return False
    for name in skipped:
        add_event(t, "warn", f"Identify source '{name}' is not available in Stash any more, skipped")
    if overwrite:
        log.warning(f"[TaskScheduler] '{t.get('name')}': Stash's Identify settings overwrite existing values of: "
                    + ", ".join(overwrite))
        add_event(t, "warn", "Stash's Identify settings overwrite existing values of: " + ", ".join(overwrite))
    try:
        data = stash.call_GQL("mutation Identify($input: IdentifyMetadataInput!) { metadataIdentify(input: $input) }",
                              {"input": inp})
        job_id = (data or {}).get("metadataIdentify")
    except Exception as e:
        _fail_task(t, f"Stash did not accept the Identify: {e}", "identify")
        return False
    if not job_id:
        _fail_task(t, "Stash did not return a job id for the Identify", "identify")
        return False
    t["status"] = "running"
    t["phase"] = "identify"
    t["job_id"] = str(job_id)
    t.pop("job_added", None)
    if t.get("started") in (None, "", "—"):
        t["started"] = _now_str()
    t["progress"] = None
    t["job_raw"] = None
    t["job_info"] = "Identify queued"
    if skipped:
        t["identify_skipped"] = skipped
    log.info(f"[TaskScheduler] Identify queued for '{t.get('name')}' (job {job_id}, "
             f"{len(inp['sources'])} source(s))")
    names = [s.get("name") or s.get("endpoint") or s.get("id") for s in (t.get("identify") or {}).get("sources") or []]
    used = [n for n in names if n not in skipped]
    add_event(t, "info", f"Identify sent to Stash (job {job_id}) — sources: " + ", ".join(used))
    phase_begin(t)
    return True

def _finish_done(t):
    """The run's last step succeeded."""
    _clear_phase(t)
    for k in ("job_id", "keep_started"):
        t.pop(k, None)
    now = _now_str()
    t["status"] = "done"
    if t.get("started") in (None, "", "—"):
        t["started"] = now
    t["ended"] = now
    t["progress"] = 100
    t.pop("error_info", None)
    notes = []
    warnings = t.pop("script_warnings", 0)
    if warnings:
        notes.append(f"{warnings} script failure(s) ignored")
    skipped = t.pop("identify_skipped", None)
    if skipped:
        notes.append("Identify sources no longer in Stash, skipped: " + ", ".join(skipped))
    began = _parse_dt(t.get("started"))
    add_event(t, "ok", "Run done" + (f" (total {_fmt_secs((_now() - began).total_seconds())})" if began else ""))
    record_history(t, "done", detail="; ".join(notes) or None)

def run_task_now(task, stash):
    """Queue a Stash metadata scan for the task. Returns the Stash job id, or None on failure."""
    paths = task.get("paths", [])
    opts = task.get("options", {})
    flags = {
        "scanGenerateCovers":         bool(opts.get("covers",          True)),
        "scanGeneratePreviews":       bool(opts.get("previews",        True)),
        "scanGenerateImagePreviews":  bool(opts.get("animPreviews",    False)),
        "scanGenerateSprites":        bool(opts.get("sprites",         False)),
        "scanGeneratePhashes":        bool(opts.get("phashes",         True)),
        "scanGenerateImagePhashes":   bool(opts.get("imgPhashes",      False)),
        "scanGenerateThumbnails":     bool(opts.get("imgThumbs",       True)),
        "scanGenerateClipPreviews":   bool(opts.get("imgClipPreviews", False)),
        "rescan":                     bool(opts.get("rescan",          False)),
    }
    log.info(f"[TaskScheduler] Starting '{task['name']}' on {paths}")
    try:
        job_id = stash.metadata_scan(paths=paths, flags=flags)
        if job_id is None:
            log.error(f"[TaskScheduler] Stash did not return a job id for '{task['name']}'")
            return None
        log.info(f"[TaskScheduler] Scan queued for '{task['name']}' (job {job_id})")
        return str(job_id)
    except Exception as e:
        log.error(f"[TaskScheduler] Scan failed for '{task['name']}': {e}")
        return None

def is_manual_task(t):
    return (t.get("schedule") or {}).get("type", "manual") == "manual"

def is_script_phase(t):
    """Running its pre- or post-scan scripts (no Stash job at that moment)."""
    return t.get("status") == "running" and t.get("phase") in ("pre", "post")

def is_active_task(t):
    """Being worked on: pushed to Stash and not finished yet (waiting in Stash's
    queue or running), or running its pre/post scripts."""
    return (bool(t.get("job_id")) and t.get("status") in ("queued", "running")) or is_script_phase(t)

def is_waiting_task(t):
    """Waiting in the plugin's own queue: not pushed to Stash yet."""
    return t.get("status") == "queued" and not t.get("job_id")

def enqueue_task(t, trigger="manual"):
    """Put a task in the plugin queue. It is only pushed to Stash when its turn comes.
    `trigger` (manual | run_all | schedule) is kept for the run history."""
    t["status"] = "queued"
    t["trigger"] = trigger
    t["started"] = "—"
    t["ended"] = "—"
    t["progress"] = 0
    for k in ("job_id", "job_info", "job_raw", "phase", "script_pid", "keep_started", "error_info", "failed_phase",
              "missed_at", "missed_reason", "script_warnings", "identify_skipped", "log_cursor", "stash_errors",
              "stash_errors_dropped", "last_stash_errors", "log_file", "log_pos", "log_ino", "log_partial",
              "job_added") + EVENT_KEYS:
        t.pop(k, None)
    add_event(t, "info", f"Queued ({TRIGGER_LABELS.get(trigger, trigger)})")

def _run_definition(t):
    """What a run of the task does (the name is only a label). Only the schedule
    fields its type uses count: the wizard always sends a time, even for a manual task."""
    sc = t.get("schedule") or {}
    stype = sc.get("type", "manual")
    sched = [stype,
             sc.get("time") if stype in ("daily", "weekly") else None,
             sorted(sc.get("days") or []) if stype == "weekly" else None,
             _iso(_parse_dt(sc.get("at")).astimezone()) if stype == "once" and _parse_dt(sc.get("at")) else None]
    identify = (t.get("identify") or {}).get("sources") if _has_identify(t) else None
    return json.dumps([t.get("paths"), t.get("options"), sched, t.get("scripts"), identify], sort_keys=True)

def reset_after_edit(t):
    """A finished task whose definition changed starts afresh: its last run
    described the old definition (it stays in the history)."""
    if t.get("status") not in ("done", "error", "paused", "missed"):
        return
    t["status"] = "pending"
    t["started"] = "—"
    t["ended"] = "—"
    t["progress"] = 0
    for k in ("error_info", "failed_phase", "missed_at", "missed_reason"):
        t.pop(k, None)

def push_to_stash(t, stash):
    """Start the task's scan in Stash (one task at a time)."""
    job_id = run_task_now(t, stash)
    if job_id:
        t["job_id"] = job_id          # status stays 'queued' until Stash reports RUNNING
        t.pop("job_added", None)
        add_event(t, "info", f"Scan sent to Stash (job {job_id})")
        phase_begin(t)
    else:
        t["status"] = "error"
        t["ended"] = _now_str()
        t["error_info"] = "Stash did not accept the scan"
        add_event(t, "error", t["error_info"])
        record_history(t, "error", detail=t["error_info"])

# ── Pre / post scan scripts ──────────────────────────────────────────────────
#
# A task may carry shell command lines to run before and/or after its scan:
#   task["scripts"] = {"pre": [{"cmd": "...", "continue": false}], "post": [...]}
# Each command runs once per selected path (script by script, path by path);
# "{path}" is replaced by the quoted path (TS_PATH, TS_TASK_NAME and TS_PHASE are
# also set in the environment). A script runs in a detached runner process
# (`--run-scripts <task id> <phase>`) that reports into .runs/<id>.json, so a
# long script never blocks the plugin; the queue picks the result up on its next pass.

RUNS_DIR = os.path.join(PLUGIN_DIR, ".runs")
LOGS_DIR = os.path.join(PLUGIN_DIR, "logs")

def _clean_scripts(v):
    out = {"pre": [], "post": []}
    if isinstance(v, dict):
        for phase in ("pre", "post"):
            for sc in v.get(phase) or []:
                if isinstance(sc, str):
                    sc = {"cmd": sc}
                if not isinstance(sc, dict):
                    continue
                cmd = str(sc.get("cmd", "")).strip()
                if cmd:
                    out[phase].append({"cmd": cmd, "continue": bool(sc.get("continue", False))})
    return out

def _has_scripts(t, phase):
    return bool((t.get("scripts") or {}).get(phase))

def _expand(cmd, path):
    """Replace {path} by the shell-quoted path (also when the user wrapped it in quotes)."""
    q = shlex.quote(path)
    cmd = cmd.replace('"{path}"', q).replace("'{path}'", q)
    return cmd.replace("{path}", q)

def _run_file(tid):
    return os.path.join(RUNS_DIR, f"{tid}.json")

def _read_run(tid):
    try:
        with open(_run_file(tid)) as f:
            return json.load(f)
    except Exception:
        return None

def _drop_run(tid):
    try:
        os.remove(_run_file(tid))
    except Exception:
        pass

def _pid_alive(pid):
    if not pid:
        return False
    if os.path.isdir("/proc"):
        try:
            with open(f"/proc/{pid}/stat") as f:
                return f.read().rsplit(")", 1)[1].split()[0] != "Z"   # a zombie is finished
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except Exception:
        return False

def _now_str():
    return _iso(_now())

def _clear_phase(t):
    for k in ("phase", "script_pid", "job_info", "job_raw", "job_added", "job_running"):
        t.pop(k, None)

def _fail_task(t, message, phase=None):
    phase_end(t, phase or "scan", "error", message)
    _clear_phase(t)
    t["failed_phase"] = phase or "scan"
    for k in ("keep_started", "job_id", "script_warnings", "identify_skipped"):
        t.pop(k, None)
    t["status"] = "error"
    t["ended"] = _now_str()
    t["error_info"] = message
    log.error(f"[TaskScheduler] '{t.get('name')}': {message}")
    record_history(t, "error", detail=message)

def begin_phase(t, phase):
    """Start the runner for the task's pre or post scripts. Returns False on failure."""
    try:
        os.makedirs(RUNS_DIR, exist_ok=True)
        _drop_run(t["id"])
        p = subprocess.Popen(
            [sys.executable or "python3", os.path.realpath(__file__), "--run-scripts", str(t["id"]), phase],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True, close_fds=True, cwd=PLUGIN_DIR)
    except Exception as e:
        _fail_task(t, f"Could not start the {phase}-scan scripts: {e}", phase)
        return False
    t["status"] = "running"
    t["phase"] = phase
    t["script_pid"] = p.pid
    t["progress"] = None
    t["job_raw"] = "n/a (scripts)"
    t["job_info"] = f"Starting {phase}-scan scripts"
    t.pop("error_info", None)
    if t.get("started") in (None, "", "—"):
        t["started"] = _now_str()
    log.info(f"[TaskScheduler] '{t['name']}': {phase}-scan scripts started")
    n, m = len((t.get("scripts") or {}).get(phase) or []), len(t.get("paths") or [])
    add_event(t, "info", f"{PHASE_LABELS[phase]} started — {n} script{'s' if n > 1 else ''} × {m} path{'s' if m > 1 else ''}")
    phase_begin(t)
    return True

def kill_scripts(t):
    """Stop the runner and everything it started (its whole process group)."""
    pid = t.get("script_pid")
    if not pid:
        return
    try:
        os.killpg(pid, signal.SIGTERM)
        for _ in range(10):
            if not _pid_alive(pid):
                break
            time.sleep(0.2)
        else:
            os.killpg(pid, signal.SIGKILL)
    except Exception:
        pass
    _drop_run(t.get("id"))

def remove_task_files(tid):
    """Delete what the pre/post scripts left behind for a task: its log and run state."""
    try:
        tid = int(tid)
    except (TypeError, ValueError):
        return
    for path in (os.path.join(LOGS_DIR, f"task_{tid}.log"), _run_file(tid)):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        except Exception as e:
            log.error(f"[TaskScheduler] Could not remove {path}: {e}")

def _ignored(info):
    n = info.get("warnings") or 0
    return f" — {n} script failure{'s' if n > 1 else ''} ignored" if n else ""

def sync_script_phases(tasks, stash):
    """Follow the runners of tasks in a script phase and move them on when done."""
    changed = False
    for t in tasks:
        if not is_script_phase(t):
            continue
        phase = t["phase"]
        info = _read_run(t["id"]) or {}
        finished = bool(info.get("done")) and info.get("phase") == phase
        if not finished and not _pid_alive(t.get("script_pid")):
            info = {"done": True, "phase": phase, "ok": False, "error": "the script runner stopped unexpectedly"}
            finished = True
        if not finished:
            msg = info.get("current") or ""
            if msg and info.get("total"):
                msg = f"{phase} {info.get('step', 0)}/{info['total']}: {msg}"
            if msg and msg != t.get("job_info"):
                t["job_info"] = msg
                changed = True
            continue
        ok = bool(info.get("ok"))
        err = info.get("error") or "unknown error"
        if phase == "pre":
            if not ok:
                _drop_run(t["id"])
                _fail_task(t, f"Pre-scan script failed: {err}", "pre")
                changed = True
                continue
            if stash is None:
                continue                       # cannot start the scan yet, retry on the next pass
            _drop_run(t["id"])
            phase_end(t, "pre", "ok", "Pre-scan scripts done", _ignored(info))
            _clear_phase(t)
            t["keep_started"] = True           # keep the time the task really began
            t["status"] = "queued"
            push_to_stash(t, stash)            # sets job_id, or turns the task into an error
            if t.get("status") == "error":
                t.pop("keep_started", None)
                t["error_info"] = "Stash did not accept the scan"
        else:
            if ok and _has_identify(t) and stash is None:
                continue                       # cannot start the Identify yet, retry on the next pass
            _drop_run(t["id"])
            if ok:
                phase_end(t, "post", "ok", "Post-scan scripts done", _ignored(info))
                _clear_phase(t)
                t["script_warnings"] = info.get("warnings") or 0
                if _has_identify(t):
                    start_identify(t, stash)   # runs the job, or turns the task into an error
                else:
                    _finish_done(t)
            else:
                _fail_task(t, f"Post-scan script failed: {err}", "post")
        changed = True
    return changed

def run_scripts_main(tid, phase):
    """Runner process: executes one phase's scripts and reports into .runs/<id>.json."""
    tasks = load_tasks()
    t = next((x for x in tasks if x.get("id") == tid), None)
    os.makedirs(RUNS_DIR, exist_ok=True)

    def report(**kw):
        d = {"phase": phase, "pid": os.getpid()}
        d.update(kw)
        _atomic_write_json(_run_file(tid), d)

    if t is None:
        report(done=True, ok=False, error="task not found")
        return 1
    scripts = (t.get("scripts") or {}).get(phase) or []
    paths = t.get("paths") or []
    total = len(scripts) * len(paths)
    os.makedirs(LOGS_DIR, exist_ok=True)
    log_path = os.path.join(LOGS_DIR, f"task_{tid}.log")
    try:                                    # keep the log file from growing forever
        if os.path.getsize(log_path) > 1024 * 1024:
            with open(log_path, "rb") as f:
                f.seek(-300 * 1024, os.SEEK_END)
                tail = f.read()
            with open(log_path, "wb") as f:
                f.write(tail[tail.find(b"\n") + 1:])
    except Exception:
        pass
    logf = open(log_path, "a", buffering=1)

    def note(msg):
        logf.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} [{phase}] {msg}\n")

    note(f"=== {t.get('name')}: {len(scripts)} script(s) x {len(paths)} path(s)")
    report(done=False, step=0, total=total, current="")
    step = 0
    warnings = 0
    for sc in scripts:
        for p in paths:
            step += 1
            cmd = _expand(sc["cmd"], p)
            report(done=False, step=step, total=total,
                   current=f"{sc['cmd']}  [{os.path.basename(p.rstrip('/')) or p}]")
            note(f"$ {cmd}")
            env = dict(os.environ)
            env.update({"TS_PATH": p, "TS_TASK_NAME": str(t.get("name", "")), "TS_PHASE": phase})
            try:
                rc = subprocess.call(cmd, shell=True, env=env, stdin=subprocess.DEVNULL,
                                     stdout=logf, stderr=subprocess.STDOUT)
            except Exception as e:
                note(f"could not run: {e}")
                rc = 127
            note(f"exit code {rc}")
            if rc != 0:
                if sc.get("continue"):
                    warnings += 1
                    continue
                report(done=True, ok=False, step=step, total=total,
                       error=f"'{sc['cmd']}' exited with code {rc} on {p}")
                return 1
    report(done=True, ok=True, step=total, total=total, warnings=warnings)
    return 0

def start_task(t, stash):
    """A waiting task's turn has come: run its pre-scan scripts, or go straight to the scan."""
    begin_error_watch(t, stash)
    if _has_scripts(t, "pre"):
        t["started"] = _now_str()
        t["ended"] = "—"
        t["keep_started"] = True
        begin_phase(t, "pre")
    else:
        push_to_stash(t, stash)

def process_queue(stash):
    """Sync the active task (scripts and Stash job) and, when nothing is active,
    start the next waiting task (list order). Caller must hold the plugin lock.
    Returns True while there is still something waiting or running."""
    tasks = load_tasks()
    changed = collect_stash_errors(tasks, stash)       # before a run ends: its last errors go with it
    changed = sync_script_phases(tasks, stash) or changed
    changed = sync_job_statuses(tasks, stash) or changed
    if stash is not None:
        while not any(is_active_task(t) for t in tasks):
            nxt = next((t for t in tasks if is_waiting_task(t)), None)
            if nxt is None:
                break
            start_task(nxt, stash)   # on failure the task becomes 'error' and we try the next one
            changed = True
    if changed:
        save_tasks(tasks)
    return any(is_active_task(t) or is_waiting_task(t) for t in tasks)

# ── Locking and cron ─────────────────────────────────────────────────────────

LOCK_FILE = os.path.join(PLUGIN_DIR, ".tasks.lock")
CRON_ATTEMPT_FILE = os.path.join(PLUGIN_DIR, ".cron_attempt")
CRONTAB_FILE = os.environ.get("TS_CRONTAB_FILE", "/etc/crontabs/root")   # Alpine / BusyBox
CRON_MARKER = "# task_scheduler"
CRON_RETRY_DELAY = 60       # seconds between two automatic repair attempts
HEARTBEAT_FILE = os.path.join(PLUGIN_DIR, ".heartbeat")
HEARTBEAT_MAX_AGE = 150     # seconds: a cron tick every minute stays well inside this

class plugin_lock(object):
    """Exclusive lock serialising every read-modify-write of tasks.json."""
    def __enter__(self):
        self.f = open(LOCK_FILE, "w")
        if fcntl:
            fcntl.flock(self.f, fcntl.LOCK_EX)
        return self
    def __exit__(self, *a):
        try:
            if fcntl:
                fcntl.flock(self.f, fcntl.LOCK_UN)
        finally:
            self.f.close()

NO_CROND_MSG = "no crond in this container: scheduled runs need an external trigger (see the README)"

def touch_heartbeat(source="cron"):
    """Record that a scheduler pass just ran, and what ran it: "cron" (--tick) or
    "external" (the tick action, called through Stash's API)."""
    try:
        with open(HEARTBEAT_FILE, "w") as f:
            json.dump({"t": time.time(), "source": source}, f)
    except Exception:
        pass

def _read_heartbeat():
    try:
        with open(HEARTBEAT_FILE) as f:
            hb = json.load(f)
        return hb if isinstance(hb, dict) else {}
    except Exception:
        return {}

def scheduler_status():
    """Source of the last scheduler pass ("cron" or "external") if it ran recently, else None."""
    hb = _read_heartbeat()
    try:
        if time.time() - float(hb.get("t", 0)) < HEARTBEAT_MAX_AGE:
            return hb.get("source") or "cron"
    except Exception:
        pass
    return None

def _crond_binary():
    return shutil.which("crond") or shutil.which("cron")

def scheduler_info():
    """What the page shows about the scheduler: running source, last pass, crond available."""
    hb = _read_heartbeat()
    last = None
    try:
        if hb.get("t"):
            last = _iso(datetime.datetime.fromtimestamp(float(hb["t"])).astimezone())
    except Exception:
        pass
    return {"status": scheduler_status(), "last_pass": last,
            "last_source": hb.get("source") or ("cron" if last else None),
            "crond": _crond_binary() is not None}

def _crond_running():
    """Is a cron daemon process running? (scans /proc, no pgrep needed)"""
    try:
        for pid in os.listdir("/proc"):
            if pid.isdigit():
                try:
                    with open(f"/proc/{pid}/comm") as f:
                        if f.read().strip() in ("crond", "cron"):
                            return True
                except Exception:
                    continue
    except Exception:
        pass
    return False

def _cron_line():
    """The crontab entry. Connection settings are copied from the current environment
    because cron does not pass the container environment on. The API key is never
    written here: the tick reads it from Stash's config.yml at run time."""
    env = ""
    for k in ("STASH_PORT", "STASH_HOST", "STASH_SCHEME", "STASH_CONFIG_FILE"):
        if os.environ.get(k):
            env += f"{k}={shlex.quote(os.environ[k])} "
    py = shlex.quote(sys.executable or "python3")
    script = shlex.quote(os.path.realpath(__file__))
    return (f"* * * * * {env}{py} {script} --tick "
            f">/dev/null 2>>/tmp/ts-tick.log {CRON_MARKER}")

def ensure_cron():
    """Make sure the crontab entry exists and crond is running (idempotent).
    Returns a short message describing what was done or what went wrong. Writes nothing
    when the container has no cron daemon."""
    exe = _crond_binary()
    if not exe:
        return NO_CROND_MSG
    done = []
    try:
        line = _cron_line()
        existing = []
        if os.path.isfile(CRONTAB_FILE):
            with open(CRONTAB_FILE) as f:
                existing = f.read().splitlines()
        kept = [l for l in existing if CRON_MARKER not in l]
        if line not in existing:
            os.makedirs(os.path.dirname(CRONTAB_FILE), exist_ok=True)
            with open(CRONTAB_FILE, "w") as f:
                f.write("\n".join(kept + [line]) + "\n")
            done.append("crontab entry written")
    except Exception as e:
        return f"could not write {CRONTAB_FILE}: {e}"
    if not _crond_running():
        try:
            subprocess.Popen([exe, "-b", "-l", "8"] if exe.endswith("crond") else [exe],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
            done.append("crond started")
        except Exception as e:
            return f"could not start crond: {e}"
    return ", ".join(done) or "already set up"

def repair_cron_if_needed():
    """Called when no scheduler pass ran recently: bring cron back, at most once a minute.
    Without a cron daemon there is nothing to repair (an external trigger is needed). Logs
    only when the outcome differs from the previous attempt, not at every attempt."""
    if _crond_binary() is None:
        return NO_CROND_MSG
    prev = {}
    try:
        with open(CRON_ATTEMPT_FILE) as f:
            prev = json.load(f)
        if not isinstance(prev, dict):          # 1.9.x wrote a bare timestamp
            prev = {"t": float(prev)}
    except Exception:
        prev = {}
    if time.time() - float(prev.get("t") or 0) < CRON_RETRY_DELAY:
        return prev.get("msg")
    msg = ensure_cron()
    try:
        with open(CRON_ATTEMPT_FILE, "w") as f:
            json.dump({"t": time.time(), "msg": msg}, f)
    except Exception:
        pass
    if msg != prev.get("msg"):
        log.info(f"[TaskScheduler] Cron repair: {msg}")
    return msg

LAST_CHECK_FILE = os.path.join(PLUGIN_DIR, ".last_check")

def _read_last_check():
    """Time of the previous scheduler pass (aware), or None before the first one."""
    try:
        with open(LAST_CHECK_FILE) as f:
            return datetime.datetime.fromtimestamp(float(json.load(f)["t"])).astimezone()
    except Exception:
        return None

def _write_last_check(now):
    try:
        _atomic_write_json(LAST_CHECK_FILE, {"t": now.timestamp()})
    except Exception as e:
        log.error(f"[TaskScheduler] Could not save the last check time: {e}")

def trigger_due_tasks(tasks, now, last_check, global_on):
    """Start the tasks planned for `now`'s minute and mark as missed the planned
    starts that passed since the previous pass (`last_check`, None on the very
    first pass). There is no late start: a run begins in its own minute or is
    missed. Disabled tasks and a switched-off scheduler skip their runs silently."""
    if not global_on:
        return False
    changed = False
    cur = _minute(now)
    after = cur - datetime.timedelta(minutes=1)
    if last_check is not None:
        after = max(_minute(last_check), cur - datetime.timedelta(minutes=MAX_CATCHUP_MINUTES))
    for t in tasks:
        if not t.get("enabled", True) or not t.get("paths"):
            continue
        sc = t.setdefault("schedule", {})
        stype = sc.get("type")
        if stype == "once":
            at = _parse_dt(sc.get("at"))
            if at is None or _minute(at) > cur:
                continue
            sc["at"] = ""                       # consumed: a one-time task is evaluated once
            due = [(None, _minute(at))]
        elif stype in ("daily", "weekly"):
            due = [(s, w) for s, w in recurring_occurrences(sc, after, now) if s != t.get("last_slot")]
        else:
            continue
        for slot, when in due:
            if slot:
                t["last_slot"] = slot           # the autumn repeat of a time is the same slot
            if when < cur:
                _mark_missed(t, when, MISSED_NOT_RUNNING)
            elif is_active_task(t) or is_waiting_task(t):
                _mark_missed(t, when, MISSED_STILL_ACTIVE)
            else:
                log.info(f"[TaskScheduler] Schedule due: '{t.get('name')}'")
                enqueue_task(t, "schedule")
            changed = True
    return changed

def _read_stash_config():
    """Read the port and the API key from Stash's config.yml (no YAML library needed).
    The plugin lives in <config dir>/plugins/<plugin>/, so the file is two levels up."""
    candidates = [
        os.environ.get("STASH_CONFIG_FILE", ""),
        os.path.join(PLUGIN_DIR, "..", "..", "config.yml"),
        os.path.expanduser("~/.stash/config.yml"),
    ]
    out = {}
    for path in candidates:
        if not path or not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    m = re.match(r"^(port|api_key)\s*:\s*(.*?)\s*(#.*)?$", line)  # lint:allow-external
                    if m:
                        out.setdefault(m.group(1), m.group(2).strip("'\""))
        except Exception:
            continue
        if out:
            break
    return out

def _env_connection():
    """Connection used outside a plugin call (cron tick only). Port: environment, else
    Stash's config.yml. API key: only from config.yml (never from the environment,
    never logged). Documented exception, see CLAUDE.md (task_scheduler cron tick)."""
    cfg = _read_stash_config()
    conn = {
        "Scheme": os.environ.get("STASH_SCHEME", "http"),
        "Host":   os.environ.get("STASH_HOST", "localhost"),  # lint:allow-external
        "Port":   int(os.environ.get("STASH_PORT") or cfg.get("port") or 9999),
    }
    key = cfg.get("api_key")  # lint:allow-external
    if key:
        conn["ApiKey"] = key  # lint:allow-external
    return conn

def tick_once(stash):
    """One scheduler pass: trigger due tasks, then advance the queue.
    Caller must hold the plugin lock. Returns True while work remains."""
    now = _now()
    tasks = load_tasks()
    if trigger_due_tasks(tasks, now, _read_last_check(), _read_global_state()):
        save_tasks(tasks)
    _write_last_check(now)
    prune_history(history_days(stash), now)
    media_cleanup()
    return process_queue(stash)

def tick_main():
    """One-shot mode for cron: `task_scheduler.py --tick` (connection from the
    STASH_* environment variables, see _env_connection)."""
    try:
        stash = StashInterface(_env_connection())
    except Exception as e:
        log.error(f"[TaskScheduler] Tick: StashInterface: {e}")
        return 1
    with plugin_lock():
        busy = tick_once(stash)
    touch_heartbeat()
    print("busy" if busy else "idle")
    return 0

def sync_job_statuses(tasks, stash):
    """Update 'queued'/'running' tasks from the status of their Stash job."""
    if stash is None:
        return False
    pending = [t for t in tasks if t.get("status") in ("queued", "running") and t.get("job_id")]
    if not pending:
        return False
    try:
        # jobQueue is what the Stash UI itself reads for its progress bar
        q = stash.call_GQL("query { jobQueue { id status progress description subTasks error addTime } }")
        queue = {str(j.get("id")): j for j in (q or {}).get("jobQueue") or []}
    except Exception as e:
        log.error(f"[TaskScheduler] Could not read the job queue: {e}")
        return False
    changed = False
    now = _now_str()
    for t in pending:
        job_id = t["job_id"]
        job = queue.get(str(job_id))
        if job is None:
            # Not in the queue anymore: it may have just finished
            try:
                data = stash.call_GQL(
                    "query FindJob($input: FindJobInput!) { findJob(input: $input) { id status progress description subTasks error addTime } }",
                    {"input": {"id": job_id}},
                )
                job = (data or {}).get("findJob")
            except Exception as e:
                log.error(f"[TaskScheduler] Could not read job {job_id}: {e}")
                continue
        # A job no longer known to Stash has already been cleaned up: it is over.
        status = (job or {}).get("status", "FINISHED")
        phase = "identify" if t.get("phase") == "identify" else "scan"
        # Job ids restart at 1 when Stash restarts: the same id with another add time is
        # another job, and the one this task was following is gone
        added = (job or {}).get("addTime")
        if added:
            if not t.get("job_added"):
                t["job_added"] = added
                changed = True
            elif t["job_added"] != added:
                _fail_task(t, f"Stash was restarted during the {phase}: its job was lost", phase)
                changed = True
                continue
        if status == "READY":
            if phase == "scan" and t.get("status") != "queued":   # an Identify waits mid-run: still running
                t["status"] = "queued"
                changed = True
            continue
        if status in ("RUNNING", "STOPPING"):
            if t.get("status") != "running":
                t["status"] = "running"
                if not t.pop("keep_started", False):
                    t["started"] = now
                changed = True
            if t.get("job_running") != job_id:     # an Identify is already 'running' while Stash queues it
                t["job_running"] = job_id
                add_event(t, "info", f"{PHASE_LABELS[phase]} started")
                phase_begin(t)
                changed = True
            # Stash reports progress as 0..1; null/negative while it is unknown
            # (e.g. during file discovery). Store None so the UI can show an
            # indeterminate bar instead of a misleading 0%.
            prog = (job or {}).get("progress")
            pct = round(prog * 100, 1) if isinstance(prog, (int, float)) and prog >= 0 else None
            sub = (job or {}).get("subTasks") or []
            info = (sub[0] if sub else (job or {}).get("description")) or ""
            if t.get("progress") != pct or t.get("job_info") != info or t.get("job_raw") != prog:
                t["job_raw"] = prog
                t["progress"] = pct
                t["job_info"] = info
                changed = True
            continue
        if status == "FINISHED":
            phase_end(t, phase, "ok", f"{PHASE_LABELS[phase]} finished")
            # Order of a run: pre-scan scripts > scan > post-scan scripts > identify
            if phase == "scan" and (_has_scripts(t, "post") or _has_identify(t)):
                for k in ("job_id", "job_info", "job_raw", "keep_started", "job_added", "job_running"):
                    t.pop(k, None)
                if _has_scripts(t, "post"):
                    begin_phase(t, "post")
                else:
                    start_identify(t, stash)
            else:
                _finish_done(t)
            changed = True
            continue
        if status == "FAILED":
            err = (job or {}).get("error")
            _fail_task(t, f"Stash {phase} job failed" + (f": {err}" if err else ""), phase)
            changed = True
            continue
        # CANCELLED: stopped from Stash's own UI
        phase_end(t, phase, "warn", f"{PHASE_LABELS[phase]} stopped in Stash (job {status.lower()})")
        _clear_phase(t)
        for k in ("keep_started", "job_id", "script_warnings", "identify_skipped"):
            t.pop(k, None)
        t["status"] = "paused"
        if t.get("started") in (None, "", "—"):
            t["started"] = now
        t["ended"] = now
        t["progress"] = t.get("progress", 0)
        record_history(t, "stopped", detail=f"Stash {phase} job ended as {status}")
        changed = True
    return changed

# ── Global on/off ────────────────────────────────────────────────────────────

GLOBAL_STATE_FILE = os.path.join(PLUGIN_DIR, "global_state.json")

def _read_global_state():
    try:
        with open(GLOBAL_STATE_FILE) as f:
            return json.load(f).get("enabled", True)
    except Exception:
        return True

def _write_global_state(enabled):
    _atomic_write_json(GLOBAL_STATE_FILE, {"enabled": enabled})

# ── Default pre/post scripts (pre-filled in every new task) ──────────────────

SCRIPT_DEFAULTS_FILE = os.path.join(PLUGIN_DIR, "script_defaults.json")

def _read_script_defaults():
    try:
        with open(SCRIPT_DEFAULTS_FILE) as f:
            return _clean_scripts(json.load(f))
    except Exception:
        return _clean_scripts(None)

# ── File browser sizes ───────────────────────────────────────────────────────

SIZE_BUDGET = 30            # seconds spent measuring one selected item
NO_LOCK_ACTIONS = {"listdir", "getmtimes", "sizes",   # touch no plugin state
                   "status",                           # heartbeat read + cron repair (own retry file)
                   "media_link", "media_ping", "media_unlink"}   # their own lock (media_links.py)

def measure_size(path, budget=SIZE_BUDGET):
    """Total size of a file, or of every file under a folder (symlinks not followed).
    Stops after `budget` seconds (complete=False: the total is a lower bound), so a
    huge or slow (FUSE) tree cannot hold the call forever."""
    deadline = time.monotonic() + budget
    try:
        st = os.stat(path)
    except OSError as e:
        return {"error": str(e)}
    if not statmod.S_ISDIR(st.st_mode):
        return {"bytes": st.st_size, "files": 1, "complete": True}
    total = files = 0
    complete = True             # False once an entry could not be read
    timed_out = False
    stack = [path]
    while stack and not timed_out:
        d = stack.pop()
        try:
            with os.scandir(d) as it:
                for e in it:
                    if time.monotonic() > deadline:
                        timed_out = True
                        stack.append(d)     # folder not finished
                        break
                    try:
                        if e.is_dir(follow_symlinks=False):
                            stack.append(e.path)
                        elif e.is_file(follow_symlinks=False):
                            total += e.stat(follow_symlinks=False).st_size
                            files += 1
                    except OSError:
                        complete = False
        except OSError:
            complete = False
    return {"bytes": total, "files": files, "complete": complete and not timed_out}

def _clean_sizes(v, paths):
    """Sizes measured in the browser, kept for the task's selected paths only."""
    out = {}
    if isinstance(v, dict):
        for p in paths or []:
            s = v.get(p)
            if isinstance(s, dict) and isinstance(s.get("bytes"), (int, float)) and s["bytes"] >= 0:
                out[p] = {"bytes": int(s["bytes"]), "complete": bool(s.get("complete", True))}
    return out

# ── Preview player: temporary links served by Stash ──────────────────────────
#
# media_links.py, from the kkdepp_lib library plugin, links one file at a time into this
# plugin's media/ folder, which the manifest maps to /plugin/task_scheduler/assets/media/.
# Stash serves it behind its own login, as is (no transcoding): the preview is instant, for
# browser-playable formats only.
#
# The library sits next to this plugin's folder (plugins installed from one source share a
# parent folder). It is loaded from its file path, so an older copy of media_links.py left in
# this folder by a previous version is never picked up, and sys.path is left alone.

LIB_ID = "kkdepp_lib"
MEDIA_API_NEEDED = 1          # media_links.API_VERSION this plugin needs
_media_modules = {}

class PreviewUnavailable(Exception):
    """The library plugin is missing or too old (message is shown to the user)."""

def _media_links():
    path = os.path.join(os.path.dirname(PLUGIN_DIR), LIB_ID, "py", "media_links.py")
    if not os.path.isfile(path):
        raise PreviewUnavailable(f"the preview needs the {LIB_ID} plugin, installed next to Task Scheduler")
    mod = _media_modules.get(path)
    if mod is None:
        import importlib.util       # imported on use: the rest of the plugin works without the library
        spec = importlib.util.spec_from_file_location("kkdepp_lib_media_links", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _media_modules[path] = mod
    if getattr(mod, "API_VERSION", 0) < MEDIA_API_NEEDED:
        raise PreviewUnavailable(f"the preview needs a newer version of the {LIB_ID} plugin: update it")
    return mod

def _media():
    return _media_links().MediaLinks(PLUGIN_DIR)

def library_roots(stash):
    q = stash.call_GQL("query { configuration { general { stashes { path } } } }") or {}
    return [s.get("path") for s in ((q.get("configuration") or {}).get("general") or {}).get("stashes") or []]

def media_cleanup():
    try:
        n = _media().cleanup()
        if n:
            log.debug(f"[TaskScheduler] {n} preview link(s) removed")
    except Exception as e:
        log.debug(f"[TaskScheduler] Preview link cleanup failed: {e}")

# ── Actions API ──────────────────────────────────────────────────────────────

def handle_action(action, args, stash):
    if action == "list":
        process_queue(stash)                    # the open page also moves the queue along
        status = scheduler_status()
        note = None
        if status is None:
            note = repair_cron_if_needed()      # cron stopped: try to bring it back
        tasks = load_tasks()
        global_on = _read_global_state()
        now = _now()
        view = []
        for t in tasks:
            nr = next_run(t, now, global_on)
            view.append(dict(t, next_run=_iso(nr) if nr else None))
        return {"tasks": view, "global_enabled": global_on, "scheduler": status, "scheduler_note": note,
                "scheduler_info": scheduler_info(),
                "script_defaults": _read_script_defaults(),
                "server_time": {"now": _iso(now), "tz": now.tzname(), "offset": now.strftime("%z")}}

    elif action == "status":
        # Cheap check made from any Stash page (not only this plugin's): re-arms cron as soon
        # as someone uses Stash after a container restart
        info = scheduler_info()
        if info["status"] is None:
            info["note"] = repair_cron_if_needed()
        return info

    elif action == "tick":
        # One scheduler pass on demand, for an external trigger (host cron, systemd timer,
        # Windows Task Scheduler...) calling runPluginOperation(args: {action: "tick"}) once a
        # minute. Runs under the plugin lock, with Stash's own connection (no API key read here).
        if stash is None:
            return {"error": "Stash is not reachable"}
        busy = tick_once(stash)
        touch_heartbeat("external")
        return {"busy": busy}

    elif action == "getlog":
        # Output of the last pre/post script run of a task (for the tooltip in the list)
        phase = "post" if args.get("phase") == "post" else "pre"
        try:
            with open(os.path.join(LOGS_DIR, f"task_{int(args.get('id'))}.log"), errors="replace") as f:
                lines = f.read().splitlines()
        except Exception:
            return {"log": ""}
        head = re.compile(r"\[(pre|post)\] === ")
        start = max((i for i, l in enumerate(lines) if f"[{phase}] === " in l), default=-1)
        if start < 0:
            return {"log": ""}
        end = next((j for j in range(start + 1, len(lines)) if head.search(lines[j])), len(lines))
        return {"log": "\n".join(l[:300] for l in lines[start:end][-80:])}

    elif action == "history":
        # Run history of one task, newest first, after applying the retention setting
        tid = str(args.get("id"))
        days = history_days(stash)
        data = prune_history(days, _now())
        return {"entries": list(reversed(data.get(tid, []))), "days": days}

    elif action == "set_script_defaults":
        sc = _clean_scripts(args.get("scripts"))
        _atomic_write_json(SCRIPT_DEFAULTS_FILE, sc)
        return {"ok": True, "scripts": sc}

    elif action == "create":
        tasks = load_tasks()
        new_id = max((t.get("id", 0) for t in tasks), default=0) + 1
        task = {
            "id": new_id,
            "name": args.get("name") or next_task_name(tasks),
            "type": "Path Scan",
            "status": "pending",
            "enabled": True,
            "paths": args.get("paths", []),
            "options": args.get("options", {
                "covers":          True,
                "previews":        True,
                "animPreviews":    False,
                "sprites":         False,
                "phashes":         True,
                "imgThumbs":       True,
                "imgPhashes":      False,
                "imgClipPreviews": False,
                "rescan":          False,
            }),
            "schedule": {
                "type": args.get("schedule_type", "manual"),
                "time": args.get("schedule_time", ""),
                "at":   args.get("schedule_at",   "") if args.get("schedule_type", "manual") == "once" else "",
                "days": args.get("schedule_days", []),
            },
            "scripts": _clean_scripts(args.get("scripts")),
            "identify": _clean_identify(args.get("identify")),
            "sizes": _clean_sizes(args.get("sizes"), args.get("paths", [])),
            "started": "—",
            "ended":   "—",
        }
        tasks.append(task)
        save_tasks(tasks)
        return {"task": task}

    elif action == "update":
        tid = args.get("id")
        if tid is None:
            return {"error": "missing id"}
        tasks = load_tasks()
        for t in tasks:
            if t.get("id") == tid:
                before = _run_definition(t)
                if "name"     in args: t["name"]    = args["name"]
                if "paths"    in args: t["paths"]   = args["paths"]
                if "enabled"  in args: t["enabled"] = args["enabled"]
                if "options"  in args: t["options"] = args["options"]
                if "scripts"  in args: t["scripts"] = _clean_scripts(args["scripts"])
                if "identify" in args: t["identify"] = _clean_identify(args["identify"])
                if "sizes" in args or "paths" in args:
                    t["sizes"] = _clean_sizes(args.get("sizes", t.get("sizes")), t.get("paths"))
                if "schedule_type" in args:
                    sc = t.setdefault("schedule", {})
                    sc["type"] = args["schedule_type"]
                    sc["time"] = args.get("schedule_time", sc.get("time", ""))
                    sc["at"]   = args.get("schedule_at",   sc.get("at",   ""))
                    sc["days"] = args.get("schedule_days", sc.get("days", []))
                    if sc["type"] != "once":
                        sc["at"] = ""         # a date only makes sense for a one-time task
                    t.pop("last_slot", None)
                    if t.get("status") == "missed":
                        t["status"] = "pending"   # a new schedule starts afresh
                        t.pop("missed_at", None)
                        t.pop("missed_reason", None)
                    # A task turned into a scheduled one must leave the manual queue
                    # (it has not been handed to Stash yet): its planned time prevails.
                    if sc["type"] != "manual" and is_waiting_task(t):
                        t["status"] = "pending"
                if _run_definition(t) != before:
                    reset_after_edit(t)
                save_tasks(tasks)
                return {"task": t}
        return {"error": f"task {tid} not found"}

    elif action == "move":
        # Reorder manual (non-scheduled) tasks: swap with the previous/next manual task.
        # Anything that has not been pushed to Stash yet can move, including queued tasks.
        tid = args.get("id")
        tasks = load_tasks()
        idx = next((i for i, t in enumerate(tasks) if t.get("id") == tid), None)
        if idx is None:
            return {"error": f"task {tid} not found"}
        if not is_manual_task(tasks[idx]):
            return {"error": "only manual tasks can be reordered"}
        step = -1 if args.get("direction") == "up" else 1
        j = idx + step
        while 0 <= j < len(tasks) and not is_manual_task(tasks[j]):
            j += step
        if not (0 <= j < len(tasks)):
            return {"ok": True}
        if is_active_task(tasks[idx]) or is_active_task(tasks[j]):
            return {"error": "a task that has already started cannot be moved"}
        tasks[idx], tasks[j] = tasks[j], tasks[idx]
        save_tasks(tasks)
        return {"ok": True}

    elif action == "delete":
        tid = args.get("id")
        tasks = load_tasks()
        for t in tasks:
            if t.get("id") == tid and is_script_phase(t):
                kill_scripts(t)                 # never leave a script running for a deleted task
        tasks = [t for t in tasks if t.get("id") != tid]
        save_tasks(tasks)
        remove_task_files(tid)
        hist = _read_history()
        if hist.pop(str(tid), None) is not None:
            _write_history(hist)
        return {"ok": True}

    elif action == "run":
        tid = args.get("id")
        tasks = load_tasks()
        for t in tasks:
            if t.get("id") == tid:
                if not is_manual_task(t):
                    return {"error": "scheduled task: it starts only at its planned time"}
                if t.get("status") in ("running", "queued"):
                    return {"error": "already running"}
                enqueue_task(t)
                save_tasks(tasks)
                process_queue(stash)            # starts right away when nothing else is running
                return {"ok": True}
        return {"error": f"task {tid} not found"}

    elif action == "run_all":
        # Put every manual task in the plugin queue, in list order. They are
        # pushed to Stash one at a time, in that order.
        tasks = load_tasks()
        queued = 0
        for t in tasks:
            if not is_manual_task(t) or t.get("status") in ("running", "queued"):
                continue
            if not t.get("paths"):
                continue
            enqueue_task(t, "run_all")
            queued += 1
        save_tasks(tasks)
        process_queue(stash)
        return {"ok": True, "queued": queued}

    elif action == "stop":
        tid = args.get("id")
        tasks = load_tasks()
        for t in tasks:
            if t.get("id") == tid:
                if t["status"] not in ("running", "queued"):
                    return {"error": "not running"}
                if t.get("job_id") and stash is not None:
                    try:
                        stash.call_GQL(
                            "mutation StopJob($job_id: ID!) { stopJob(job_id: $job_id) }",
                            {"job_id": t["job_id"]},
                        )
                    except Exception as e:
                        log.error(f"[TaskScheduler] Could not stop job {t['job_id']}: {e}")
                if is_script_phase(t):
                    kill_scripts(t)
                if t.get("started") not in (None, "", "—"):
                    phase_end(t, t.get("phase") or "scan", "warn", "Stopped from the Task Scheduler page")
                else:
                    add_event(t, "warn", "Removed from the queue before it started")
                _clear_phase(t)
                for k in ("keep_started", "job_id", "script_warnings", "identify_skipped"):
                    t.pop(k, None)
                t["status"] = "paused"
                t["ended"]  = _now_str()
                record_history(t, "stopped", detail="Stopped from the Task Scheduler page"
                               if t.get("started") not in (None, "", "—") else "Removed from the queue before it started")
                save_tasks(tasks)
                process_queue(stash)            # let the next waiting task start
                return {"ok": True}
        return {"error": f"task {tid} not found"}

    elif action == "toggle_global":
        current = _read_global_state()
        _write_global_state(not current)
        return {"global_enabled": not current}

    elif action == "set_global":
        enabled = bool(args.get("enabled", True))
        _write_global_state(enabled)
        return {"global_enabled": enabled}

    elif action == "listdir":
        # Folders and files of a path with their mtime, plus the size of files: the same
        # stat() call returns it (folder sizes need a walk, measured on selection only)
        path = args.get("path") or "/"
        try:
            entries = []
            with os.scandir(path) as it:
                for e in it:
                    try:
                        is_dir = e.is_dir()
                    except OSError:
                        is_dir = False
                    try:
                        st = e.stat()
                        mtime, size = st.st_mtime, (None if is_dir else st.st_size)
                    except OSError:
                        mtime, size = 0, None
                    item = {"path": e.path, "name": e.name, "dir": is_dir, "mtime": mtime}
                    if size is not None:
                        item["size"] = size
                    entries.append(item)
            return {"entries": entries}
        except Exception as e:
            return {"error": str(e), "entries": []}

    elif action == "sizes":
        return {"size": measure_size(str(args.get("path") or ""))}

    elif action == "media_link":
        try:
            if stash is None:
                return {"error": "Stash is not reachable"}
            name = _media().create(args.get("path"), library_roots(stash))
            return {"name": name}
        except Exception as e:
            known = isinstance(e, PreviewUnavailable) or type(e).__name__ == "MediaLinkError"
            if not known:
                log.error(f"[TaskScheduler] Could not prepare the preview: {e}")
            return {"error": str(e) if known else f"could not prepare the preview: {e}"}

    elif action == "media_ping":
        try:
            return {"ok": _media().ping(str(args.get("name") or ""))}
        except Exception as e:
            return {"error": str(e)}

    elif action == "media_unlink":
        try:
            _media().remove(str(args.get("name") or ""))
            return {"ok": True}
        except Exception as e:
            return {"error": str(e)}

    elif action == "getmtimes":
        # Modification times of a list of paths
        import os as _os
        paths = args.get("paths", [])
        mtimes = {}
        for p in paths:
            try:
                mtimes[p] = _os.path.getmtime(p)
            except Exception:
                mtimes[p] = 0
        return {"mtimes": mtimes}

    else:
        return {"error": f"unknown action: {action}"}

# ── Stash entrypoint ─────────────────────────────────────────────────────────

def main():
    if "--run-scripts" in sys.argv:
        i = sys.argv.index("--run-scripts")
        sys.exit(run_scripts_main(int(sys.argv[i + 1]), sys.argv[i + 2]))
    if "--tick" in sys.argv:
        sys.exit(tick_main())
    if "--ensure-cron" in sys.argv:
        print(ensure_cron())
        return

    # Stash passes args via stdin (JSON)
    raw = sys.stdin.read().strip()
    try:
        plugin_input = json.loads(raw) if raw else {}
    except Exception:
        plugin_input = {}

    server_connection = plugin_input.get("server_connection", {})
    args = plugin_input.get("args", {})
    # The frontend serializes all its args as JSON under the "request" key
    if "request" in args:
        try:
            args = json.loads(args["request"])
        except Exception:
            pass
    action = args.get("action", "list")

    try:
        stash = StashInterface(server_connection)
    except Exception as e:
        log.error(f"StashInterface: {e}")
        stash = None

    if action in NO_LOCK_ACTIONS:
        result = handle_action(action, args, stash)    # read-only filesystem calls: never delay the scheduler
    else:
        with plugin_lock():
            result = handle_action(action, args, stash)
    # Stash reads {"output": ...} from stdout for raw plugins
    print(json.dumps({"output": result}))

if __name__ == "__main__":
    main()
