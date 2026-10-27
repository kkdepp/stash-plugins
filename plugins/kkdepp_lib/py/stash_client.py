"""Minimal Stash GraphQL client and plugin logger, standard library only.

Part of the kkdepp_lib library plugin: lets a Python plugin talk to Stash without the
stashapp-tools package. A plugin loads it by file path from the library's py/ folder (see
media_links.py for the pattern) and checks API_VERSION.

    client = stash_client.StashClient(plugin_input["server_connection"])
    data = client.call_GQL("query { version { version } }")
    stash_client.log.info("message")      # shown in Stash's log

Connection fields (the plugin input's server_connection, or a dict built by the plugin):
Scheme, Host, Port, SessionCookie {Name, Value} (the user's session, for plugin calls) and an
API key (only for code running outside a plugin call, such as the task_scheduler cron tick:
the documented exception, see the repository's CLAUDE.md). Keys are matched case-insensitively.
A host listening on all interfaces is reached through the loopback address.

API_VERSION grows by one with each backward-compatible addition.
"""

import json
import sys
import urllib.error
import urllib.request

API_VERSION = 1

TIMEOUT = 120               # seconds per request
LOG_PAYLOAD_MAX = 64000     # Stash reads log lines through a 64 KiB buffer


class StashError(Exception):
    """A request Stash refused or could not answer (message is safe to log: no credentials)."""


class StashLog(object):
    """Writes log lines in Stash's plugin format: SOH, level letter, STX, message, on stderr."""

    LEVELS = {"trace": "t", "debug": "d", "info": "i", "warning": "w", "error": "e"}

    def _write(self, level, message):
        if not isinstance(message, str):
            message = json.dumps(message) if isinstance(message, dict) else str(message)
        for line in message.split("\n"):
            sys.stderr.write(f"\x01{level}\x02{line[:LOG_PAYLOAD_MAX]}\n")
        sys.stderr.flush()

    def trace(self, m):   self._write("t", m)
    def debug(self, m):   self._write("d", m)
    def info(self, m):    self._write("i", m)
    def warning(self, m): self._write("w", m)
    def error(self, m):   self._write("e", m)

    def progress(self, p):
        """Task progress, 0..1."""
        self._write("p", str(min(max(0.0, float(p)), 1.0)))


log = StashLog()


def _get(conn, key, default=None):
    for k, v in (conn or {}).items():
        if isinstance(k, str) and k.lower() == key.lower():
            return v
    return default


class StashClient(object):
    """GraphQL client for one Stash instance."""

    def __init__(self, conn=None, timeout=TIMEOUT, check=True):
        scheme = _get(conn, "Scheme") or "http"
        host = _get(conn, "Host") or "localhost"  # lint:allow-external (default of Stash's own connection)
        if host == "0.0.0.0":  # lint:allow-external (all interfaces: reach it through loopback)
            host = "127.0.0.1"  # lint:allow-external
        port = _get(conn, "Port") or 9999
        self.url = f"{scheme}://{host}:{port}/graphql"
        self.timeout = timeout
        self.headers = {"Content-Type": "application/json", "Accept": "application/json"}
        key = _get(conn, "ApiKey")  # lint:allow-external (cron tick only, see module docstring)
        if key:
            self.headers["ApiKey"] = key  # lint:allow-external
        cookie = _get(conn, "SessionCookie")
        if isinstance(cookie, dict) and cookie.get("Value"):
            self.headers["Cookie"] = f"{cookie.get('Name') or 'session'}={cookie['Value']}"
        self.version = None
        if check:
            self.version = ((self.call_GQL("query { version { version } }") or {}).get("version") or {}).get("version")

    def call_GQL(self, query, variables=None):
        """Run a query or mutation; returns its data. Raises StashError on any error."""
        body = {"query": query}
        if variables:
            body["variables"] = variables
        req = urllib.request.Request(self.url, data=json.dumps(body).encode("utf-8"),
                                     headers=self.headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            raw = e.read() if hasattr(e, "read") else b""
            if e.code == 401:
                raise StashError(f"Stash refused the request (401 {e.reason}): not logged in or wrong API key")
            if not raw:
                raise StashError(f"Stash answered {e.code} {e.reason}")
        except urllib.error.URLError as e:
            raise StashError(f"Stash is not reachable at {self.url}: {e.reason}")
        except OSError as e:
            raise StashError(f"Stash is not reachable at {self.url}: {e}")
        try:
            content = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            raise StashError("Stash answered with something that is not JSON")
        errors = content.get("errors") or []
        if errors:
            msg = "; ".join(str(e.get("message", e))[:2500] for e in errors)
            raise StashError(f"GraphQL error: {msg}")
        if content.get("data") is None:
            raise StashError("Stash answered with no data")
        return content["data"]

    def metadata_scan(self, paths, flags=None):
        """Start a scan of `paths` with the given ScanMetadataInput flags; returns the job id."""
        scan_input = {"paths": list(paths)}
        scan_input.update(flags or {})
        data = self.call_GQL("mutation MetadataScan($input: ScanMetadataInput!) { metadataScan(input: $input) }",
                             {"input": scan_input})
        return data["metadataScan"]
