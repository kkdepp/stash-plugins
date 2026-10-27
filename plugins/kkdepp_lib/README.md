# kkdepp_lib

Shared code for the kkdepp Stash plugins. It has no task, no setting and no page of its own: it is installed
together with the plugins that need it (Stash does so automatically when they come from the same plugin source)
and must stay installed and enabled while they are.

Tested on Stash v0.31.x. See [CHANGELOG.md](CHANGELOG.md).

## Contents

| File | For | What it does |
|------|-----|--------------|
| `media-player.js` | browser | Full-screen preview player for videos and images: `window.stashPluginsShared.mediaPlayer.open(...)`. Plays what the browser can decode, without transcoding. |
| `py/media_links.py` | Python backends | Temporary symbolic links to single files, served behind Stash's login through a plugin's `ui.assets`, so the player can stream them. |
| `py/stash_client.py` | Python backends | Minimal GraphQL client (`StashClient(server_connection).call_GQL(...)`) and logger in Stash's plugin format (`log.info(...)`), standard library only: plugins need no `stashapp-tools`. |

Each file documents its API at the top.

## Using it from a plugin

In the plugin's manifest:

```yaml
# requires: kkdepp_lib
ui:
  requires:
    - kkdepp_lib
```

The `# requires:` comment lets the source index install the library with the plugin; `ui.requires` makes Stash
load the library's JavaScript first. Python code loads modules by file path from `../kkdepp_lib/py` (see the
top of `py/media_links.py`) and checks `API_VERSION`.

## Limitations

Made for Stash on Linux (including the official Docker image) and macOS:

- `media_links.py` previews files through **symbolic links**. On Windows, creating them needs administrator
  rights or Developer Mode, so the preview may fail there.
- Its lock relies on `fcntl`, which Windows does not have: there the lock does nothing, and two previews
  started at the same moment could race on the link list.

## Manual installation

Copy this folder into Stash's plugins directory **next to** the plugins that use it (same parent folder), then
Settings > Plugins > **Reload plugins**.

## Compatibility

Updates keep the existing functions working: plugins check `API_VERSION` (Python) or the player's `version`
(JavaScript) and ask for an update of this library when it is too old. A breaking change would get a new major
version.

## License

GNU General Public License v3.0 or later: see the repository's [LICENSE](../../LICENSE).
