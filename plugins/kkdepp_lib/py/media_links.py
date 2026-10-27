"""Temporary links that let the browser play a file through Stash's plugin assets route.

Part of the kkdepp_lib library plugin. A plugin loads it by file path from the library's py/
folder, found next to its own folder (plugins installed from one source sit side by side), so
that an older copy left in its own folder is never picked up and sys.path is left alone; then it
checks API_VERSION:

    path = os.path.join(os.path.dirname(PLUGIN_DIR), "kkdepp_lib", "py", "media_links.py")
    spec = importlib.util.spec_from_file_location("kkdepp_lib_media_links", path)
    media_links = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(media_links)
    if media_links.API_VERSION < NEEDED: ...      # ask for a kkdepp_lib update

API_VERSION grows by one with each backward-compatible addition; a breaking change needs a new
major version of kkdepp_lib.

A plugin maps a folder of its own to /plugin/<plugin-id>/assets/media/ in its manifest:

    ui:
      assets:
        "/media": media        # leading slash required (Stash v0.31)

For each file played, a symbolic link to that one file is created in that folder under a
random, unguessable name. It is removed when the player closes, or by a cleanup pass once
the player has stopped checking in. Stash serves it like any plugin asset: behind Stash's
own login, with HTTP Range (seeking) support, without transcoding.

Rules kept here:
  - only links to regular files are created, never to folders: Stash's plugin loader follows
    links to folders (it would walk the library looking for .yml files);
  - only files under one of the given library roots, with a browser-playable extension;
  - removing a link never touches the file it points to: only symbolic links are unlinked.
"""

import json
import os
import re
import secrets
import stat as statmod
import time

try:
    import fcntl
except ImportError:      # not available outside Linux/macOS (tests only)
    fcntl = None

API_VERSION = 1

VIDEO_EXT = ("mp4", "m4v", "webm", "mov")
IMAGE_EXT = ("jpg", "jpeg", "png", "gif", "webp", "avif")
PLAYABLE_EXT = VIDEO_EXT + IMAGE_EXT
STALE_SECONDS = 600      # a link whose player has not checked in for this long is removed
MAX_LINKS = 20           # oldest links are removed beyond this
_NAME = re.compile(r"^[A-Za-z0-9_-]{20,64}\.(%s)$" % "|".join(PLAYABLE_EXT))


class MediaLinkError(Exception):
    """A file that may not be linked (message is shown to the user)."""


def extension(path):
    name = os.path.basename(path)
    return name.rsplit(".", 1)[1].lower() if "." in name else ""


def is_playable(path):
    return extension(path) in PLAYABLE_EXT


def _under(path, root):
    root = os.path.normpath(root)
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


class MediaLinks(object):
    def __init__(self, plugin_dir, folder="media"):
        self.dir = os.path.join(plugin_dir, folder)
        self.state_file = os.path.join(plugin_dir, ".media_links.json")   # outside the served folder
        self.lock_file = os.path.join(plugin_dir, ".media_links.lock")

    # ── state (serialised by a lock of its own) ─────────────────────────────────

    def _locked(self):
        f = open(self.lock_file, "w")
        if fcntl:
            fcntl.flock(f, fcntl.LOCK_EX)
        return f

    def _read(self):
        try:
            with open(self.state_file) as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _write(self, data):
        tmp = self.state_file + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, self.state_file)

    def _unlink(self, name):
        """Remove one link of the served folder. Anything that is not a symbolic link is left alone."""
        if not _NAME.match(name or ""):
            return
        p = os.path.join(self.dir, name)
        if os.path.islink(p):
            os.unlink(p)

    # ── public API ──────────────────────────────────────────────────────────────

    def create(self, path, roots, now=None):
        """Link one file; returns the link's name (served as <assets>/media/<name>)."""
        now = time.time() if now is None else now
        if not isinstance(path, str) or not path.startswith("/") or "\0" in path:
            raise MediaLinkError("invalid path")
        path = os.path.normpath(path)
        ext = extension(path)
        if ext not in PLAYABLE_EXT:
            raise MediaLinkError("this format cannot be previewed in a browser")
        if not any(_under(path, r) for r in roots or [] if isinstance(r, str) and r.startswith("/")):
            raise MediaLinkError("only files inside a Stash library path can be previewed")
        try:
            st = os.stat(path)                       # follows links: the file itself
        except OSError as e:
            raise MediaLinkError(f"file not readable ({e.strerror or e})")
        if not statmod.S_ISREG(st.st_mode):
            raise MediaLinkError("not a regular file")
        if os.path.islink(self.dir) or (os.path.exists(self.dir) and not os.path.isdir(self.dir)):
            raise MediaLinkError("the plugin's media folder is not a plain folder")
        os.makedirs(self.dir, exist_ok=True)
        name = secrets.token_urlsafe(24) + "." + ext
        lock = self._locked()
        try:
            data = self._read()
            os.symlink(path, os.path.join(self.dir, name))
            data[name] = {"path": path, "created": now, "seen": now}
            for old in sorted(data, key=lambda k: data[k].get("seen", 0))[:-MAX_LINKS]:
                self._unlink(old)
                data.pop(old, None)
            self._write(data)
        finally:
            lock.close()
        return name

    def ping(self, name, now=None):
        """The player still shows this link. False when it is gone."""
        lock = self._locked()
        try:
            data = self._read()
            if name not in data:
                return False
            data[name]["seen"] = time.time() if now is None else now
            self._write(data)
            return True
        finally:
            lock.close()

    def remove(self, name):
        lock = self._locked()
        try:
            data = self._read()
            self._unlink(name)
            if data.pop(name, None) is not None:
                self._write(data)
        finally:
            lock.close()

    def cleanup(self, now=None, stale=STALE_SECONDS):
        """Remove links not seen for `stale` seconds, and stray links the state does not know.
        Returns the number of links removed."""
        now = time.time() if now is None else now
        lock = self._locked()
        removed = 0
        try:
            data = self._read()
            for name in [k for k, v in data.items() if now - (v.get("seen") or 0) > stale]:
                self._unlink(name)
                data.pop(name)
                removed += 1
            if os.path.isdir(self.dir) and not os.path.islink(self.dir):
                with os.scandir(self.dir) as it:
                    for e in it:
                        if e.name not in data and _NAME.match(e.name) and e.is_symlink():
                            self._unlink(e.name)
                            removed += 1
            if removed:
                self._write(data)
        finally:
            lock.close()
        return removed
