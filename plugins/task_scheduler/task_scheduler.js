/**
 * Task Scheduler — Stash plugin frontend (ES5)
 * Redesigned UI: table + two-step wizard + breadcrumb browser
 */
(function () {
  'use strict';

  var PLUGIN_ID = 'task_scheduler';
  var POLL_INTERVAL = 5000;
  // Preview player (kkdepp_lib plugin, media-player.js): files linked one at a time into the plugin's
  // media/ folder, served by Stash at this path (manifest: ui.assets), played as is
  var MEDIA_URL = '/plugin/' + PLUGIN_ID + '/assets/media/';
  var PREVIEW_EXT = { mp4: 'video', m4v: 'video', webm: 'video', mov: 'video',
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', avif: 'image' };

  // ── Scan options (9 options matching Stash native UI) ──────────────────────
  var SCAN_OPTS = [
    { key: 'covers',          label: 'Generate scene covers',             def: true  },
    { key: 'previews',        label: 'Generate previews',                 def: true  },
    { key: 'animPreviews',    label: 'Generate animated image previews',  def: false },
    { key: 'sprites',         label: 'Generate scrubber sprites',         def: false },
    { key: 'phashes',         label: 'Generate video perceptual hashes',  def: true  },
    { key: 'imgThumbs',       label: 'Generate thumbnails for images',    def: true  },
    { key: 'imgPhashes',      label: 'Generate image perceptual hashes',  def: false },
    { key: 'imgClipPreviews', label: 'Generate previews for image clips', def: false },
    { key: 'rescan',          label: 'Rescan files',                      def: false },
  ];

  var ALL_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // ── State ──────────────────────────────────────────────────────────────────
  var state = {
    tasks: [],
    globalEnabled: true,
    scheduler: undefined, // 'cron' (a cron pass ran recently) | null (stopped) | undefined (unknown)
    schedulerNote: null,  // what the plugin did/tried to restart cron
    loadError: null,      // last failed 'list' call (the table keeps the last known tasks)
    serverTime: null,     // Stash's clock from 'list': { now, tz: 'CET', offset: '+0100' }
    pollTimer: null,
    hist: null,           // open history modal: { id, head, foot, active (a current run is shown), gen }
    // Browser state
    browserPath: '/',
    browserEntries: [],   // current listing [{path, name, dir, mtime}]
    browserError: null,
    browserLoading: false,
    rowPaths: [],         // paths of the rows on screen (onclick handlers refer to them by index)
    crumbs: [],           // breadcrumb targets, same idea
    sort: 'name',         // 'name' | 'date' | 'size' (folders always come first)
    sortDir: 1,           // 1=asc -1=desc
    filter: '',
    bf: defaultBrowserFilters(),   // Date / Size / In stash filters, kept while browsing
    sizes: {},            // path -> {bytes, complete} | {loading} | {error}; kept for the page session
    sizeQueue: [],        // selected paths waiting to be measured (one at a time)
    sizeBusy: false,
    stashKnown: {},       // path -> true | false (scene/image files in Stash under it) | null (not checked)
    stashListing: {},     // In-stash check of the open folder: {dir, loading, error}
    stashSizes: {},       // path -> {bytes, files} | {loading} | {error}; measured on selection
    stashQueue: [],
    stashBusy: false,
    taskFilter: 'all',   // 'all' | 'active' | 'manual' | 'scheduled' (display only)
    expandedPaths: {},    // task id -> true when its full path list is unfolded in the table
    selectedPaths: [],    // paths selected for scan (folders or files)
    // Wizard state
    wizardStep: 1,        // 1-4 (0: the script defaults dialog)
    editingId: null,
    taskName: '',
    schedType: 'manual',
    schedTime: '02:00',
    schedAt: '',
    schedDays: [],
    scanOpts: {},
    identify: { enabled: false, sources: [] },   // sources in the order Stash tries them
    idCatalog: null,      // {loading} | {error} | {boxes, scrapers, defaults, overwrite} from Stash
    idFilter: '',
    idRows: [],           // sources of the "Available" rows on screen (onclick refers to them by index)
    // Delete confirm
    deleteTargetId: null,
    deleteTargetName: '',
  };

  function defaultBrowserFilters() {
    return { dateOp: 'any', date1: '', date2: '', sizeOp: 'any', size1: '', size2: '', unit: 'GB', stash: 'all' };
  }

  function defaultScanOpts() {
    var o = {};
    SCAN_OPTS.forEach(function (s) { o[s.key] = s.def; });
    return o;
  }

  var knownPaths = [];

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Backend dates carry their offset ("2026-10-25T10:29+01:00"). Values written
  // before 1.1.0 have none and are Stash's local time (state.serverTime.offset).
  function parseServerDate(s) {
    if (!s || s === '—') return null;
    var v = String(s).trim().replace(' ', 'T');
    var off = state.serverTime && state.serverTime.offset;
    if (!/(Z|[+-]\d\d:?\d\d)$/i.test(v) && /^[+-]\d{4}$/.test(off || '')) {
      v += off.slice(0, 3) + ':' + off.slice(3);
    }
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  // Shown in the browser's time zone
  function fmtDate(s) {
    var d = parseServerDate(s);
    return d ? fmtLocal(d) : '—';
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtLocal(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // datetime-local input value (browser time) <-> exact instant for the backend
  function toInputLocal(d) { return d ? fmtLocal(d).replace(' ', 'T') : ''; }

  function localInputToIso(v) {
    if (!v) return '';
    var d = new Date(v);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  }

  // Daily/weekly times are Stash's wall clock: say so when the browser is in another zone
  function stashTimeNote() {
    var st = state.serverTime;
    if (!st || !/^[+-]\d{4}$/.test(st.offset || '')) return '';
    var srv = (st.offset.charAt(0) === '-' ? -1 : 1) *
      (parseInt(st.offset.slice(1, 3), 10) * 60 + parseInt(st.offset.slice(3), 10));
    return srv === -new Date().getTimezoneOffset() ? '' : ' (Stash time ' + (st.tz || st.offset) + ')';
  }

  // Next planned execution as a Date, or null; computed by the backend in Stash's time
  function nextRun(t) {
    return parseServerDate(t.next_run);
  }

  function missedTip(t) {
    return 'Missed run of ' + fmtDate(t.missed_at) + (t.missed_reason ? ' (' + t.missed_reason + ')' : '');
  }

  function basename(p) {
    return p.replace(/\/$/, '').split('/').pop() || p;
  }

  function schedLabel(sc) {
    if (!sc || sc.type === 'manual') return 'Manual';
    if (sc.type === 'daily')  return 'Daily ' + (sc.time || '') + stashTimeNote();
    if (sc.type === 'weekly') return (sc.days || []).join(', ') + ' ' + (sc.time || '') + stashTimeNote();
    if (sc.type === 'once')   return 'Once ' + fmtDate(sc.at);
    return 'Manual';
  }

  // ── GQL / API ────────────────────────────────────────────────────────────────

  function gql(query, variables) {
    return fetch('/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, variables: variables || {} }),
    }).then(function (r) { return r.json(); })
      .then(function (r) {
        if (r.errors && r.errors.length) throw new Error(r.errors[0].message);
        return r.data;
      });
  }

  function callApi(args) {
    // runPluginOperation runs immediately and returns the script output
    // (runPluginTask only returns a job id)
    return gql(
      'mutation Op($id:ID!,$a:Map){runPluginOperation(plugin_id:$id,args:$a)}',
      { id: PLUGIN_ID, a: { mode: 'api', request: JSON.stringify(args) } }
    ).then(function (data) {
      var raw = data && data.runPluginOperation;
      window.__tsLastApi = { args: args, raw: raw };
      if (raw && typeof raw === 'object') return raw;
      if (typeof raw === 'string') {
        try { var o = JSON.parse(raw); if (o && typeof o === 'object') return o; } catch (_) {}
      }
      window.__tsLastErr = 'Unexpected response: ' + JSON.stringify(raw);
      return { _tsError: window.__tsLastErr };
    }).catch(function (e) {
      window.__tsLastErr = 'GQL error: ' + (e && e.message ? e.message : e);
      return { _tsError: window.__tsLastErr };
    });
  }

  function loadLibraryPaths() {
    return gql('{ configuration { general { stashes { path } } } }').then(function (d) {
      var stashes = (d && d.configuration && d.configuration.general && d.configuration.general.stashes) || [];
      knownPaths = stashes.map(function (s) { return s.path; });
    }).catch(function () { knownPaths = []; });
  }

  // ── Polling ──────────────────────────────────────────────────────────────────

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(refresh, POLL_INTERVAL);
  }

  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  var _refreshGen = 0;

  function refresh() {
    var gen = ++_refreshGen;
    callApi({ action: 'list' }).then(function (res) {
      if (gen !== _refreshGen) return; // discard stale polling response
      if (!Array.isArray(res.tasks)) {
        // Failed call (e.g. Stash could not start the backend): keep the last known list
        state.loadError = res._tsError || res.error || 'Unexpected response from the plugin backend';
        renderLoadError();
        return;
      }
      state.loadError = null;
      renderLoadError();
      if (res.server_time) state.serverTime = res.server_time;
      state.tasks = res.tasks;
      state.globalEnabled = res.global_enabled !== false;
      state.scheduler = res.scheduler === undefined ? undefined : res.scheduler;
      if (res.scheduler_note) state.schedulerNote = res.scheduler_note;
      if (res.scheduler_info) state.schedulerInfo = res.scheduler_info;
      if (res.script_defaults) state.scriptDefaults = res.script_defaults;
      renderTable();
      renderGlobalToggle();
      updateHistoryLive();
    });
  }

  // ── Auto task name ────────────────────────────────────────────────────────────

  function nextTaskName() {
    var nums = [];
    state.tasks.forEach(function (t) {
      if (t.name && t.name.indexOf('Task ') === 0) {
        var n = parseInt(t.name.slice(5), 10);
        if (!isNaN(n)) nums.push(n);
      }
    });
    var max = nums.length ? Math.max.apply(null, nums) : 0;
    var next = max + 1;
    return 'Task ' + (next < 10 ? '0' + next : '' + next);
  }

  // ── Browser loading ─────────────────────────────────────────────────────────

  var _browseGen = 0;

  // Folders and files come from the backend (Stash's directory query lists folders only)
  // `focus`: an entry of `path` to scroll to and highlight once listed
  function loadBrowserDir(path, focus) {
    var gen = ++_browseGen;
    state.focusPath = focus || null;
    state.browserLoading = true;
    state.browserPath = path;
    state.browserError = null;
    state.filter = '';
    var fi = document.getElementById('ts-filter-input');
    if (fi) fi.value = '';
    renderBrowser();
    callApi({ action: 'listdir', path: path }).then(function (res) {
      if (gen !== _browseGen) return;   // the user already went elsewhere
      state.browserLoading = false;
      state.browserEntries = Array.isArray(res.entries) ? res.entries : [];
      state.browserError = res._tsError || res.error || null;
      // File sizes come with the listing (folders are still measured on selection)
      state.browserEntries.forEach(function (e) {
        var s = state.sizes[e.path];
        if (!e.dir && typeof e.size === 'number' && !(s && s.loading)) state.sizes[e.path] = { bytes: e.size, complete: true };
      });
      renderBrowser();
      if (!state.browserError) loadStashKnown(path);
      if (state.focusPath) {
        var row = document.querySelector('#ts-browser-rows .ts-dir-row.focus');
        if (row) row.scrollIntoView({ block: 'center' });
        state.focusPath = null;
      }
    });
  }

  // ── Sizes (measured only for selected items, then cached) ────────────────────

  function fmtBytes(b) {
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i ? b.toFixed(b < 10 ? 2 : 1) : String(b)) + ' ' + u[i];
  }

  function sizeHtml(p) {
    var s = state.sizes[p];
    if (!s) return '';
    if (s.loading) return '<span class="ts-spinner ts-spinner-sm" title="Measuring…"></span>';
    if (s.error) return '<span title="' + esc(s.error) + '">?</span>';
    return '<span title="' + (s.complete ? '' : 'Partial total: measuring stopped after ' + 30 + ' s') + '">' +
      (s.complete ? '' : '≥ ') + esc(fmtBytes(s.bytes)) + '</span>';
  }

  // "Total 12.4 GB" for a list of paths; "≥" when some size is partial or unknown
  function sizeTotal(paths) {
    var sum = 0, known = 0, pending = 0, partial = false;
    paths.forEach(function (p) {
      var s = state.sizes[p];
      if (s && s.loading) { pending++; return; }
      if (!s || typeof s.bytes !== 'number') { partial = true; return; }
      sum += s.bytes; known++;
      if (!s.complete) partial = true;
    });
    if (!known) return pending ? 'Total: measuring…' : '';
    return 'Total ' + (partial || pending ? '≥ ' : '') + fmtBytes(sum) + (pending ? ' (measuring…)' : '');
  }

  function requestSize(p) {
    var s = state.sizes[p];
    if (s && !s.error) return;            // cached or already queued
    state.sizes[p] = { loading: true };
    state.sizeQueue.push(p);
    pumpSizes();
  }

  // One measurement at a time: a slow mount is not hit by several walks at once
  function pumpSizes() {
    if (state.sizeBusy || !state.sizeQueue.length) return;
    state.sizeBusy = true;
    var p = state.sizeQueue.shift();
    callApi({ action: 'sizes', path: p }).then(function (res) {
      var r = res && res.size;
      state.sizes[p] = r && typeof r.bytes === 'number'
        ? { bytes: r.bytes, complete: !!r.complete }
        : { error: (r && r.error) || res._tsError || res.error || 'could not measure' };
      state.sizeBusy = false;
      renderSizes();
      pumpSizes();
    });
  }

  function renderSizes() {
    if (state.wizardStep === 1) renderBrowserBody();
    var s2 = document.getElementById('ts-s2-paths');
    if (s2 && state.wizardStep === 2) s2.innerHTML = buildStep2Paths();
  }

  // ── In Stash: scene / image files Stash knows under a path ───────────────────
  // Only exact folder-tree filters are used. In Stash 0.31.1, `path` INCLUDES splits the
  // value on spaces, findFolders ignores `files_filter` and findFiles ignores `file_filter`
  // when `ids` is given (see docs/stash-api-notes.md).

  // Each sub-folder gets its own count (Stash answers a number, not a file list):
  // ~1 s for 996 sub-folders with 740k files below them (live, 2026-10-25)
  var STASH_BATCH = 100;          // folders looked up / counted per GraphQL request
  var _stashGen = 0;             // bumped when the wizard opens (Stash data may have changed)

  // File filter "scene file OR image file", each side ANDed with `extra`
  function knownFilter(extra) {
    return '{' + extra + ',scene_count:{value:0,modifier:GREATER_THAN},OR:{' + extra +
      ',image_count:{value:0,modifier:GREATER_THAN}}}';
  }

  // Files in these folders (depth 0) or anywhere below them (depth -1)
  function underFolders(ids, depth) {
    return 'parent_folder:{value:' + JSON.stringify(ids.map(String)) + ',modifier:INCLUDES,depth:' + depth + '}';
  }

  function slashEnd(p) { return p === '/' ? '/' : p.replace(/\/+$/, '') + '/'; }

  // Library roots below `p`: Stash may not know the folders above them
  function rootsUnder(p) {
    var pre = slashEnd(p);
    return knownPaths.filter(function (r) { return r.indexOf(pre) === 0; });
  }

  // Folder lookup by path. Not findFolder(path:): for a path Stash does not know it returns an
  // error, and its result being non-null, Stash then drops the data of the whole request.
  // findFolders answers an empty list instead; its EQUALS ignores case, so the exact path is
  // picked in code (exactFolder).
  function folderQuery(alias, pathArg, fields) {
    return alias + ':findFolders(folder_filter:{path:{value:' + pathArg + ',modifier:EQUALS}},' +
      'filter:{per_page:-1}){folders{path ' + fields + '}}';
  }

  function exactFolder(res, p) {
    var list = (res && res.folders) || [];
    for (var i = 0; i < list.length; i++) if (list[i].path === p) return list[i];
    return null;
  }

  // path -> folder id (or null) for a few paths, one request per batch
  function lookupFolders(paths) {
    var out = {}, i = 0;
    function next() {
      if (i >= paths.length) return Promise.resolve(out);
      var chunk = paths.slice(i, i += STASH_BATCH);
      var q = '{' + chunk.map(function (p, k) {
        return folderQuery('f' + k, JSON.stringify(p), 'id');
      }).join(' ') + '}';
      return gql(q).then(function (d) {
        chunk.forEach(function (p, k) {
          var f = exactFolder(d['f' + k], p);
          out[p] = f ? f.id : null;
        });
        return next();
      });
    }
    return next();
  }

  // Folder ids to count for a sub-folder: its own, or those of the library roots below it
  function idsFor(p, ownId, rootIds) {
    if (ownId) return [ownId];
    return rootsUnder(p).map(function (r) { return rootIds[r]; }).filter(Boolean);
  }

  // Yes / No for every entry of the open folder
  function loadStashKnown(dir) {
    var ls = state.stashListing = { dir: dir, loading: true, error: null };
    var current = function () { return state.stashListing === ls; };
    // Sub-folders in display order, so the rows on screen fill first
    var shown = {};
    getFilteredSortedEntries().forEach(function (e, i) { shown[e.path] = i; });
    var dirs = state.browserEntries.filter(function (e) { return e.dir; }).sort(function (a, b) {
      var ia = a.path in shown ? shown[a.path] : Infinity, ib = b.path in shown ? shown[b.path] : Infinity;
      return ia === ib ? 0 : ia < ib ? -1 : 1;
    });
    var files = state.browserEntries.filter(function (e) { return !e.dir; });
    function set(list, v) { list.forEach(function (e) { state.stashKnown[e.path] = v; }); }

    // Files listed in this folder, against the known files directly in it
    function checkFiles(folderId) {
      if (!files.length) return Promise.resolve();
      if (!folderId) { set(files, false); return Promise.resolve(); }
      return gql('{f:findFiles(file_filter:' + knownFilter(underFolders([folderId], 0)) +
        ',filter:{per_page:-1}){files{path}}}').then(function (d) {
        var hit = {};
        d.f.files.forEach(function (x) { hit[x.path] = true; });
        files.forEach(function (e) { state.stashKnown[e.path] = !!hit[e.path]; });
        if (current()) renderBrowserBody();
      });
    }

    // One count per sub-folder, batched, shown as they come
    function countDirs(ids) {
      var list = dirs.filter(function (e) {
        if (ids[e.path] && ids[e.path].length) return true;
        state.stashKnown[e.path] = false;
        return false;
      });
      var i = 0;
      function next() {
        if (!current() || i >= list.length) return Promise.resolve();
        var chunk = list.slice(i, i += STASH_BATCH);
        var q = '{' + chunk.map(function (e, k) {
          return 'c' + k + ':findFiles(file_filter:' + knownFilter(underFolders(ids[e.path], -1)) +
            ',filter:{per_page:0}){count}';
        }).join(' ') + '}';
        return gql(q).then(function (d) {
          chunk.forEach(function (e, k) { state.stashKnown[e.path] = d['c' + k].count > 0; });
          if (current()) renderBrowserBody();
          return next();
        });
      }
      return next();
    }

    // Sub-folder ids: from the folder itself when Stash knows it, else looked up by path
    function checkDirs(folder) {
      if (!dirs.length) return Promise.resolve();
      var own = {};
      (folder ? folder.sub_folders || [] : []).forEach(function (s) { own[s.path] = s.id; });
      var missing = folder ? [] : dirs.map(function (e) { return e.path; });
      var roots = [];
      dirs.forEach(function (e) { if (!own[e.path]) roots = roots.concat(rootsUnder(e.path)); });
      return lookupFolders(missing.concat(roots)).then(function (found) {
        var ids = {};
        dirs.forEach(function (e) { ids[e.path] = idsFor(e.path, own[e.path] || found[e.path], found); });
        return countDirs(ids);
      });
    }

    gql('query($p:String!){' + folderQuery('d', '$p', 'id sub_folders{id path}') + '}', { p: dir }).then(function (d) {
      var folder = exactFolder(d && d.d, dir);
      return Promise.all([checkFiles(folder && folder.id), checkDirs(folder)]);
    }).then(function () {
      if (!current()) return;
      ls.loading = false;
      renderBrowserBody();
    }, function (e) {
      if (!current()) return;
      ls.loading = false;
      ls.error = (e && e.message) || String(e);
      renderBrowserBody();
    });
  }

  function inStashHtml(p) {
    var v = state.stashKnown[p], ls = state.stashListing;
    if (v === true) return 'Yes';
    if (v === false) return 'No';
    if (ls.dir === state.browserPath) {
      if (ls.loading) return '<span class="ts-spinner ts-spinner-sm" title="Checking Stash…"></span>';
      if (ls.error) return '<span title="' + esc('Could not check Stash: ' + ls.error) + '">?</span>';
    }
    return '';
  }

  // Selected item: count and total size of the scene / image files Stash knows under it
  function stashSizeOf(p) {
    var path = p === '/' ? p : p.replace(/\/+$/, '');
    function total(ids) {
      if (!ids.length) return Promise.resolve({ bytes: 0, files: 0 });
      return gql('{f:findFiles(file_filter:' + knownFilter(underFolders(ids, -1)) +
        ',filter:{per_page:0}){count size}}').then(function (r) {
        return { bytes: r.f.size || 0, files: r.f.count || 0 };
      });
    }
    return gql('query($p:String!){' + folderQuery('d', '$p', 'id') + ' f:findFiles(file_filter:' +
      knownFilter('path:{value:$p,modifier:EQUALS}') + ',filter:{per_page:0}){count size}}', { p: path })
      .then(function (d) {
        var folder = exactFolder(d.d, path);
        if (folder) return total([folder.id]);
        var roots = rootsUnder(path);
        if (!roots.length) return { bytes: d.f.size || 0, files: d.f.count || 0 };   // a file (or unknown)
        return lookupFolders(roots).then(function (found) { return total(idsFor(path, null, found)); });
      });
  }

  function requestStashSize(p) {
    var s = state.stashSizes[p];
    if (s && !s.error) return;            // cached or already queued
    state.stashSizes[p] = { loading: true };
    state.stashQueue.push(p);
    pumpStash();
  }

  function pumpStash() {
    if (state.stashBusy || !state.stashQueue.length) return;
    state.stashBusy = true;
    var gen = _stashGen;
    var p = state.stashQueue.shift();
    stashSizeOf(p).then(null, function (e) { return { error: (e && e.message) || String(e) }; })
      .then(function (r) {
        if (gen !== _stashGen) return;    // the wizard was reopened: that queue is gone
        state.stashSizes[p] = r;
        if (typeof r.files === 'number') state.stashKnown[p] = r.files > 0;
        state.stashBusy = false;
        renderSizes();
        pumpStash();
      });
  }

  function stashSizeHtml(p) {
    var s = state.stashSizes[p];
    if (!s) return '';
    if (s.loading) return '<span class="ts-spinner ts-spinner-sm" title="Asking Stash…"></span>';
    if (s.error) return '<span title="' + esc(s.error) + '">?</span>';
    if (!s.files) return '<span title="No scene or image file of this item is in Stash">—</span>';
    return '<span title="' + s.files + ' file' + (s.files > 1 ? 's' : '') + ' in Stash">' + esc(fmtBytes(s.bytes)) + '</span>';
  }

  // ── Date / Size / In stash filters ────────────────────────────────────────────
  // An item whose value is not known yet (folder not measured, Stash not answered) stays visible:
  // hiding it would make the folder look emptier than it is.

  var SIZE_UNITS = { MB: 1048576, GB: 1073741824, TB: 1099511627776 };

  function browserFiltersActive() {
    var f = state.bf;
    return f.dateOp !== 'any' || f.sizeOp !== 'any' || f.stash !== 'all';
  }

  // 'YYYY-MM-DD' -> epoch seconds at local midnight of that day (+ `plus` days), or null
  function dayStart(v, plus) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3] + (plus || 0)).getTime() / 1000 : null;
  }

  function sizeBound(v) {
    var n = parseFloat(v);
    return isNaN(n) || n < 0 ? null : n * SIZE_UNITS[state.bf.unit];
  }

  // [low, high) bounds of a filter, either side null when open; Between accepts reversed bounds
  function dateRange(f) {
    if (f.dateOp === 'before') return [null, dayStart(f.date1)];
    if (f.dateOp === 'after') return [dayStart(f.date1, 1), null];
    var a = f.date1 <= f.date2 || !f.date2 ? f.date1 : f.date2, b = a === f.date1 ? f.date2 : f.date1;
    return [dayStart(a), dayStart(b, 1)];             // both days included
  }

  function passesBrowserFilters(e) {
    var f = state.bf;
    if (f.dateOp !== 'any' && e.mtime) {
      var dr = dateRange(f);
      if ((dr[0] != null && e.mtime < dr[0]) || (dr[1] != null && e.mtime >= dr[1])) return false;
    }
    var s = state.sizes[e.path];
    if (f.sizeOp !== 'any' && s && typeof s.bytes === 'number') {
      var a = sizeBound(f.size1), b = sizeBound(f.size2), lo = null, hi = null;
      if (f.sizeOp === 'lt') hi = a;
      else if (f.sizeOp === 'gt') lo = a;
      else if (a != null && b != null) { lo = Math.min(a, b); hi = Math.max(a, b); }
      else { lo = a; hi = b; }
      // A partial size ("≥ X") is only a lower bound: hide the item only when that is enough to decide
      if (hi != null && (f.sizeOp === 'lt' ? s.bytes >= hi : s.bytes > hi)) return false;
      if (lo != null && s.complete && (f.sizeOp === 'gt' ? s.bytes <= lo : s.bytes < lo)) return false;
    }
    var k = state.stashKnown[e.path];
    if ((f.stash === 'yes' && k === false) || (f.stash === 'no' && k === true)) return false;
    return true;
  }

  function buildBrowserFilters() {
    var f = state.bf;
    function sel(field, opts) {
      return '<select class="ts-bf-sel" onchange="tsBf(\'' + field + '\', this.value, true)">' + opts.map(function (o) {
        return '<option value="' + o[0] + '"' + (f[field] === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select>';
    }
    function inp(field, type) {
      return '<input class="ts-bf-in" type="' + type + '" value="' + esc(f[field]) + '"' +
        (type === 'number' ? ' min="0" step="any" placeholder="0"' : '') +
        ' oninput="tsBf(\'' + field + '\', this.value)" />';
    }
    var and = '<span class="ts-bf-and">and</span>';
    var date = sel('dateOp', [['any', 'Any'], ['before', 'Before'], ['after', 'After'], ['between', 'Between']]);
    if (f.dateOp !== 'any') date += inp('date1', 'date') + (f.dateOp === 'between' ? and + inp('date2', 'date') : '');
    var size = sel('sizeOp', [['any', 'Any'], ['lt', 'Less than'], ['gt', 'More than'], ['between', 'Between']]);
    if (f.sizeOp !== 'any') {
      size += inp('size1', 'number') + (f.sizeOp === 'between' ? and + inp('size2', 'number') : '') +
        sel('unit', [['MB', 'MB'], ['GB', 'GB'], ['TB', 'TB']]);
    }
    return '<div class="ts-bf-group"><span class="ts-bf-lbl">Date</span>' + date + '</div>' +
      '<div class="ts-bf-group"><span class="ts-bf-lbl">Size</span>' + size + '</div>' +
      '<div class="ts-bf-group"><span class="ts-bf-lbl">In stash</span>' +
        sel('stash', [['all', 'All'], ['yes', 'Yes'], ['no', 'No']]) + '</div>' +
      '<button class="ts-btn-ghost ts-bf-clear" onclick="tsBfClear()"' + (browserFiltersActive() ? '' : ' disabled') +
        ' title="Folders not measured yet and items Stash has not answered for stay visible">Clear filters</button>';
  }

  function renderBrowserFilters() {
    var el = document.getElementById('ts-browser-filters');
    if (el) el.innerHTML = buildBrowserFilters();
  }

  // ── Sort / filter browser entries ─────────────────────────────────────────────

  function getFilteredSortedEntries() {
    var list = state.browserEntries.slice();
    // Several space-separated terms: every term must appear in the name
    var terms = state.filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length) {
      list = list.filter(function (e) {
        var n = (e.name || basename(e.path)).toLowerCase();
        return terms.every(function (term) { return n.indexOf(term) >= 0; });
      });
    }
    if (browserFiltersActive()) list = list.filter(passesBrowserFilters);
    function byName(a, b) {
      var na = (a.name || '').toLowerCase(), nb = (b.name || '').toLowerCase();
      return na < nb ? -1 : na > nb ? 1 : 0;
    }
    // Unknown values (no date, size not measured) always go last, whatever the direction
    function byValue(va, vb, a, b) {
      if (va == null && vb == null) return byName(a, b);
      if (va == null) return 1;
      if (vb == null) return -1;
      return va !== vb ? state.sortDir * (va - vb) : byName(a, b);
    }
    list.sort(function (a, b) {
      if (!!a.dir !== !!b.dir) return a.dir ? -1 : 1;   // folders first
      if (state.sort === 'date') return byValue(a.mtime || null, b.mtime || null, a, b);
      if (state.sort === 'size') {
        var sa = state.sizes[a.path], sb = state.sizes[b.path];
        return byValue(sa && typeof sa.bytes === 'number' ? sa.bytes : null,
          sb && typeof sb.bytes === 'number' ? sb.bytes : null, a, b);
      }
      if (state.sort === 'instash') {
        var ka = state.stashKnown[a.path], kb = state.stashKnown[b.path];
        return byValue(typeof ka === 'boolean' ? +ka : null, typeof kb === 'boolean' ? +kb : null, a, b);
      }
      if (state.sort === 'stashsize') {
        var ta = state.stashSizes[a.path], tb = state.stashSizes[b.path];
        return byValue(ta && typeof ta.bytes === 'number' ? ta.bytes : null,
          tb && typeof tb.bytes === 'number' ? tb.bytes : null, a, b);
      }
      return state.sortDir * byName(a, b);
    });
    return list;
  }

  // ── CSS ───────────────────────────────────────────────────────────────────────

  var CSS = [
    ':root{',
    '--bg:#1a1f2e;--surface:#242938;--surface2:#2e3447;--border:#3a4060;',
    '--fg:#e0e4f0;--fg2:#8b93b0;--accent:#0d9ef7;--success:#2dbd6e;',
    '--warn:#f0a830;--danger:#e05050;',
    '}',
    '.ts-wrap{font-family:system-ui,sans-serif;color:var(--fg);max-width:1100px;margin:0 auto;padding:20px;font-size:13px}',
    // Header
    '.ts-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}',
    '.ts-title{font-size:17px;font-weight:600;letter-spacing:-.01em}',
    '.ts-hdr-right{display:flex;align-items:center;gap:12px}',
    // Global toggle
    '.ts-tog{position:relative;width:36px;height:20px;cursor:pointer;background:var(--border);',
    'border:none;border-radius:10px;transition:background .2s;flex-shrink:0}',
    '.ts-tog.on{background:var(--accent)}',
    '.ts-tog-thumb{position:absolute;top:3px;left:3px;width:14px;height:14px;',
    'border-radius:50%;background:#fff;transition:left .2s}',
    '.ts-tog.on .ts-tog-thumb{left:19px}',
    '.ts-global-lbl{font-size:12px;color:var(--fg2)}',
    '.ts-global-lbl.on{color:var(--success)}',
    // Buttons
    '.ts-btn{border:none;border-radius:6px;padding:7px 14px;font-size:13px;cursor:pointer;font-weight:500}',
    '.ts-btn-primary{background:var(--accent);color:#fff}',
    '.ts-btn-primary:hover{filter:brightness(1.1)}',
    '.ts-btn-ghost{background:none;border:1px solid var(--border);color:var(--fg2);border-radius:6px;',
    'padding:7px 14px;font-size:13px;cursor:pointer}',
    '.ts-btn-ghost:hover{border-color:var(--fg2);color:var(--fg)}',
    '.ts-btn-danger{background:var(--danger);color:#fff;border:none;border-radius:6px;',
    'padding:7px 14px;font-size:13px;cursor:pointer;font-weight:500}',
    // Table
    '.ts-tbl-wrap{overflow-x:auto}',
    '.ts-tbl{width:100%;border-collapse:collapse}',
    '.ts-tbl th{text-align:left;padding:7px 10px;font-size:11px;color:var(--fg2);',
    'border-bottom:1px solid var(--border);font-weight:500;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}',
    '.ts-tbl td{padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:middle}',
    '.ts-tbl tr:last-child td{border-bottom:none}',
    '.ts-tbl tr:hover td{background:rgba(255,255,255,.02)}',
    // Badges
    '.ts-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;',
    'border-radius:4px;font-size:11px;font-weight:500}',
    '.ts-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}',
    '.ts-badge.running{color:var(--accent)}.ts-badge.pending{color:var(--warn)}',
    '.ts-badge.done{color:var(--success)}.ts-badge.paused{color:var(--fg2)}.ts-badge.error{color:var(--danger)}',
    '.ts-badge.missed{color:var(--danger)}',
    '.ts-missed-note{font-size:11px;font-family:monospace;color:var(--danger);white-space:nowrap}',
    // Chips
    '.ts-chip{display:inline-block;background:var(--surface2);border:1px solid var(--border);',
    'border-radius:3px;padding:1px 5px;font-size:11px;margin:1px;font-family:monospace}',
    // Action buttons in table
    '.ts-act{background:var(--surface2);border:1px solid var(--border);border-radius:5px;',
    'color:var(--fg);padding:4px 6px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;vertical-align:middle}',
    '.ts-act svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
    '.ts-act:hover{border-color:var(--accent);color:var(--accent)}',
    '.ts-act.danger:hover{border-color:var(--danger);color:var(--danger)}',
    '.ts-act-sep{display:inline-block;width:1px;height:20px;background:var(--border);margin:0 8px;vertical-align:middle}',
    // Main Run / Stop button (own column, wider than the icon buttons)
    '.ts-run{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:84px;padding:6px 10px;',
    'border:1px solid var(--accent);border-radius:6px;background:rgba(13,158,247,.15);color:var(--fg);',
    'font-size:13px;font-weight:500;cursor:pointer;vertical-align:middle;white-space:nowrap}',
    '.ts-run svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
    '.ts-run:hover:not(:disabled){background:var(--accent);color:#fff}',
    '.ts-run.stop{border-color:var(--danger);background:rgba(224,80,80,.15)}',
    '.ts-run.stop:hover{background:var(--danger);color:#fff}',
    '.ts-run.sched{border-color:var(--border);background:none;color:var(--fg2);cursor:not-allowed;opacity:.7}',
    '.ts-tbl td.c-run{white-space:nowrap;width:1%}',
    // Unfolded path list (more than 2 paths)
    '.ts-paths-all{max-height:120px;overflow-y:auto;padding-right:4px}',
    '.ts-more{cursor:pointer;color:var(--accent);border-color:var(--accent);background:none}',
    '.ts-more:hover{background:rgba(13,158,247,.15)}',
    '.ts-size-note{font-size:11px;font-family:monospace;color:var(--fg2);margin-top:3px}',
    '.ts-mono{font-family:monospace;font-size:12px;color:var(--fg2)}',
    '.ts-page{padding:16px 0}',
    '.ts-daemon{font-size:13px;color:var(--fg2);margin-right:6px}',
    '.ts-daemon.on{color:var(--success)}',
    '.ts-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}',
    '.ts-flt{background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--fg2);',
    'padding:6px 12px;font-size:13px;cursor:pointer}',
    '.ts-flt:hover{color:var(--fg)}',
    '.ts-flt.active{background:rgba(13,158,247,.15);border-color:var(--accent);color:var(--fg)}',
    '.ts-flt-n{font-size:12px;opacity:.7;margin-left:4px}',
    '.ts-runall{display:inline-flex;align-items:center;gap:8px}',
    '.ts-runall:disabled{opacity:.4;cursor:default}',
    '.ts-runall svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
    '.ts-badge.queued{color:var(--warn)}',
    // Larger type for the full page
    '.ts-wrap{font-size:14px}',
    '.ts-wrap .ts-title{font-size:20px}',
    '.ts-wrap .ts-btn{font-size:13px;padding:7px 14px}',
    '.ts-wrap .ts-global-lbl{font-size:13px}',
    '.ts-wrap .ts-tbl th{font-size:12px;padding:10px 12px}',
    '.ts-wrap .ts-tbl td{padding:11px 12px;font-size:14px}',
    '.ts-wrap .ts-badge{font-size:13px}',
    '.ts-wrap .ts-dot{width:7px;height:7px}',
    '.ts-wrap .ts-chip{font-size:12px;padding:2px 7px}',
    '.ts-wrap .ts-mono{font-size:12px}',
    '.ts-wrap .ts-act{padding:5px 7px}',
    '.ts-wrap .ts-act svg{width:16px;height:16px}',
    '.ts-reorder{display:inline-flex;flex-direction:column;gap:2px;vertical-align:middle;margin-right:16px;width:22px}',
    '.ts-mv{background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--fg2);',
    'cursor:pointer;height:17px;padding:0;display:flex;align-items:center;justify-content:center;line-height:1}',
    '.ts-mv svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}',
    '.ts-mv:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}',
    '.ts-mv:disabled{opacity:.25;cursor:default}',
    '.ts-page .ts-wrap{max-width:1500px}',
    '.ts-chip{white-space:normal;overflow-wrap:anywhere;vertical-align:middle}',
    '.ts-stages{margin-top:5px;display:flex;gap:4px;align-items:center;flex-wrap:wrap;font-size:12px}',
    '.ts-stg{padding:0 8px;border-radius:10px;border:1px solid var(--border);color:var(--fg2);line-height:1.6}',
    '.ts-stg.ok{color:var(--success);border-color:var(--success)}',
    '.ts-stg.cur{color:var(--accent);border-color:var(--accent);background:rgba(13,158,247,.12)}',
    '.ts-stg.bad{color:var(--danger);border-color:var(--danger)}',
    '.ts-stg-arrow{color:var(--fg2)}',
    '.ts-stg[data-ph]{cursor:help}',
    '.ts-logtip{position:fixed;z-index:100000;min-width:280px;max-width:640px;max-height:320px;overflow:auto;',
    'background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:8px 10px;',
    'box-shadow:0 6px 20px rgba(0,0,0,.45);font-size:12px}',
    '.ts-logtip .ts-tip-hdr{font-weight:600;color:var(--fg2)}',
    '.ts-logtip .ts-tip-cmds{margin-top:6px;font-family:monospace;word-break:break-all}',
    '.ts-logtip .ts-tip-cmd{padding:1px 0}',
    '.ts-logtip .ts-tip-flag{color:var(--fg2);font-family:system-ui,sans-serif}',
    '.ts-logtip .ts-tip-sub{margin-top:8px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--fg2);border-top:1px solid var(--border);padding-top:6px}',
    '.ts-logtip pre{margin:6px 0 0;white-space:pre-wrap;word-break:break-all;font-family:monospace;font-size:12px;color:var(--fg)}',
    // The table narrows with the window: drop the least useful columns first
    '@media (max-width:1500px){.ts-wrap .ts-tbl td{padding:9px 10px}.ts-wrap .ts-tbl th{padding:9px 10px}}',
    '@media (max-width:1400px){.ts-tbl .c-end{display:none}}',
    '@media (max-width:1250px){.ts-tbl .c-start{display:none}}',
    '@media (max-width:1050px){.ts-tbl .c-next{display:none}}',
    '@media (max-width:860px){.ts-tbl .c-sched{display:none}.ts-wrap{padding:12px}}',
    '.ts-prog-fill.ts-indet{width:35%;animation:ts-indet 1.3s ease-in-out infinite}',
    '@keyframes ts-indet{0%{margin-left:-35%}100%{margin-left:100%}}',
    // Empty
    '.ts-empty{text-align:center;padding:48px 20px;color:var(--fg2)}',
    '.ts-load-error{margin:0 0 12px;padding:8px 12px;border:1px solid var(--danger);border-radius:6px;',
    'color:var(--danger);font-size:13px;word-break:break-word}',
    '.ts-load-error[hidden]{display:none}',
    // Overlay
    '.ts-ov{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9000;',
    'display:flex;align-items:center;justify-content:center}',
    '.ts-ov.hidden{display:none}',
    // Modals
    '.ts-modal{background:var(--surface);border:1px solid var(--border);border-radius:10px;',
    'display:flex;flex-direction:column;z-index:9001;max-height:90vh;max-height:90dvh;overflow:hidden}',
    '.ts-modal-hdr{display:flex;align-items:center;justify-content:space-between;',
    'padding:14px 20px;border-bottom:1px solid var(--border);flex-shrink:0}',
    '.ts-modal-title{font-size:15px;font-weight:600}',
    '.ts-modal-close{background:none;border:none;color:var(--fg2);font-size:22px;cursor:pointer;line-height:1;padding:0}',
    '.ts-modal-footer{padding:12px 20px;border-top:1px solid var(--border);',
    'flex-shrink:0;display:flex;justify-content:flex-end;align-items:center;gap:8px}',
    '.ts-modal-body{flex:1;overflow-y:auto;min-height:0}',
    // Wizard modal
    '.ts-wizard{width:1280px;max-width:96vw;height:90vh;height:90dvh;max-height:90vh;max-height:90dvh;font-size:15px}',
    // Larger type inside the wizard (overrides the compact sizes used elsewhere)
    '.ts-wizard .ts-modal-title{font-size:16px}',
    '.ts-wizard .ts-modal-hdr{padding:8px 26px}',
    '.ts-wizard .ts-modal-footer{padding:16px 26px}',
    '.ts-wizard .ts-modal-close{font-size:22px}',
    '.ts-wizard .ts-col-left,.ts-wizard .ts-col-right{padding:22px 26px}',
    '.ts-wizard .ts-col-right{width:260px}',
    '.ts-wizard .ts-btn,.ts-wizard .ts-btn-ghost{font-size:15px;padding:10px 20px}',
    '.ts-wizard .ts-label,.ts-wizard .ts-section-title{font-size:13px}',
    '.ts-wizard input,.ts-wizard select{font-size:15px;padding:9px 12px}',
    '.ts-wizard .ts-step{font-size:14px}',
    '.ts-wizard .ts-filter-input{font-size:15px;padding:8px 12px}',
    '.ts-wizard .ts-dir-size{font-size:13px;width:100px}',
    '.ts-wizard .ts-dir-row{padding:9px 12px}',
    '.ts-wizard .ts-dir-name{font-size:15px}',
    '.ts-wizard .ts-dir-date{font-size:13px;width:150px}',
    '.ts-wizard .ts-dir-icon{font-size:17px}',
    '.ts-wizard .ts-dir-known{font-size:13px;width:72px}',
    '.ts-wizard .ts-dir-ssize{font-size:13px;width:110px}',
    '.ts-wizard .ts-dir-head > div{font-size:11px;letter-spacing:0;white-space:nowrap}',
    '.ts-wizard .ts-bf-sel,.ts-wizard .ts-bf-in{font-size:13px;padding:5px 8px}',
    '.ts-wizard .ts-bf-clear{font-size:13px;padding:5px 12px}',
    '.ts-wizard .ts-opt-label{font-size:15px}',
    '.ts-wizard .ts-opt-row{padding:10px 12px}',
    '.ts-wizard .ts-sel-chip,.ts-wizard .ts-chip{font-size:13px}',
    '.ts-wizard .ts-sched-btn,.ts-wizard .ts-day-btn{font-size:14px;padding:7px 14px}',
    '#ts-browser-col{display:flex;flex-direction:column;overflow-y:auto}',
    '#ts-browser-col > *{flex-shrink:0}',
    '#ts-browser-col .ts-sel-list{max-height:92px;overflow-y:auto}',
    '#ts-browser-rows{flex:1 1 0;min-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:6px}',
    '.ts-body-col{flex-direction:column;overflow-y:auto;padding:14px 26px;gap:6px}',
    '.ts-s2-top{display:flex;gap:32px;flex-wrap:wrap}',
    '.ts-s2-top > div{flex:1;min-width:300px}',
    '.ts-s2-top .ts-sched-types{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}',
    '.ts-s2-top input[type=datetime-local]{max-width:300px}',
    '.ts-s2-paths{font-size:13px;font-family:monospace;color:var(--fg2);line-height:1.7;max-height:160px;overflow-y:auto;word-break:break-all}',
    '#ts-scan-opts{display:grid;grid-template-columns:1fr 1fr;column-gap:14px}',
    '.ts-wizard.ts-compact{width:900px;height:auto;max-height:90vh;max-height:90dvh}',
    '.ts-script-help{font-size:13px;color:var(--fg2);line-height:1.6;margin-bottom:6px}',
    '.ts-script-help code,.ts-script-hint code{font-family:monospace;background:var(--surface2);padding:1px 5px;border-radius:4px;color:var(--fg)}',
    '.ts-script-block{margin-top:6px}',
    '.ts-script-hint{font-size:12px;color:var(--fg2);margin-bottom:8px}',
    // Identify step
    '.ts-id-switch{display:flex;align-items:center;gap:8px;font-size:14px;margin-bottom:8px;cursor:pointer}',
    '.ts-id-warn{border:1px solid var(--warn);color:var(--warn);background:rgba(240,168,48,.08);border-radius:6px;padding:8px 12px;font-size:12px;margin-bottom:10px}',
    '.ts-id-cols{display:flex;gap:20px;align-items:flex-start}',
    '.ts-id-cols.off{opacity:.45}',
    '.ts-id-col{flex:1 1 0;min-width:0}',
    '.ts-id-col .ts-filter-input{width:100%;box-sizing:border-box;margin-bottom:6px}',
    '.ts-id-list{max-height:340px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:4px}',
    '.ts-id-group{font-size:11px;color:var(--fg2);text-transform:uppercase;letter-spacing:.04em;padding:6px 6px 2px}',
    '.ts-id-defbtn{float:right;font-size:11px;padding:2px 8px;text-transform:none;letter-spacing:0}',
    '.ts-id-defbtn:disabled{opacity:.4;cursor:default}',
    '.ts-id-chip{display:flex;align-items:center;gap:8px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;background:var(--surface2)}',
    '.ts-id-chip.gone{border-color:var(--warn)}',
    '.ts-id-chip.gone .ts-id-name{color:var(--warn)}',
    '.ts-id-num{font-family:monospace;color:var(--accent);min-width:16px}',
    '.ts-id-kind{font-size:11px;color:var(--fg2);text-transform:uppercase;min-width:62px}',
    '.ts-id-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ts-id-chip .ts-act:disabled{opacity:.3;cursor:default}',
    // Errors Stash logged during a run
    '.ts-stash-err{font-size:11px;color:var(--warn);cursor:pointer;margin-top:3px;white-space:nowrap}',
    '.ts-stash-err:hover{text-decoration:underline}',
    '.ts-hist-errs summary{cursor:pointer;color:var(--warn)}',
    '.ts-hist-err{font-size:11px;margin:2px 0 2px 12px;word-break:break-word}',
    '.ts-hist-err-note{font-size:11px;color:var(--fg2);margin:4px 0 4px 12px;font-style:italic}',
    // Run timeline and current run (history modal)
    '.ts-hist-tl summary{cursor:pointer;color:var(--fg2)}',
    '.ts-hist-ev{font-size:11px;margin:2px 0 2px 12px;word-break:break-word}',
    '.ts-hist-ev .ts-mono{margin-right:6px;opacity:.75}',
    '.ts-hist-ev.ok{color:var(--success)}',
    '.ts-hist-ev.warn{color:var(--warn)}',
    '.ts-hist-ev.error{color:var(--danger)}',
    '.ts-hist-cur td{background:rgba(127,127,127,.08)}',
    '.ts-hist-copy{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 6px 12px}',
    '.ts-copy-btn{font-size:11px;padding:2px 10px}',
    '.ts-hist-cur .ts-hist-now{font-size:12px;margin-bottom:3px;font-family:monospace;word-break:break-word}',
    '.ts-script-row{display:flex;align-items:center;gap:12px;margin-bottom:8px}',
    '.ts-script-row .ts-script-cmd{flex:1;min-width:0;font-family:monospace}',
    '.ts-script-cont{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--fg2);white-space:nowrap;cursor:pointer}',
    '.ts-script-none{font-size:13px;color:var(--fg2);font-style:italic;margin-bottom:8px}',
    '.ts-script-add{font-size:13px;padding:6px 14px}',
    '.ts-name-row{display:flex;gap:16px;margin-bottom:0;align-items:flex-end}',
    '#ts-browser-col{padding-top:12px}',
    '.ts-name-row .ts-section-title{margin:0 0 5px}',
    '#ts-browser-col .ts-name-row + .ts-section-title{margin-top:8px}',
    '.ts-name-col{flex:1;min-width:0}',
    '.ts-lib-col{width:42%;min-width:0}',
    '.ts-name-row .ts-input{width:100%;box-sizing:border-box}',
    '.ts-wizard-body{display:flex;flex:1;overflow:hidden;min-height:0}',
    '.ts-col-left{flex:1;min-width:0;padding:16px 20px;border-right:1px solid var(--border);overflow-y:auto}',
    '.ts-col-right{width:300px;flex-shrink:0;padding:16px 18px;overflow-y:auto;background:var(--surface2)}',
    // Form elements
    '.ts-label{font-size:11px;color:var(--fg2);text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px;display:block}',
    '.ts-input{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;',
    'padding:7px 10px;color:var(--fg);font-size:13px;outline:none;box-sizing:border-box}',
    '.ts-input:focus{border-color:var(--accent)}',
    '.ts-section-title{font-size:11px;color:var(--fg2);text-transform:uppercase;letter-spacing:.04em;',
    'margin:14px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--border)}',
    '.ts-section-title:first-child{margin-top:0}',
    // Step indicator
    '.ts-steps{display:flex;align-items:center;gap:8px;padding:12px 20px;',
    'border-bottom:1px solid var(--border);flex-shrink:0;background:var(--surface2)}',
    '.ts-step{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--fg2)}',
    '.ts-step-num{width:22px;height:22px;border-radius:50%;border:1px solid var(--border);',
    'display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;flex-shrink:0}',
    '.ts-step.active .ts-step-num{background:var(--accent);border-color:var(--accent);color:#fff}',
    '.ts-step.active{color:var(--fg)}',
    '.ts-step.done .ts-step-num{background:var(--success);border-color:var(--success);color:#fff}',
    '.ts-step-sep{flex:1;height:1px;background:var(--border)}',
    // Breadcrumb
    '.ts-breadcrumb{display:flex;align-items:center;gap:4px;flex-wrap:wrap;',
    'background:var(--surface2);border:1px solid var(--border);border-radius:6px;',
    'padding:6px 10px;margin-bottom:10px;font-size:12px;font-family:monospace}',
    '.ts-crumb{color:var(--accent);cursor:pointer;background:none;border:none;',
    'font-family:monospace;font-size:12px;padding:0}',
    '.ts-crumb:hover{text-decoration:underline}',
    '.ts-crumb-sep{color:var(--fg2)}',
    '.ts-crumb-current{color:var(--fg)}',
    // Browser toolbar
    '.ts-browser-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:10px}',
    '.ts-filter-input{flex:1;background:var(--bg);border:1px solid var(--border);',
    'border-radius:6px;padding:5px 9px;color:var(--fg);font-size:12px;outline:none}',
    '.ts-filter-input:focus{border-color:var(--accent)}',
    // Browser column headers (click to sort), sizes, files
    '#ts-browser-head{padding-right:14px;flex-shrink:0}',
    '.ts-dir-head{cursor:default}',
    '.ts-dir-head:hover{background:none}',
    '.ts-dir-head > div{font-family:system-ui,sans-serif;font-size:12px;color:var(--fg2);text-transform:uppercase;letter-spacing:.04em}',
    '.ts-col-sort{cursor:pointer}',
    '.ts-col-sort:hover,.ts-col-sort.active{color:var(--fg)}',
    '.ts-dir-size{font-size:11px;color:var(--fg2);flex-shrink:0;font-family:monospace;width:90px;text-align:right}',
    '.ts-dir-known{font-size:11px;color:var(--fg2);flex-shrink:0;width:60px;text-align:center}',
    '.ts-dir-ssize{font-size:11px;color:var(--fg2);flex-shrink:0;font-family:monospace;width:96px;text-align:right}',
    '.ts-dir-row.known > div:not(.ts-dir-cb){font-style:italic;opacity:.6}',
    // Date / Size / In stash filter row
    '.ts-browser-filters{display:flex;flex-wrap:wrap;align-items:center;gap:6px 18px;margin-bottom:10px}',
    '.ts-bf-group{display:flex;align-items:center;gap:6px}',
    '.ts-bf-lbl{font-size:11px;color:var(--fg2);text-transform:uppercase;letter-spacing:.04em}',
    '.ts-bf-and{font-size:12px;color:var(--fg2)}',
    '.ts-bf-sel,.ts-bf-in{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:4px 6px;color:var(--fg);font-size:12px;outline:none}',
    '.ts-bf-sel:focus,.ts-bf-in:focus{border-color:var(--accent)}',
    '.ts-bf-in[type=number]{width:72px}',
    '.ts-bf-in[type=date]{color-scheme:light dark}',
    '.ts-bf-clear{margin-left:auto}',
    '.ts-bf-clear:disabled{opacity:.4;cursor:default}',
    '.ts-dir-cb-sp{width:16px;flex-shrink:0}',
    '.ts-dir-row.sel{background:rgba(13,158,247,.08)}',
    '.ts-dir-row.file .ts-dir-name{color:var(--fg2)}',
    '.ts-dir-row.file.sel .ts-dir-name{color:var(--fg)}',
    '.ts-spinner-sm{width:10px;height:10px;border-width:2px;vertical-align:middle}',
    '.ts-sel-size{color:var(--fg2);margin-left:4px}',
    '.ts-sel-path{cursor:pointer}',
    '.ts-sel-path:hover{color:var(--accent);text-decoration:underline}',
    '.ts-dir-row.focus{animation:ts-focus 2.5s ease-out}',
    '@keyframes ts-focus{0%,40%{background:rgba(13,158,247,.35)}100%{background:transparent}}',
    '.ts-sel-total{float:right;text-transform:none;letter-spacing:0;color:var(--fg);font-family:monospace}',
    '.ts-s2-path{display:flex;justify-content:space-between;gap:16px}',
    '.ts-s2-size{flex-shrink:0;color:var(--fg)}',
    '.ts-s2-total{border-top:1px solid var(--border);margin-top:4px;padding-top:2px;color:var(--fg);font-weight:600}',
    // Directory rows
    '.ts-dir-row{display:flex;align-items:center;gap:8px;padding:5px 6px;',
    'border-radius:5px;cursor:pointer;user-select:none}',
    '.ts-dir-row:hover{background:var(--surface2)}',
    '.ts-dir-icon{flex-shrink:0;font-size:14px;width:18px;text-align:center}',
    '.ts-dir-play{background:none;border:1px solid var(--accent);color:var(--accent);border-radius:50%;width:20px;height:20px;',
    'padding:0;font-size:9px;line-height:18px;text-align:center;cursor:pointer}',
    '.ts-dir-play:hover{background:var(--accent);color:#fff}',
    '.ts-dir-name{flex:1;font-size:12px;font-family:monospace;overflow:hidden;',
    'text-overflow:ellipsis;white-space:nowrap;min-width:0}',
    '.ts-dir-date{font-size:11px;color:var(--fg2);flex-shrink:0;font-family:monospace;width:80px;text-align:right}',
    '.ts-dir-cb{width:16px;height:16px;border:1px solid var(--border);border-radius:3px;',
    'flex-shrink:0;display:flex;align-items:center;justify-content:center;',
    'font-size:10px;color:#fff;cursor:pointer}',
    '.ts-dir-cb.checked{background:var(--accent);border-color:var(--accent)}',
    // Selected paths chips
    '.ts-sel-list{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;min-height:26px}',
    '.ts-sel-chip{display:inline-flex;align-items:center;gap:4px;background:var(--surface2);',
    'border:1px solid var(--border);border-radius:4px;padding:2px 7px;font-size:11px;font-family:monospace}',
    '.ts-sel-x{cursor:pointer;color:var(--fg2);line-height:1}',
    '.ts-sel-x:hover{color:var(--danger)}',
    // Scan option rows
    '.ts-opt-row{display:flex;align-items:center;gap:10px;padding:7px 9px;',
    'border:1px solid var(--border);border-radius:6px;cursor:pointer;margin-bottom:5px;',
    'transition:border-color .15s,background .15s}',
    '.ts-opt-row:hover{border-color:var(--fg2)}',
    '.ts-opt-row.on{border-color:var(--accent);background:rgba(13,158,247,.07)}',
    '.ts-opt-label{flex:1;font-size:12px}',
    '.ts-opt-cb{width:16px;height:16px;border:1px solid var(--border);border-radius:3px;',
    'flex-shrink:0;display:flex;align-items:center;justify-content:center;',
    'font-size:10px;color:#fff;transition:background .15s}',
    '.ts-opt-cb.on{background:var(--accent);border-color:var(--accent)}',
    // Schedule type buttons
    '.ts-sched-types{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px}',
    '.ts-sched-btn{background:var(--surface);border:1px solid var(--border);border-radius:5px;',
    'color:var(--fg2);padding:5px 11px;font-size:12px;cursor:pointer}',
    '.ts-sched-btn.active{background:rgba(13,158,247,.15);border-color:var(--accent);color:var(--fg)}',
    // Day buttons (weekly)
    '.ts-day-btn{background:var(--surface);border:1px solid var(--border);border-radius:5px;',
    'color:var(--fg2);padding:4px 8px;font-size:11px;cursor:pointer}',
    '.ts-day-btn.active{background:rgba(13,158,247,.15);border-color:var(--accent);color:var(--fg)}',
    // Delete modal
    '.ts-del-modal{width:420px;max-width:96vw}',
    '.ts-del-body{padding:20px;color:var(--fg2);font-size:13px;line-height:1.6}',
    '.ts-del-name{color:var(--fg);font-weight:600}',
    // History modal
    '.ts-hist-modal{width:1000px;max-width:96vw;font-size:14px}',
    '.ts-hist-modal .ts-modal-body{padding:12px 20px}',
    '.ts-hist-note{font-size:12px;color:var(--fg2);margin-bottom:10px}',
    '.ts-hist-tbl td{vertical-align:top;font-size:13px}',
    '.ts-hist-tbl td.ts-mono{white-space:nowrap}',
    '.ts-hist-detail{color:var(--fg2);word-break:break-word}',
    '.ts-hist-detail div{margin-bottom:3px}',
    '.ts-footer-left{flex:1}',
    // Loading spinner
    '.ts-spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--border);',
    'border-top-color:var(--accent);border-radius:50%;animation:ts-spin .6s linear infinite}',
    '@keyframes ts-spin{to{transform:rotate(360deg)}}',
    // Task toggle
    '.ts-task-tog{position:relative;width:30px;height:17px;cursor:pointer;',
    'background:var(--border);border:none;border-radius:9px;transition:background .2s;flex-shrink:0}',
    '.ts-task-tog.on{background:var(--accent)}',
    '.ts-task-tog-thumb{position:absolute;top:2.5px;left:2.5px;width:12px;height:12px;',
    'border-radius:50%;background:#fff;transition:left .2s}',
    '.ts-task-tog.on .ts-task-tog-thumb{left:15.5px}',
    // Progress
    '.ts-prog-bg{height:3px;background:var(--surface2);border-radius:2px;margin-top:4px;min-width:70px;overflow:hidden}',
    '.ts-prog-fill{height:3px;background:var(--accent);border-radius:2px;transition:width .3s}',
    // Short windows: the wizard takes more height and tightens its spacing
    '@media (max-height:860px){',
    '.ts-wizard{height:96vh;height:96dvh;max-height:96vh;max-height:96dvh}',
    '.ts-wizard.ts-compact{max-height:96vh;max-height:96dvh}',
    '.ts-wizard .ts-modal-hdr{padding:6px 20px}',
    '.ts-wizard .ts-steps{padding:6px 20px}',
    '.ts-wizard .ts-modal-footer{padding:8px 20px}',
    '.ts-wizard .ts-col-left,.ts-wizard .ts-col-right{padding:10px 20px}',
    '.ts-wizard .ts-section-title{margin:8px 0 5px}',
    '.ts-wizard input,.ts-wizard select{padding:6px 10px}',
    '.ts-wizard .ts-btn,.ts-wizard .ts-btn-ghost{padding:7px 16px}',
    '.ts-wizard .ts-breadcrumb,.ts-wizard .ts-browser-toolbar,.ts-wizard .ts-browser-filters{margin-bottom:6px}',
    '.ts-wizard .ts-dir-row{padding:6px 12px}',
    '#ts-browser-rows{min-height:200px}',
    '}',
    // Phones: header wraps, every task becomes a card, the wizard stacks
    '@media (max-width:700px){',
    '.ts-wrap{padding:10px}',
    '.ts-hdr{flex-wrap:wrap;gap:10px}',
    '.ts-hdr-right{flex-wrap:wrap;gap:8px;width:100%}',
    '.ts-wrap .ts-title{font-size:18px;white-space:nowrap}',
    '.ts-wrap .ts-btn{font-size:13px;padding:6px 10px;white-space:nowrap}',
    '.ts-daemon,.ts-global-lbl{white-space:nowrap}',
    '.ts-flt{padding:5px 10px;font-size:12px}',
    '.ts-tbl,.ts-tbl tbody{display:block}',
    '.ts-tbl thead{display:none}',
    '.ts-tbl tr{display:block;border:1px solid var(--border);border-radius:8px;background:var(--surface);margin-bottom:10px;padding:8px 12px}',
    '.ts-wrap .ts-tbl td{display:grid !important;grid-template-columns:78px minmax(0,1fr);gap:8px;padding:5px 0;border-bottom:none;max-width:none !important;font-size:13px;align-items:baseline;text-align:left !important;white-space:normal !important}',
    '.ts-tbl td::before{content:attr(data-label);font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--fg2)}',
    '.ts-wrap .ts-tbl td.c-name{grid-template-columns:minmax(0,1fr);font-size:15px;font-weight:600;padding-bottom:2px}',
    '.ts-wrap .ts-tbl td.c-actions,.ts-wrap .ts-tbl td.c-run{grid-template-columns:minmax(0,1fr);padding-top:8px}',
    '.ts-tbl td.c-name::before,.ts-tbl td.c-actions::before,.ts-tbl td.c-run::before{display:none}',
    '.ts-tbl td.c-actions .ts-cell,.ts-tbl td.c-run .ts-cell{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
    '.ts-tbl td.c-run{width:auto}',
    '.ts-tbl .ts-cell{min-width:0}',
    '.ts-chip{max-width:100%}',
    // wizard
    '.ts-wizard{width:100vw;max-width:100vw;height:100vh;height:100dvh;max-height:100vh;max-height:100dvh;border-radius:0}',
    '.ts-wizard .ts-modal-hdr,.ts-wizard .ts-steps,.ts-wizard .ts-modal-footer{padding-left:14px;padding-right:14px}',
    '#ts-browser-rows{flex:none;height:70vh;height:70dvh;min-height:0}',
    '.ts-browser-filters{gap:6px 10px}',
    '.ts-bf-clear{margin-left:0}',
    '.ts-hist-modal{width:100vw;max-width:100vw;height:100vh;height:100dvh;max-height:100vh;max-height:100dvh;border-radius:0}',
    '.ts-hist-modal .ts-modal-body{padding:10px}',
    '.ts-hist-tbl td,.ts-hist-tbl td.ts-mono{display:grid;grid-template-columns:78px minmax(0,1fr);gap:8px;padding:4px 0;border-bottom:none;white-space:normal;font-size:13px}',
    // Details holds several blocks: one column, the label above them (a grid would split them in two)
    '.ts-hist-tbl td.ts-hist-detail{display:block}',
    '.ts-hist-tbl td.ts-hist-detail::before{display:block;margin-bottom:4px}',
    '.ts-wizard.ts-compact{width:100vw}',
    '.ts-name-row{flex-wrap:wrap}',
    '.ts-lib-col,.ts-name-col{width:100%;flex:1 1 100%}',
    '.ts-wizard .ts-col-left,.ts-wizard .ts-col-right{padding:14px}',
    '#ts-scan-opts{grid-template-columns:1fr}',
    '.ts-body-col{padding:12px 14px}',
    '.ts-s2-top > div{min-width:0;flex:1 1 100%}',
    '.ts-script-row{flex-wrap:wrap;gap:6px}',
    '.ts-script-row .ts-script-cmd{flex:1 1 100%}',
    '.ts-id-cols{flex-direction:column}',
    '.ts-id-col{width:100%}',
    '.ts-steps .ts-step:not(.active) span{display:none}',
    '.ts-browser-toolbar{flex-wrap:wrap}',
    '.ts-browser-toolbar .ts-filter-input{flex:1 1 100%}',
    // Browser rows on two lines: name on the first, date / sizes / in stash below it
    '.ts-wizard .ts-dir-row{display:grid;grid-template-columns:22px minmax(0,1fr) 68px 44px 68px 28px;',
    'grid-template-areas:"icon name name name name cb" ". date size known ssize cb";column-gap:6px;row-gap:2px}',
    '.ts-wizard .ts-dir-icon{grid-area:icon}',
    '.ts-wizard .ts-dir-name{grid-area:name}',
    '.ts-wizard .ts-dir-date{grid-area:date;width:auto;text-align:left;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ts-wizard .ts-dir-size{grid-area:size}',
    '.ts-wizard .ts-dir-known{grid-area:known}',
    '.ts-wizard .ts-dir-ssize{grid-area:ssize}',
    '.ts-wizard .ts-dir-cb,.ts-wizard .ts-dir-cb-sp{grid-area:cb;align-self:center;justify-self:center}',
    '.ts-wizard .ts-dir-size,.ts-wizard .ts-dir-ssize{width:auto;font-size:12px}',
    '.ts-wizard .ts-dir-known{width:auto;font-size:12px}',
    '.ts-wizard .ts-dir-head > div{white-space:normal;line-height:1.1}',
    '.ts-logtip{max-width:92vw}',
    '}',
  ].join('');

  // ── Render helpers ────────────────────────────────────────────────────────────

  function buildBreadcrumb(path) {
    if (!path || path === '/') {
      return '<div class="ts-breadcrumb"><span class="ts-crumb-current">/</span></div>';
    }
    var parts = path.replace(/\/$/, '').split('/').filter(Boolean);
    // Targets are referred to by index: a path may contain quotes
    state.crumbs = ['/'];
    var html = '<div class="ts-breadcrumb">';
    html += '<button class="ts-crumb" onclick="tsCrumb(0)">/</button>';
    for (var i = 0; i < parts.length; i++) {
      html += '<span class="ts-crumb-sep">/</span>';
      var seg = parts[i];
      if (i === parts.length - 1) {
        html += '<span class="ts-crumb-current">' + esc(seg) + '</span>';
      } else {
        state.crumbs.push('/' + parts.slice(0, i + 1).join('/'));
        html += '<button class="ts-crumb" onclick="tsCrumb(' + (state.crumbs.length - 1) + ')">' + esc(seg) + '</button>';
      }
    }
    html += '</div>';
    return html;
  }

  function isSelected(path) {
    return state.selectedPaths.indexOf(path) >= 0;
  }

  function buildBrowserRows() {
    if (state.browserLoading) {
      return '<div style="padding:20px;text-align:center;color:var(--fg2)">' +
        '<span class="ts-spinner"></span> Loading...</div>';
    }
    if (state.browserError) {
      return '<div class="ts-load-error" style="margin:10px">Could not list this folder: ' + esc(state.browserError) + '</div>';
    }
    var list = getFilteredSortedEntries();
    state.rowPaths = list.map(function (e) { return e.path; });
    if (!list.length) {
      var msg = state.filter || browserFiltersActive() ? 'Nothing matches your filters.' : 'Empty folder.';
      return '<div style="padding:16px;text-align:center;color:var(--fg2);font-size:12px">' + msg + '</div>';
    }
    return list.map(function (e, i) {
      var sel = isSelected(e.path);
      // Folder: name opens it. File: name selects it.
      var open = e.dir ? 'tsRowOpen(' + i + ')' : 'tsRowSelect(' + i + ')';
      var known = state.stashKnown[e.path] === true;
      return '<div class="ts-dir-row' + (sel ? ' sel' : '') + (e.dir ? '' : ' file') + (known ? ' known' : '') +
        (e.path === state.focusPath ? ' focus' : '') + '">' +
        (!e.dir && previewKind(e.path)
          ? '<div class="ts-dir-icon"><button class="ts-dir-play" title="Preview" aria-label="Preview" onclick="tsPreview(' + i + ')">&#9654;</button></div>'
          : '<div class="ts-dir-icon" onclick="' + open + '">' + (e.dir ? '&#128193;' : '&#128196;') + '</div>') +
        '<div class="ts-dir-name" onclick="' + open + '" title="' + esc(e.path) + '">' + esc(e.name || basename(e.path)) + '</div>' +
        '<div class="ts-dir-date">' + (e.mtime ? esc(new Date(e.mtime * 1000).toLocaleString()) : '—') + '</div>' +
        '<div class="ts-dir-size">' + sizeHtml(e.path) + '</div>' +
        '<div class="ts-dir-known">' + inStashHtml(e.path) + '</div>' +
        '<div class="ts-dir-ssize">' + stashSizeHtml(e.path) + '</div>' +
        '<div class="ts-dir-cb' + (sel ? ' checked' : '') + '" title="' + (sel ? 'Deselect' : 'Select for the scan') + '" onclick="tsRowSelect(' + i + ')">' +
          (sel ? '&#10003;' : '') +
        '</div>' +
      '</div>';
    }).join('');
  }

  function buildSelectedPaths() {
    if (!state.selectedPaths.length) {
      return '<span style="font-size:11px;color:var(--fg2);font-family:monospace">No paths selected</span>';
    }
    return state.selectedPaths.map(function (p, i) {
      var sz = sizeHtml(p);
      return '<span class="ts-sel-chip"><span class="ts-sel-path" title="Show in the browser" onclick="tsGotoSel(' + i + ')">' + esc(p) + '</span>' + (sz ? '<span class="ts-sel-size">' + sz + '</span>' : '') +
        '<span class="ts-sel-x" title="Deselect" onclick="tsDeselectIdx(' + i + ')">&times;</span></span>';
    }).join('');
  }

  // Clickable column headers of the browser
  function buildBrowserHead() {
    function col(label, key, cls) {
      var active = state.sort === key;
      var arrow = active ? (state.sortDir === 1 ? ' &#8593;' : ' &#8595;') : '';
      return '<div class="' + cls + ' ts-col-sort' + (active ? ' active' : '') + '" onclick="tsSetSort(\'' + key + '\')" ' +
        'title="Sort by ' + label.toLowerCase() + '">' + label + arrow + '</div>';
    }
    return '<div class="ts-dir-row ts-dir-head">' +
      '<div class="ts-dir-icon"></div>' +
      col('Name', 'name', 'ts-dir-name') +
      col('Date', 'date', 'ts-dir-date') +
      col('Size', 'size', 'ts-dir-size') +
      col('In stash', 'instash', 'ts-dir-known') +
      col('Size in stash', 'stashsize', 'ts-dir-ssize') +
      '<div class="ts-dir-cb-sp"></div>' +
    '</div>';
  }

  function buildScanOpts() {
    return SCAN_OPTS.map(function (o) {
      var on = !!state.scanOpts[o.key];
      return '<div class="ts-opt-row' + (on ? ' on' : '') + '" onclick="tsToggleOpt(\'' + o.key + '\')">' +
        '<span class="ts-opt-label">' + esc(o.label) + '</span>' +
        '<div class="ts-opt-cb' + (on ? ' on' : '') + '">' + (on ? '&#10003;' : '') + '</div>' +
      '</div>';
    }).join('');
  }

  function buildSchedSection() {
    var html = '<div class="ts-sched-types">';
    var types = [
      { k: 'manual', l: 'Manual' },
      { k: 'once',   l: 'Once'   },
      { k: 'daily',  l: 'Daily'  },
      { k: 'weekly', l: 'Weekly' },
    ];
    types.forEach(function (t) {
      html += '<button class="ts-sched-btn' + (state.schedType === t.k ? ' active' : '') + '" ' +
        'onclick="tsSetSchedType(\'' + t.k + '\')">' + t.l + '</button>';
    });
    html += '</div>';

    var dt = 'background:var(--bg);border:1px solid var(--border);border-radius:6px;' +
      'padding:6px 9px;color:var(--fg);font-size:12px;font-family:monospace;color-scheme:dark;width:100%;box-sizing:border-box';

    if (state.schedType === 'manual') {
      html += '<div class="ts-script-hint">Starts only when you click Run or Run All Manual.</div>';
    } else if (state.schedType === 'once') {
      html += '<div><label class="ts-label">Date &amp; time' + (stashTimeNote() ? ' (your local time)' : '') +
        ' <span style="color:var(--danger)">*</span></label>' +
        '<input type="datetime-local" id="ts-sched-at" style="' + dt + '" value="' + esc(state.schedAt) + '" /></div>';
    } else if (state.schedType === 'daily') {
      html += '<div><label class="ts-label">Time' + esc(stashTimeNote()) + '</label>' +
        '<input type="time" id="ts-sched-time" style="' + dt + ';width:120px" value="' + esc(state.schedTime) + '" /></div>';
    } else if (state.schedType === 'weekly') {
      html += '<div><label class="ts-label">Time' + esc(stashTimeNote()) + '</label>' +
        '<input type="time" id="ts-sched-time" style="' + dt + ';width:120px" value="' + esc(state.schedTime) + '" /></div>';
      html += '<div style="margin-top:10px"><label class="ts-label">Days</label>' +
        '<div style="display:flex;gap:5px;flex-wrap:wrap">';
      ALL_DAYS.forEach(function (d) {
        var active = state.schedDays.indexOf(d) >= 0;
        html += '<button class="ts-day-btn' + (active ? ' active' : '') + '" onclick="tsToggleDay(\'' + d + '\')">' + d + '</button>';
      });
      html += '</div></div>';
    }
    return html;
  }

  function readSchedInputs() {
    var at = document.getElementById('ts-sched-at');
    var ti = document.getElementById('ts-sched-time');
    if (at) state.schedAt   = at.value;
    if (ti) state.schedTime = ti.value;
  }

  // ── Table render ──────────────────────────────────────────────────────────────

  var ICONS = {
    edit:   '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    run:    '<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
    rerun:  '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>',
    stop:   '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
    clock:  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
    history: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/><polyline points="12 7 12 12 15 14"/></svg>',
    del:    '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>'
  };

  var TASK_COLS = ['', 'Name', 'Paths', 'Schedule', 'Next Run', 'Status', 'Started', 'Ended'];
  var TASK_COL_CLS = ['c-run', 'c-name', 'c-paths', 'c-sched', 'c-next', 'c-status', 'c-start', 'c-end'];

  var TASK_FILTERS = [
    { key: 'all',       label: 'All' },
    { key: 'active',    label: 'Pending / Running' },
    { key: 'manual',    label: 'Manual' },
    { key: 'scheduled', label: 'Scheduled' }
  ];

  function matchesFilter(t, f) {
    if (f === 'active')    return t.status === 'pending' || t.status === 'queued' || t.status === 'running';
    if (f === 'manual')    return isManual(t);
    if (f === 'scheduled') return !isManual(t);
    return true;
  }

  // Display filter only: the underlying order (used for sequential runs) never changes
  function filteredTasks() {
    return state.tasks.filter(function (t) { return matchesFilter(t, state.taskFilter); });
  }

  function renderFilters() {
    var el = document.getElementById('ts-filters');
    if (!el) return;
    el.innerHTML = TASK_FILTERS.map(function (f) {
      var n = state.tasks.filter(function (t) { return matchesFilter(t, f.key); }).length;
      return '<button class="ts-flt' + (state.taskFilter === f.key ? ' active' : '') + '" onclick="tsSetTaskFilter(\'' + f.key + '\')">' +
        esc(f.label) + ' <span class="ts-flt-n">' + n + '</span></button>';
    }).join('');
    var runnable = state.tasks.filter(function (t) {
      return isManual(t) && t.status !== 'running' && t.status !== 'queued' && (t.paths || []).length;
    }).length;
    var ra = document.getElementById('ts-runall');
    if (ra) {
      ra.disabled = !runnable;
      ra.innerHTML = ICONS.run + ' Run All Manual (' + runnable + ')';
    }
  }

  window.tsSetTaskFilter = function (f) {
    state.taskFilter = f;
    renderTable();
  };

  function isActive(t) { return t.status === 'running' || (t.status === 'queued' && !!t.job_id); }
  function isWaiting(t) { return t.status === 'queued' && !t.job_id; }

  function isManual(t) { return !t.schedule || !t.schedule.type || t.schedule.type === 'manual'; }

  function reorderButtons(t) {
    if (!isManual(t) || (state.taskFilter !== 'all' && state.taskFilter !== 'manual')) return '<span class="ts-reorder"></span>';
    var idx = state.tasks.indexOf(t), prev = null, next = null, i;
    for (i = idx - 1; i >= 0; i--) if (isManual(state.tasks[i])) { prev = state.tasks[i]; break; }
    for (i = idx + 1; i < state.tasks.length; i++) if (isManual(state.tasks[i])) { next = state.tasks[i]; break; }
    // A task already handed to Stash (running) can neither move nor be passed over;
    // tasks still waiting in the plugin queue can move freely.
    var movable = !isActive(t);
    var canUp = movable && prev && !isActive(prev);
    var canDown = movable && next && !isActive(next);
    return '<span class="ts-reorder">' +
      '<button class="ts-mv" title="Move up" aria-label="Move up"' + (canUp ? '' : ' disabled') + ' onclick="tsMove(' + t.id + ',\'up\')">' +
        '<svg viewBox="0 0 24 24"><polyline points="6 15 12 9 18 15"/></svg></button>' +
      '<button class="ts-mv" title="Move down" aria-label="Move down"' + (canDown ? '' : ' disabled') + ' onclick="tsMove(' + t.id + ',\'down\')">' +
        '<svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg></button>' +
      '</span>';
  }

  // Two paths shown; more are folded behind a "+N" chip that expands the full list
  function pathChips(t) {
    var all = t.paths || [];
    var chips = savedSizeChips(all, t.sizes);
    var total = savedSizeTotal(all, t.sizes);
    total = total ? '<div class="ts-size-note">' + esc(total) + '</div>' : '';
    if (all.length <= 2) return chips.join(' ') + total;
    if (state.expandedPaths[t.id]) {
      return '<div class="ts-paths-all">' + chips.join(' ') + '</div>' +
        '<button class="ts-chip ts-more" title="Show fewer paths" onclick="tsTogglePaths(' + t.id + ')">Show less</button>' + total;
    }
    return chips.slice(0, 2).join(' ') +
      ' <button class="ts-chip ts-more" title="Show all ' + all.length + ' paths" onclick="tsTogglePaths(' + t.id + ')">+' + (all.length - 2) + '</button>' + total;
  }

  // Sizes saved with a task or a history entry: {path: {bytes, complete}}
  function savedSize(s) {
    return s && typeof s.bytes === 'number' ? (s.complete === false ? '≥ ' : '') + fmtBytes(s.bytes) : '';
  }

  function savedSizeChips(paths, sizes) {
    return paths.map(function (p) {
      var sz = savedSize((sizes || {})[p]);
      return '<span class="ts-chip" title="' + esc(p + (sz ? ' — ' + sz : '')) + '">' + esc(basename(p)) + '</span>';
    });
  }

  function savedSizeTotal(paths, sizes) {
    var sum = 0, known = 0, partial = false;
    paths.forEach(function (p) {
      var s = (sizes || {})[p];
      if (!s || typeof s.bytes !== 'number') { partial = true; return; }
      sum += s.bytes; known++;
      if (s.complete === false) partial = true;
    });
    return known ? 'Total ' + (partial ? '≥ ' : '') + fmtBytes(sum) : '';
  }

  window.tsTogglePaths = function (id) {
    state.expandedPaths[id] = !state.expandedPaths[id];
    renderTable();
  };

  window.tsMove = function (id, dir) {
    callApi({ action: 'move', id: id, direction: dir }).then(refresh);
  };

  function renderTableHead() {
    var thead = document.getElementById('ts-thead');
    if (!thead) return;
    thead.innerHTML = '<tr>' + TASK_COLS.map(function (c, i) { return '<th class="' + TASK_COL_CLS[i] + '">' + c + '</th>'; }).join('') +
      '<th style="text-align:right">Actions</th></tr>';
  }

  function hasIdentify(t) {
    var idf = t.identify || {};
    return !!(idf.enabled && (idf.sources || []).length);
  }

  // pre -> scan -> post -> identify progress, shown for tasks that do more than a scan
  function scriptStages(t) {
    var sc = t.scripts || {};
    var pre = (sc.pre || []).length, post = (sc.post || []).length, idf = hasIdentify(t);
    if (!pre && !post && !idf) return '';
    var stages = [];
    if (pre) stages.push('pre');
    stages.push('scan');
    if (post) stages.push('post');
    if (idf) stages.push('identify');
    var cur = -1, failed = -1, allDone = false;
    if (t.status === 'done') allDone = true;
    else if (t.status === 'error') failed = stages.indexOf(t.failed_phase || 'scan');
    else if (t.status === 'running' || t.status === 'queued') {
      if (t.phase === 'pre' || t.phase === 'post' || t.phase === 'identify') cur = stages.indexOf(t.phase);
      else if (t.job_id || t.status === 'running') cur = stages.indexOf('scan');
    }
    return stages.map(function (st, i) {
      var cls = 'ts-stg', mark = '';
      if (allDone || (failed < 0 && cur >= 0 && i < cur) || (failed >= 0 && i < failed)) { cls += ' ok'; mark = '\u2713 '; }
      else if (i === cur) cls += ' cur';
      else if (i === failed) { cls += ' bad'; mark = '\u2717 '; }
      var n = st === 'pre' ? pre : (st === 'post' ? post : 0);
      var attrs = st === 'scan' ? ' title="Stash scan"'
        : st === 'identify' ? ' title="Stash Identify: ' + esc(t.identify.sources.map(function (s) { return s.name; }).join(' › ')) + '"'
        : ' data-tid="' + t.id + '" data-ph="' + st + '"';
      return '<span class="' + cls + '"' + attrs + '>' + mark + st + (n ? ' (' + n + ')' : '') + '</span>';
    }).join('<span class="ts-stg-arrow">\u203A</span>');
  }

  // ── Log tooltip on the pre / post stages ─────────────────────────────────────

  var tip = { el: null, anchor: null, tid: null, ph: null, poll: null, hide: null };

  function tipWithin(node) {
    return !!(node && node.closest && (node.closest('.ts-stg[data-ph]') || node.closest('#ts-logtip')));
  }

  function tipPlace() {
    if (!tip.el || !tip.anchor) return;
    var r = tip.anchor.getBoundingClientRect();
    var w = tip.el.offsetWidth || 400, h = tip.el.offsetHeight || 200;
    var left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    tip.el.style.left = left + 'px';
    tip.el.style.top = top + 'px';
  }

  function tipFill() {
    var tid = tip.tid, ph = tip.ph;
    var t = state.tasks.filter(function (x) { return x.id === tid; })[0];
    callApi({ action: 'getlog', id: tid, phase: ph }).then(function (res) {
      if (!tip.el || tip.tid !== tid || tip.ph !== ph) return;
      var n = t && t.scripts && t.scripts[ph] ? t.scripts[ph].length : 0;
      var atEnd = tip.el.scrollTop + tip.el.clientHeight >= tip.el.scrollHeight - 4;
      tip.el.innerHTML = '<div class="ts-tip-hdr">' + (ph === 'pre' ? 'Before the scan' : 'After the scan') +
        ' \u2014 ' + n + ' script' + (n === 1 ? '' : 's') + (t ? ' \u2014 ' + esc(t.name) : '') + '</div>' +
        '<div class="ts-tip-cmds">' + ((t && t.scripts && t.scripts[ph]) || []).map(function (x) {
          return '<div class="ts-tip-cmd">\u25B8 ' + esc(x.cmd) + (x['continue'] ? ' <span class="ts-tip-flag">(continue on failure)</span>' : '') + '</div>';
        }).join('') + '</div>' +
        '<div class="ts-tip-sub">Log</div>' +
        '<pre>' + (res && res.log ? esc(res.log) : 'No output yet.') + '</pre>';
      if (atEnd) tip.el.scrollTop = tip.el.scrollHeight;
      tipPlace();
    });
  }

  function tipOpen(anchor) {
    clearTimeout(tip.hide);
    var tid = parseInt(anchor.getAttribute('data-tid'), 10), ph = anchor.getAttribute('data-ph');
    if (tip.el && tip.tid === tid && tip.ph === ph) { tip.anchor = anchor; return; }
    if (!tip.el) {
      tip.el = document.createElement('div');
      tip.el.id = 'ts-logtip';
      tip.el.className = 'ts-logtip';
      document.body.appendChild(tip.el);
    }
    tip.anchor = anchor; tip.tid = tid; tip.ph = ph;
    tip.el.innerHTML = '<div class="ts-tip-hdr">Loading\u2026</div>';
    tipPlace();
    tipFill();
    clearInterval(tip.poll);
    tip.poll = setInterval(function () {
      // the table is redrawn on every refresh: follow the new element, or close
      var again = document.querySelector('.ts-stg[data-tid="' + tip.tid + '"][data-ph="' + tip.ph + '"]');
      if (!again) { tipClose(); return; }
      tip.anchor = again;
      tipFill();
    }, 2000);
  }

  function tipClose() {
    clearInterval(tip.poll);
    clearTimeout(tip.hide);
    if (tip.el && tip.el.parentNode) tip.el.parentNode.removeChild(tip.el);
    tip.el = null; tip.anchor = null; tip.tid = null; tip.ph = null;
  }

  document.addEventListener('mouseover', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('.ts-stg[data-ph]') : null;
    if (a) tipOpen(a);
    else if (tip.el && tipWithin(e.target)) clearTimeout(tip.hide);
  });

  document.addEventListener('mouseout', function (e) {
    if (!tip.el || tipWithin(e.relatedTarget)) return;
    clearTimeout(tip.hide);
    tip.hide = setTimeout(tipClose, 250);
  });

  function renderTable() {
    renderTableHead();
    renderFilters();
    var tbody = document.getElementById('ts-tbody');
    if (!tbody) return;
    if (!state.tasks.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="ts-empty">' +
        'No tasks yet. Click <strong>+ New Task</strong> to create one.</td></tr>';
      return;
    }
    // Position of each waiting task in the plugin queue (list order = run order)
    var queuePos = {}, qn = 0;
    state.tasks.forEach(function (x) { if (isWaiting(x)) queuePos[x.id] = ++qn; });
    var visible = filteredTasks();
    if (!visible.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="ts-empty">No tasks match this filter.</td></tr>';
      return;
    }
    tbody.innerHTML = visible.map(function (t) {
      var togCls = 'ts-task-tog' + (t.enabled ? ' on' : '');
      var toggle = '<button class="' + togCls + '" title="' + (t.enabled ? 'Scheduled runs enabled (click to disable)' : 'Scheduled runs disabled (click to enable)') + '" onclick="tsToggleTask(' + t.id + ')">' +
        '<span class="ts-task-tog-thumb"></span></button>';

      var statusCell;
      if (t.status === 'running') {
        var known = typeof t.progress === 'number';
        var pct = known ? Math.max(0, Math.min(100, Math.round(t.progress))) : 0;
        statusCell = '<span class="ts-badge running"><span class="ts-dot"></span>Running</span>' +
          (known ? '<span class="ts-mono"> ' + pct + '%</span>' : '') +
          '<div class="ts-prog-bg" title="Stash reported progress: ' + esc(String(t.job_raw)) + '"><div class="ts-prog-fill' + (known ? '' : ' ts-indet') + '"' +
            (known ? ' style="width:' + pct + '%"' : '') + '></div></div>' +
          (t.job_info ? '<div class="ts-mono" style="font-size:11px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(t.job_info) + '">' + esc(t.job_info) + '</div>' : '');
      } else {
        var labels = { pending: 'Pending', queued: 'Queued', paused: 'Paused', done: 'Done', error: 'Error', missed: 'Missed' };
        var cls = t.status || 'paused';
        var badgeTip = t.status === 'missed' ? missedTip(t) : (t.error_info || '');
        statusCell = '<span class="ts-badge ' + cls + '"' + (badgeTip ? ' title="' + esc(badgeTip) + '"' : '') + '><span class="ts-dot"></span>' +
          esc(labels[t.status] || t.status) + (queuePos[t.id] ? ' #' + queuePos[t.id] : '') + '</span>' +
          (t.status === 'error' && t.error_info ? '<div class="ts-mono" style="font-size:11px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--danger)" title="' + esc(t.error_info) + '">' + esc(t.error_info) + '</div>' : '');
      }
      // A run missed while this task was still busy: noted without replacing its status
      if (t.missed_at && t.status !== 'missed') {
        statusCell += '<div class="ts-missed-note" title="' + esc(missedTip(t)) + '">Missed ' + esc(fmtDate(t.missed_at)) + '</div>';
      }

      var paths = pathChips(t);

      var isRunning = t.status === 'running' || t.status === 'queued';

      // Main action, in its own column next to the name (after the reorder arrows)
      var runCell = reorderButtons(t);
      if (isRunning) {
        runCell += '<button class="ts-run stop" title="Stop this task" onclick="tsStop(' + t.id + ')">' + ICONS.stop + '<span>Stop</span></button>';
      } else if (!isManual(t)) {
        // Scheduled tasks only start at their planned time: no manual run
        runCell += '<button class="ts-run sched" disabled title="Scheduled task: starts only at its planned time">' + ICONS.clock + '<span>Scheduled</span></button>';
      } else {
        var rerun = t.status === 'done';
        runCell += '<button class="ts-run" title="' + (rerun ? 'Run this task again' : 'Run this task') + '" onclick="tsRun(' + t.id + ')">' +
          (rerun ? ICONS.rerun : ICONS.run) + '<span>' + (rerun ? 'Re-run' : 'Run') + '</span></button>';
      }

      // Secondary actions; hidden ones keep their place so the columns stay aligned
      var hide = isRunning ? ' style="visibility:hidden"' : '';
      var actions = toggle + ' ' +
        '<button class="ts-act" title="Run history" aria-label="Run history" onclick="tsHistory(' + t.id + ')">' + ICONS.history + '</button> ' +
        '<button class="ts-act" title="Edit" aria-label="Edit" onclick="tsEdit(' + t.id + ')"' + hide + '>' + ICONS.edit + '</button>' +
        '<span class="ts-act-sep"></span>' +
        '<button class="ts-act danger" title="Delete" aria-label="Delete" onclick="tsAskDelete(' + t.id + ',\'' + esc(t.name) + '\')"' + hide + '>' +
          ICONS.del + '</button>';

      var stages = scriptStages(t);
      if (stages) statusCell += '<div class="ts-stages">' + stages + '</div>';
      // Errors Stash logged during the current run, or the last one (details in the history)
      var nErr = (t.stash_errors || []).length + (t.stash_errors_dropped || 0) || t.last_stash_errors || 0;
      if (nErr) {
        statusCell += '<div class="ts-stash-err" onclick="tsHistory(' + t.id + ')" title="Errors Stash logged while ' +
          (t.log_cursor ? 'this run is active' : 'the last run was active') + ' (click for the run history)">&#9888; ' +
          nErr + ' Stash error' + (nErr > 1 ? 's' : '') + '</div>';
      }
      var timesTip = 'Started: ' + fmtDate(t.started) + '  \u2022  Ended: ' + fmtDate(t.ended);

      // data-label + .ts-cell let the phone layout turn each row into a card
      return '<tr>' +
        '<td class="c-run" data-label="Run"><div class="ts-cell">' + runCell + '</div></td>' +
        '<td class="c-name" data-label="Name" style="max-width:160px;font-weight:500;word-break:break-word"><div class="ts-cell">' + esc(t.name) + '</div></td>' +
        '<td class="c-paths" data-label="Paths"><div class="ts-cell">' + (paths || '<span style="color:var(--fg2)">—</span>') + '</div></td>' +
        '<td class="ts-mono c-sched" data-label="Schedule"><div class="ts-cell">' + esc(schedLabel(t.schedule)) + '</div></td>' +
        '<td class="ts-mono c-next" data-label="Next run"><div class="ts-cell">' + (nextRun(t) ? esc(fmtLocal(nextRun(t))) : '—') + '</div></td>' +
        '<td class="c-status" data-label="Status" title="' + esc(timesTip) + '"><div class="ts-cell">' + statusCell + '</div></td>' +
        '<td class="ts-mono c-start" data-label="Started"><div class="ts-cell">' + esc(fmtDate(t.started)) + '</div></td>' +
        '<td class="ts-mono c-end" data-label="Ended"><div class="ts-cell">' + esc(fmtDate(t.ended)) + '</div></td>' +
        '<td class="c-actions" style="white-space:nowrap;text-align:right"><div class="ts-cell">' + actions + '</div></td>' +
        '</tr>';
    }).join('');
  }

  function renderLoadError() {
    var el = document.getElementById('ts-load-error');
    if (!el) return;
    el.hidden = !state.loadError;
    el.textContent = state.loadError
      ? 'Could not refresh the task list (retrying every ' + (POLL_INTERVAL / 1000) + ' s). ' +
        'The table shows the last known state. Error: ' + state.loadError
      : '';
  }

  function renderGlobalToggle() {
    var btn = document.getElementById('ts-global-toggle');
    var lbl = document.getElementById('ts-global-label');
    if (!btn || !lbl) return;
    btn.className = 'ts-tog' + (state.globalEnabled ? ' on' : '');
    lbl.className = 'ts-global-lbl' + (state.globalEnabled ? ' on' : '');
    lbl.textContent = state.globalEnabled ? 'Enabled' : 'Disabled';
    var dm = document.getElementById('ts-daemon');
    if (dm) {
      var sch = state.scheduler, info = state.schedulerInfo || {};
      var last = info.last_pass ? ' Last pass: ' + fmtDate(info.last_pass) + '.' : ' No pass recorded yet.';
      dm.className = 'ts-daemon' + (sch ? ' on' : '');
      if (sch === undefined) {
        dm.textContent = '';
      } else if (sch) {
        dm.textContent = '\u25CF Scheduler running' + (sch === 'external' ? ' (external trigger)' : ' (cron)');
        dm.title = (sch === 'external'
          ? 'An external trigger calls the scheduler through Stash\u2019s API.'
          : 'Cron in the Stash container runs the scheduler.') +
          ' Scheduled tasks fire and the queue advances without this page.' + last;
      } else if (info.crond === false) {
        dm.textContent = '\u25CB Scheduler not set up';
        dm.title = 'No cron daemon in this container: scheduled tasks need an external trigger calling ' +
          'Stash once a minute (see the plugin README, "Scheduling").' + last;
      } else {
        dm.textContent = '\u25CB Scheduler stopped';
        dm.title = 'No scheduler pass recently; the plugin is restarting cron (scheduled starts in between ' +
          'are marked Missed).' + last + (state.schedulerNote ? ' Last attempt: ' + state.schedulerNote : '');
      }
    }
  }

  // ── Wizard modal ──────────────────────────────────────────────────────────────

  function openWizard(taskId) {
    state.editingId = taskId || null;
    state.wizardStep = 1;
    var t = taskId ? state.tasks.find(function (x) { return x.id === taskId; }) : null;
    if (t) {
      state.taskName = t.name || '';
      state.selectedPaths = (t.paths || []).slice();
      var opts = t.options || {};
      state.scanOpts = {};
      SCAN_OPTS.forEach(function (o) {
        state.scanOpts[o.key] = opts[o.key] !== undefined ? !!opts[o.key] : o.def;
      });
      var sc = t.schedule || {};
      state.schedType = sc.type || 'manual';
      state.schedTime = sc.time || '02:00';
      state.schedAt   = sc.type === 'once' ? toInputLocal(parseServerDate(sc.at)) : '';
      state.schedDays = (sc.days || []).slice();
      state.scripts = emptyScripts();
      ['pre', 'post'].forEach(function (ph) {
        ((t.scripts || {})[ph] || []).forEach(function (x) {
          state.scripts[ph].push({ cmd: x.cmd || '', cont: !!x['continue'] });
        });
      });
      var idf = t.identify || {};
      state.identify = { enabled: !!idf.enabled, sources: JSON.parse(JSON.stringify(idf.sources || [])) };
    } else {
      state.scripts = fromServerScripts(state.scriptDefaults);
      state.taskName = nextTaskName();
      state.selectedPaths = [];
      state.scanOpts = defaultScanOpts();
      state.schedType = 'manual';
      state.schedTime = '02:00';
      state.schedAt   = '';
      state.schedDays = [];
      state.identify = { enabled: false, sources: [] };
    }
    state.idFilter = '';
    loadIdentifyCatalog();
    // Start browser at root or first known path
    var startPath = '/';
    if (knownPaths.length) startPath = knownPaths[0];
    // If editing and has paths, start at first path's parent
    if (state.selectedPaths.length) {
      var parts = state.selectedPaths[0].split('/');
      parts.pop();
      startPath = parts.join('/') || '/';
    }
    state.sort = 'name';
    state.sortDir = 1;
    state.filter = '';
    state.bf = defaultBrowserFilters();
    state.browserEntries = [];
    state.browserError = null;
    state.browserLoading = false;
    // Sizes saved with the task fill the cache (nothing is re-measured on edit)
    if (t && t.sizes) {
      Object.keys(t.sizes).forEach(function (p) {
        var s = state.sizes[p];
        if (!s || s.error) state.sizes[p] = { bytes: t.sizes[p].bytes, complete: t.sizes[p].complete !== false };
      });
    }
    // What Stash knows changes with every scan: ask again each time the wizard opens
    _stashGen++;
    state.stashKnown = {};
    state.stashListing = {};
    state.stashSizes = {};
    state.stashQueue = [];
    state.stashBusy = false;
    state.selectedPaths.forEach(requestStashSize);

    var ov = document.getElementById('ts-wizard-overlay');
    var modal = document.getElementById('ts-wizard-modal');
    modal.classList.remove('ts-compact');
    ov.classList.remove('hidden');
    renderWizardStep1();
    loadBrowserDir(startPath);
  }

  var STEP_LABELS = ['Name & Paths', 'Scan Options & Schedule', 'Scripts', 'Identify'];

  function buildSteps(active) {
    var out = '<div class="ts-steps">';
    STEP_LABELS.forEach(function (label, i) {
      var n = i + 1;
      var cls = n < active ? ' done' : (n === active ? ' active' : '');
      if (i) out += '<div class="ts-step-sep"></div>';
      out += '<div class="ts-step' + cls + '"><div class="ts-step-num">' + (n < active ? '&#10003;' : n) +
        '</div><span>' + esc(label) + '</span></div>';
    });
    return out + '</div>';
  }

  function renderWizardStep1() {
    var isEdit = !!state.editingId;
    var modal = document.getElementById('ts-wizard-modal');
    if (!modal) return;
    modal.innerHTML =
      '<div class="ts-modal-hdr">' +
        '<div class="ts-modal-title">' + (isEdit ? 'Edit Task' : 'New Task') + '</div>' +
        '<button class="ts-modal-close" onclick="tsCloseWizard()">&times;</button>' +
      '</div>' +
      buildSteps(1) +
      '<div class="ts-wizard-body">' +
        '<div class="ts-col-left" id="ts-browser-col">' +
          '<div class="ts-name-row">' +
            '<div class="ts-name-col"><div class="ts-section-title">Task Name</div>' +
              '<input class="ts-input" id="ts-task-name" value="' + esc(state.taskName) + '" placeholder="Task name" /></div>' +
            '<div class="ts-lib-col"><div class="ts-section-title">Library paths</div>' + buildQuickPaths() + '</div>' +
          '</div>' +
          '<div class="ts-section-title">Selected paths <span class="ts-sel-total" id="ts-sel-total"></span></div>' +
          '<div class="ts-sel-list" id="ts-sel-list"></div>' +
          '<div class="ts-section-title" style="margin-top:8px">Folders and files to scan</div>' +
          '<div id="ts-breadcrumb-wrap"></div>' +
          '<div class="ts-browser-toolbar">' +
            '<input class="ts-filter-input" id="ts-filter-input" placeholder="Filter (space-separated terms)..." value="' + esc(state.filter) + '" />' +
          '</div>' +
          '<div class="ts-browser-filters" id="ts-browser-filters">' + buildBrowserFilters() + '</div>' +
          '<div id="ts-browser-head"></div>' +
          '<div id="ts-browser-rows"></div>' +
        '</div>' +
      '</div>' +
      '<div class="ts-modal-footer">' +
        '<button class="ts-btn-ghost" onclick="tsCloseWizard()">Cancel</button>' +
        '<button class="ts-btn ts-btn-primary" onclick="tsWizardNext()">Next: Scan Options &#8594;</button>' +
      '</div>';

    renderBrowser();
  }

  function buildQuickPaths() {
    if (!knownPaths.length) return '<select class="ts-input" disabled><option>No library paths configured</option></select>';
    return '<select class="ts-input" id="ts-quick-paths" onchange="tsQuickPath(this)">' +
      '<option value="">Go to a library path...</option>' +
      knownPaths.map(function (p) {
        return '<option value="' + esc(p) + '">' + esc(p) + '</option>';
      }).join('') + '</select>';
  }

  function renderBrowser() {
    var bw = document.getElementById('ts-breadcrumb-wrap');
    if (bw) bw.innerHTML = buildBreadcrumb(state.browserPath);
    renderBrowserBody();
  }

  // Headers, rows and selection; the filter input is left alone so typing keeps its focus
  function renderBrowserBody() {
    var bh = document.getElementById('ts-browser-head');
    if (bh) bh.innerHTML = buildBrowserHead();
    var br = document.getElementById('ts-browser-rows');
    if (br) {
      var top = br.scrollTop;
      br.innerHTML = buildBrowserRows();
      br.scrollTop = top;
    }
    var sl = document.getElementById('ts-sel-list');
    if (sl) sl.innerHTML = buildSelectedPaths();
    var st = document.getElementById('ts-sel-total');
    if (st) st.textContent = sizeTotal(state.selectedPaths);
  }

  // Step 2: each selected path with its size, and the total to scan
  function buildStep2Paths() {
    if (!state.selectedPaths.length) return '<em>none</em>';
    var total = sizeTotal(state.selectedPaths);
    return state.selectedPaths.map(function (p) {
      return '<div class="ts-s2-path"><span>' + esc(p) + '</span><span class="ts-s2-size">' + sizeHtml(p) + '</span></div>';
    }).join('') + (total ? '<div class="ts-s2-path ts-s2-total"><span></span><span>' + esc(total) + '</span></div>' : '');
  }

  function renderWizardStep2() {
    var isEdit = !!state.editingId;
    var modal = document.getElementById('ts-wizard-modal');
    if (!modal) return;
    modal.innerHTML =
      '<div class="ts-modal-hdr">' +
        '<div class="ts-modal-title">' + (isEdit ? 'Edit Task' : 'New Task') + ' — ' + esc(state.taskName) + '</div>' +
        '<button class="ts-modal-close" onclick="tsCloseWizard()">&times;</button>' +
      '</div>' +
      buildSteps(2) +
      '<div class="ts-wizard-body ts-body-col">' +
        '<div class="ts-s2-top">' +
          '<div>' +
            '<div class="ts-section-title">Schedule</div>' +
            '<div id="ts-sched-section">' + buildSchedSection() + '</div>' +
          '</div>' +
          '<div>' +
            '<div class="ts-section-title">Selected paths</div>' +
            '<div class="ts-s2-paths" id="ts-s2-paths">' + buildStep2Paths() + '</div>' +
          '</div>' +
        '</div>' +
        '<div>' +
          '<div class="ts-section-title" style="margin-top:6px">Scan Options</div>' +
          '<div id="ts-scan-opts">' + buildScanOpts() + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="ts-modal-footer">' +
        '<div class="ts-footer-left">' +
          '<button class="ts-btn-ghost" onclick="tsWizardBack()">&#8592; Back</button>' +
        '</div>' +
        '<button class="ts-btn-ghost" onclick="tsCloseWizard()">Cancel</button>' +
        '<button class="ts-btn ts-btn-primary" onclick="tsWizardNext2()">Next: Scripts &#8594;</button>' +
      '</div>';
  }

  // ── Step 3: scripts run before / after the scan ───────────────────────────────

  function emptyScripts() { return { pre: [], post: [] }; }

  // server shape {cmd, continue} <-> editor shape {cmd, cont}
  function fromServerScripts(src) {
    var out = emptyScripts();
    ['pre', 'post'].forEach(function (ph) {
      ((src || {})[ph] || []).forEach(function (x) {
        out[ph].push({ cmd: x.cmd || '', cont: !!x['continue'] });
      });
    });
    return out;
  }

  function toServerScripts(sc) {
    var out = { pre: [], post: [] };
    ['pre', 'post'].forEach(function (ph) {
      (sc[ph] || []).forEach(function (x) { out[ph].push({ cmd: x.cmd, 'continue': !!x.cont }); });
    });
    return out;
  }

  function scriptHelp(nPaths) {
    return '<div class="ts-script-help">' +
      (nPaths === null
        ? 'These scripts are pre-filled in every <strong>new</strong> task; they can still be changed for each task. Existing tasks are not modified. '
        : 'Each command is run once for every selected path (' + nPaths + '), script after script, one at a time. ') +
      'Write <code>{path}</code> where the path must go: it is replaced by the path, already quoted for the shell ' +
      '(do not add quotes). The environment also gets <code>TS_PATH</code>, <code>TS_TASK_NAME</code> and <code>TS_PHASE</code>. ' +
      'Output is written to <code>logs/task_&lt;id&gt;.log</code> in the plugin folder. ' +
      'Example: <code>/scripts/prepare.sh {path}</code></div>';
  }

  function buildScriptRows(phase) {
    var list = state.scripts[phase] || [];
    var rows = list.map(function (sc, i) {
      return '<div class="ts-script-row">' +
        '<input class="ts-input ts-script-cmd" type="text" spellcheck="false" data-ts-script="' + phase + '" data-idx="' + i + '" ' +
          'placeholder="/path/to/script.sh {path}" value="' + esc(sc.cmd || '') + '" />' +
        '<label class="ts-script-cont" title="If this script fails, carry on with the next steps instead of stopping the task">' +
          '<input type="checkbox" ' + (sc.cont ? 'checked ' : '') + 'onchange="tsScriptCont(\'' + phase + '\',' + i + ',this.checked)" /> Continue on failure</label>' +
        '<button class="ts-act danger" title="Remove" aria-label="Remove" onclick="tsRemoveScript(\'' + phase + '\',' + i + ')">&times;</button>' +
      '</div>';
    }).join('');
    return rows || '<div class="ts-script-none">No script.</div>';
  }

  function buildScriptsSection() {
    var labels = { pre: 'Before the scan', post: 'After the scan' };
    var hints = {
      pre: 'Run before the scan starts. If one fails (and \u201cContinue on failure\u201d is off), the task stops with an error and the scan is not started.',
      post: 'Run after the scan has finished successfully, before the Identify (if any). They are skipped if the scan fails or is stopped.'
    };
    return ['pre', 'post'].map(function (ph) {
      return '<div class="ts-script-block">' +
        '<div class="ts-section-title">' + labels[ph] + '</div>' +
        '<div class="ts-script-hint">' + hints[ph] + '</div>' +
        '<div id="ts-scripts-' + ph + '">' + buildScriptRows(ph) + '</div>' +
        '<button class="ts-btn-ghost ts-script-add" onclick="tsAddScript(\'' + ph + '\')">+ Add script</button>' +
      '</div>';
    }).join('');
  }

  function renderWizardStep3() {
    var isEdit = !!state.editingId;
    var modal = document.getElementById('ts-wizard-modal');
    if (!modal) return;
    modal.innerHTML =
      '<div class="ts-modal-hdr">' +
        '<div class="ts-modal-title">' + (isEdit ? 'Edit Task' : 'New Task') + ' \u2014 ' + esc(state.taskName) + '</div>' +
        '<button class="ts-modal-close" onclick="tsCloseWizard()">&times;</button>' +
      '</div>' +
      buildSteps(3) +
      '<div class="ts-wizard-body ts-body-col">' +
        scriptHelp(state.selectedPaths.length) +
        buildScriptsSection() +
      '</div>' +
      '<div class="ts-modal-footer">' +
        '<div class="ts-footer-left">' +
          '<button class="ts-btn-ghost" onclick="tsWizardBack3()">&#8592; Back</button>' +
        '</div>' +
        '<button class="ts-btn-ghost" onclick="tsCloseWizard()">Cancel</button>' +
        '<button class="ts-btn ts-btn-primary" onclick="tsWizardNext3()">Next: Identify &#8594;</button>' +
      '</div>';
  }

  // ── Step 4: Identify after the scan and the post-scan scripts ─────────────────

  function idKey(s) { return s.type + '|' + (s.type === 'stashbox' ? s.endpoint : s.id); }

  function isChosen(s) {
    var k = idKey(s);
    return state.identify.sources.some(function (x) { return idKey(x) === k; });
  }

  // Sources Stash offers for Identify, and its saved Identify defaults (read-only query)
  function loadIdentifyCatalog() {
    var cat = state.idCatalog = { loading: true };
    gql('{ listScrapers(types: [SCENE]) { id name scene { supported_scrapes } } ' +
      'configuration { general { stashBoxes { endpoint name } } defaults { identify { ' +
      'sources { source { stash_box_endpoint scraper_id } options { fieldOptions { field strategy } } } ' +
      'options { fieldOptions { field strategy } } } } } }').then(function (d) {
      if (state.idCatalog !== cat) return;
      var conf = d.configuration || {};
      var boxes = ((conf.general || {}).stashBoxes || []).map(function (b) {
        return { type: 'stashbox', endpoint: b.endpoint, name: b.name || b.endpoint };
      });
      // Identify only uses scrapers that can scrape a scene from its file ("fragment")
      var scrapers = (d.listScrapers || []).filter(function (s) {
        return ((s.scene || {}).supported_scrapes || []).indexOf('FRAGMENT') >= 0;
      }).map(function (s) { return { type: 'scraper', id: s.id, name: s.name || s.id }; })
        .sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
      var idf = (conf.defaults || {}).identify || {};
      var all = boxes.concat(scrapers), byKey = {};
      all.forEach(function (s) { byKey[idKey(s)] = s; });
      var defaults = [], overwrite = {};
      function strategies(o) {
        ((o || {}).fieldOptions || []).forEach(function (f) { if (f.strategy === 'OVERWRITE') overwrite[f.field] = true; });
      }
      strategies(idf.options);
      (idf.sources || []).forEach(function (ds) {
        var src = ds.source || {};
        var s = byKey[src.stash_box_endpoint ? 'stashbox|' + src.stash_box_endpoint : 'scraper|' + src.scraper_id];
        if (s) defaults.push(s);
        strategies(ds.options);
      });
      state.idCatalog = { boxes: boxes, scrapers: scrapers, byKey: byKey, defaults: defaults, overwrite: Object.keys(overwrite) };
      if (state.wizardStep === 4) renderIdentifyBody();
    }, function (e) {
      if (state.idCatalog !== cat) return;
      state.idCatalog = { error: (e && e.message) || String(e) };
      if (state.wizardStep === 4) renderIdentifyBody();
    });
  }

  function buildIdAvailable() {
    var cat = state.idCatalog || {};
    if (cat.loading) return '<div class="ts-script-none"><span class="ts-spinner ts-spinner-sm"></span> Loading the sources from Stash…</div>';
    if (cat.error) return '<div class="ts-load-error">Could not read the sources from Stash: ' + esc(cat.error) + '</div>';
    var terms = state.idFilter.toLowerCase().split(/\s+/).filter(Boolean);
    function match(s) {
      var n = s.name.toLowerCase();
      return terms.every(function (x) { return n.indexOf(x) >= 0; });
    }
    state.idRows = [];
    function group(title, list) {
      list = list.filter(match);
      if (!list.length) return '';
      return '<div class="ts-id-group">' + title + '</div>' + list.map(function (s) {
        var i = state.idRows.push(s) - 1, on = isChosen(s);
        return '<div class="ts-dir-row ts-id-row' + (on ? ' sel' : '') + '" onclick="tsIdToggle(' + i + ')">' +
          '<div class="ts-dir-cb' + (on ? ' checked' : '') + '">' + (on ? '&#10003;' : '') + '</div>' +
          '<div class="ts-dir-name" title="' + esc(s.endpoint || s.id) + '">' + esc(s.name) + '</div></div>';
      }).join('');
    }
    var html = group('Stash-boxes', cat.boxes) + group('Scrapers', cat.scrapers);
    return html || '<div class="ts-script-none">' + (terms.length ? 'Nothing matches your filter.' : 'Stash offers no source for Identify.') + '</div>';
  }

  function buildIdChosen() {
    var list = state.identify.sources, cat = state.idCatalog || {};
    if (!list.length) return '<div class="ts-script-none">No source chosen.</div>';
    return list.map(function (s, i) {
      var gone = cat.byKey && !cat.byKey[idKey(s)];
      return '<div class="ts-id-chip' + (gone ? ' gone' : '') + '"' +
          (gone ? ' title="Not offered by Stash any more: skipped when the task runs"' : '') + '>' +
        '<span class="ts-id-num">' + (i + 1) + '</span>' +
        '<span class="ts-id-kind">' + (s.type === 'stashbox' ? 'stash-box' : 'scraper') + '</span>' +
        '<span class="ts-id-name">' + esc(s.name) + (gone ? ' (not in Stash)' : '') + '</span>' +
        '<button class="ts-act" title="Try earlier" onclick="tsIdMove(' + i + ',-1)"' + (i ? '' : ' disabled') + '>&#8593;</button>' +
        '<button class="ts-act" title="Try later" onclick="tsIdMove(' + i + ',1)"' + (i < list.length - 1 ? '' : ' disabled') + '>&#8595;</button>' +
        '<button class="ts-act danger" title="Remove" onclick="tsIdRemove(' + i + ')">&times;</button>' +
      '</div>';
    }).join('');
  }

  function buildIdWarning() {
    var cat = state.idCatalog || {};
    if (!cat.overwrite || !cat.overwrite.length) return '';
    return '<div class="ts-id-warn">&#9888; Stash’s Identify settings <strong>overwrite</strong> existing values of: ' +
      esc(cat.overwrite.join(', ')) + '. Scenes that already have them will lose them. ' +
      'Change this in Stash (Settings → Tasks → Identify) if that is not what you want.</div>';
  }

  // Everything but the filter input, so typing keeps its focus
  function renderIdentifyBody() {
    var on = state.identify.enabled;
    var w = document.getElementById('ts-id-warn');
    if (w) w.innerHTML = on ? buildIdWarning() : '';
    var a = document.getElementById('ts-id-avail');
    if (a) a.innerHTML = buildIdAvailable();
    var c = document.getElementById('ts-id-chosen');
    if (c) c.innerHTML = buildIdChosen();
    var cols = document.getElementById('ts-id-cols');
    if (cols) cols.classList.toggle('off', !on);
    var d = document.getElementById('ts-id-defaults');
    var cat = state.idCatalog || {};
    if (d) d.disabled = !(cat.defaults && cat.defaults.length);
  }

  function renderWizardStep4() {
    var isEdit = !!state.editingId;
    var modal = document.getElementById('ts-wizard-modal');
    if (!modal) return;
    modal.innerHTML =
      '<div class="ts-modal-hdr">' +
        '<div class="ts-modal-title">' + (isEdit ? 'Edit Task' : 'New Task') + ' — ' + esc(state.taskName) + '</div>' +
        '<button class="ts-modal-close" onclick="tsCloseWizard()">&times;</button>' +
      '</div>' +
      buildSteps(4) +
      '<div class="ts-wizard-body ts-body-col">' +
        '<label class="ts-id-switch"><input type="checkbox" id="ts-id-enabled"' + (state.identify.enabled ? ' checked' : '') +
          ' onchange="tsIdEnable(this.checked)" /> Run an Identify after the scan and the post-scan scripts</label>' +
        '<div class="ts-script-hint">Stash tries the chosen sources in this order for every scene of the selected paths and ' +
          'keeps the first match. Scenes only: images are not identified. The settings are Stash’s own Identify ' +
          'defaults (Settings → Tasks → Identify in Stash), read when the Identify starts. ' +
          'It is skipped if the scan or a post-scan script fails.</div>' +
        '<div id="ts-id-warn"></div>' +
        '<div class="ts-id-cols" id="ts-id-cols">' +
          '<div class="ts-id-col">' +
            '<div class="ts-section-title">Available sources ' +
              '<button class="ts-btn-ghost ts-id-defbtn" id="ts-id-defaults" onclick="tsIdUseDefaults()" ' +
                'title="Choose the sources saved in Stash’s Identify settings, in their order">Use Stash’s default sources</button></div>' +
            '<input class="ts-filter-input" id="ts-id-filter" placeholder="Filter sources..." value="' + esc(state.idFilter) + '" />' +
            '<div class="ts-id-list" id="ts-id-avail"></div>' +
          '</div>' +
          '<div class="ts-id-col">' +
            '<div class="ts-section-title">Order tried</div>' +
            '<div id="ts-id-chosen"></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="ts-modal-footer">' +
        '<div class="ts-footer-left">' +
          '<button class="ts-btn-ghost" onclick="tsWizardBack4()">&#8592; Back</button>' +
        '</div>' +
        '<button class="ts-btn-ghost" onclick="tsCloseWizard()">Cancel</button>' +
        '<button class="ts-btn ts-btn-primary" onclick="tsSaveTask()">' +
          (isEdit ? 'Save Changes' : 'Create Task') +
        '</button>' +
      '</div>';
    renderIdentifyBody();
  }

  // ── Delete confirm modal ──────────────────────────────────────────────────────

  function openDeleteConfirm(id, name, kind) {
    kind = kind || 'delete';
    state.deleteTargetId = id;
    state.deleteTargetName = name;
    state.confirmKind = kind;
    var ov = document.getElementById('ts-del-overlay');
    var modal = document.getElementById('ts-del-modal');
    var title, body, btn, btnCls = 'ts-btn-danger';
    if (kind === 'stop') {
      title = 'Stop Task'; btn = 'Stop';
      body = 'Are you sure you want to stop task <span class="ts-del-name">' + esc(name) + '</span>?<br>' +
        '<span style="font-size:12px;opacity:.7">A running scan is cancelled in Stash; a waiting task is simply removed from the queue.</span>';
    } else if (kind === 'runall') {
      title = 'Run All Manual Tasks'; btn = 'Run all'; btnCls = 'ts-btn ts-btn-primary';
      body = 'Queue <span class="ts-del-name">' + esc(name) + '</span> manual task(s) in the order shown?<br>' +
        '<span style="font-size:12px;opacity:.7">They run one after another, in that order. Each one is only sent to Stash when its turn comes.</span>';
    } else {
      title = 'Delete Task'; btn = 'Delete';
      body = 'Are you sure you want to delete task <span class="ts-del-name">' + esc(name) + '</span>?<br>' +
        '<span style="font-size:12px;opacity:.7">This action cannot be undone.</span>';
    }
    modal.innerHTML =
      '<div class="ts-modal-hdr">' +
        '<div class="ts-modal-title">' + title + '</div>' +
        '<button class="ts-modal-close" onclick="tsCloseDelete()">&times;</button>' +
      '</div>' +
      '<div class="ts-del-body">' + body + '</div>' +
      '<div class="ts-modal-footer">' +
        '<button class="ts-btn-ghost" onclick="tsCloseDelete()">Cancel</button>' +
        '<button class="' + btnCls + '" onclick="tsConfirmDelete()">' + btn + '</button>' +
      '</div>';
    ov.classList.remove('hidden');
  }

  // ── Run history modal ─────────────────────────────────────────────────────────

  var HIST_RESULTS = { done: 'Done', error: 'Error', stopped: 'Stopped', missed: 'Missed' };
  var HIST_TRIGGERS = { manual: 'Manual', run_all: 'Run All', schedule: 'Scheduled' };

  function fmtDuration(a, b) {
    var s = parseServerDate(a), e = parseServerDate(b);
    if (!s || !e) return '—';
    var m = Math.max(0, Math.round((e - s) / 60000));
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + pad2(m % 60);
  }

  // File paths named in Stash's error lines, e.g. 'error processing "/a/b.mp4": running
  // ffprobe on "/a/b.mp4": ...' (first quoted absolute path of each line, once each)
  function errorPaths(errs) {
    var seen = {}, out = [];
    errs.forEach(function (e) {
      var m = /"(\/[^"]+)"/.exec(e.message || '') || /<(\/[^<>]+)>/.exec(e.message || '');
      if (m && !seen[m[1]]) { seen[m[1]] = 1; out.push(m[1]); }
    });
    return out;
  }

  // Text offered by the Copy buttons of the open history, by row key: { paths, logs }
  var histCopy = {};

  function errorLogText(errs) {
    return errs.map(function (e) {
      var d = parseServerDate(String(e.time || '').replace(/\.\d+/, ''));
      return (d ? fmtLocal(d) + ':' + pad2(d.getSeconds()) : (e.time || '')) + '  ' + e.message;
    }).join('\n');
  }

  // Copy buttons of a run's Stash errors: file paths named in them (each once), and the error lines
  function histCopyBar(errs, key) {
    var paths = errorPaths(errs);
    histCopy[key] = { paths: paths.join('\n'), logs: errorLogText(errs) };
    function btn(kind, label) {
      return '<button class="ts-btn-ghost ts-copy-btn" data-label="' + label + '" onclick="tsCopy(\'' + kind + '\',\'' + key + '\',this)">' + label + '</button>';
    }
    return '<div class="ts-hist-copy">' +
      (paths.length ? btn('paths', 'Copy paths (' + paths.length + ')') : '') +
      (errs.length ? btn('logs', 'Copy logs (' + errs.length + ')') : '') + '</div>';
  }

  window.tsCopy = function (kind, key, btn) {
    var text = (histCopy[key] || {})[kind] || '';
    function done(ok) {
      if (!btn) return;
      btn.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(function () { btn.textContent = btn.getAttribute('data-label'); }, 1500);
    }
    // The Clipboard API needs a secure context (https); a plain-http Stash uses the older copy command
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(legacyCopy(text)); });
    } else {
      done(legacyCopy(text));
    }
  };

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  // Error lines Stash logged while the run was active (they carry no job id: other
  // activity in Stash at the same time may show up too)
  function histStashErrors(r, key) {
    var errs = r.stash_errors || [], more = r.stash_errors_dropped || 0;
    if (!errs.length && !more) return '';
    var n = errs.length + more;
    return '<details class="ts-hist-errs" data-k="err-' + key + '"><summary>&#9888; ' + n + ' Stash error' + (n > 1 ? 's' : '') + '</summary>' +
      histCopyBar(errs, key) +
      errs.map(function (e) {
        var d = parseServerDate(String(e.time || '').replace(/\.\d+/, ''));
        return '<div class="ts-hist-err"><span class="ts-mono">' + esc(d ? fmtLocal(d) : (e.time || '')) + '</span> ' + esc(e.message) + '</div>';
      }).join('') +
      (more ? '<div class="ts-hist-err">… and ' + more + ' more (see the Stash log)</div>' : '') +
      '<div class="ts-hist-err-note">Everything Stash logged as an error while this run was active.' +
        (r.stash_errors_partial ? ' Read from Stash’s last 30 log lines only: some may be missing ' +
          '(set a log file in Stash, Settings → System → Logging, for a complete list).' : '') +
      '</div></details>';
  }

  // Steps of a run, recorded since 1.6.0 (older entries have none)
  function histTimeline(r, key) {
    var evs = r.events || [], more = r.events_dropped || 0;
    if (!evs.length) return '';
    return '<details class="ts-hist-tl" data-k="' + key + '"><summary>Timeline (' +
      (evs.length + more) + ' event' + (evs.length + more > 1 ? 's' : '') + ')</summary>' +
      evs.map(function (e) {
        var d = parseServerDate(e.time);
        return '<div class="ts-hist-ev ' + esc(e.kind || 'info') + '"><span class="ts-mono">' +
          esc(d ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) : (e.time || '')) +
          '</span>' + (e.kind === 'warn' || e.kind === 'error' ? '&#9888; ' : '') + esc(e.text) + '</div>';
      }).join('') +
      (more ? '<div class="ts-hist-ev">… and ' + more + ' more, not recorded</div>' : '') +
      '</details>';
  }

  function isActive(t) { return !!t && (t.status === 'running' || t.status === 'queued'); }

  var PHASE_NAMES = { pre: 'pre-scan scripts', post: 'post-scan scripts', identify: 'Identify' };

  // The run in progress, built from the task as the task list returns it (refreshed with it)
  function currentRunRow(t) {
    var running = t.status === 'running';
    var phase = PHASE_NAMES[t.phase] || (t.job_id ? 'scan' : '');
    var started = parseServerDate(t.started);
    var known = typeof t.progress === 'number';
    var now = (known && running ? Math.round(t.progress) + '%  ' : '') + (t.job_info || '');
    var errs = histStashErrors({ stash_errors: t.stash_errors, stash_errors_dropped: t.stash_errors_dropped,
      stash_errors_partial: t.log_partial }, 'cur');
    return '<tr class="ts-hist-cur" id="ts-hist-cur">' +
      '<td class="ts-mono" data-label="Started">' + esc(fmtDate(t.started)) + '</td>' +
      '<td class="ts-mono" data-label="Ended">—</td>' +
      '<td class="ts-mono" data-label="Duration">' + (started ? esc(fmtDuration(t.started, new Date().toISOString())) + ', running' : '—') + '</td>' +
      '<td data-label="Result"><span class="ts-badge ' + (running ? 'running' : 'queued') + '"><span class="ts-dot"></span>' +
        (running ? 'Running' : 'Queued') + (running && phase ? ' · ' + esc(phase) : '') + '</span></td>' +
      '<td data-label="Trigger">' + esc(HIST_TRIGGERS[t.trigger] || t.trigger || '—') + '</td>' +
      '<td class="ts-hist-detail" data-label="Details">' + (now ? '<div class="ts-hist-now">' + esc(now) + '</div>' : '') +
        histTimeline(t, 'tl-cur') + errs + '</td>' +
    '</tr>';
  }

  // Keep the current run row up to date while the history is open; reload the
  // history once the run has ended (it then becomes a recorded entry)
  function updateHistoryLive() {
    var h = state.hist, ov = document.getElementById('ts-hist-overlay');
    if (!h || !ov || ov.classList.contains('hidden')) return;
    var t = state.tasks.find(function (x) { return x.id === h.id; });
    if (h.active && !isActive(t)) { loadHistory(h.id); return; }
    var row = document.getElementById('ts-hist-cur');
    if (!isActive(t) || !row) { if (isActive(t)) loadHistory(h.id); return; }
    var open = {};
    row.querySelectorAll('details[data-k]').forEach(function (d) { open[d.getAttribute('data-k')] = d.open; });
    row.outerHTML = currentRunRow(t);
    row = document.getElementById('ts-hist-cur');
    if (row) row.querySelectorAll('details[data-k]').forEach(function (d) { d.open = !!open[d.getAttribute('data-k')]; });
  }

  function buildHistoryRows(entries, current) {
    if (!entries.length && !current) return '<div class="ts-empty">No run recorded in this period.</div>';
    return '<table class="ts-tbl ts-hist-tbl"><thead><tr>' +
      '<th>Started</th><th>Ended</th><th>Duration</th><th>Result</th><th>Trigger</th><th>Details</th>' +
      '</tr></thead><tbody>' + (current ? currentRunRow(current) : '') + entries.map(function (r, i) {
        var cls = r.result === 'stopped' ? 'paused' : r.result;
        var total = savedSizeTotal(r.paths || [], r.sizes);
        var paths = savedSizeChips(r.paths || [], r.sizes).join(' ') +
          (total ? '<div class="ts-size-note">' + esc(total) + '</div>' : '');
        return '<tr>' +
          '<td class="ts-mono" data-label="Started">' + esc(fmtDate(r.started)) + '</td>' +
          '<td class="ts-mono" data-label="Ended">' + esc(fmtDate(r.ended)) + '</td>' +
          '<td class="ts-mono" data-label="Duration">' + esc(fmtDuration(r.started, r.ended)) + '</td>' +
          '<td data-label="Result"><span class="ts-badge ' + esc(cls) + '"><span class="ts-dot"></span>' + esc(HIST_RESULTS[r.result] || r.result) + '</span></td>' +
          '<td data-label="Trigger">' + esc(HIST_TRIGGERS[r.trigger] || r.trigger || '—') + '</td>' +
          '<td class="ts-hist-detail" data-label="Details">' + (r.detail ? '<div>' + esc(r.detail) + '</div>' : '') +
            histTimeline(r, 'tl-' + i) + histStashErrors(r, String(i)) + paths + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
  }

  window.tsHistory = function (id) {
    var t = state.tasks.find(function (x) { return x.id === id; });
    var ov = document.getElementById('ts-hist-overlay');
    var modal = document.getElementById('ts-hist-modal');
    if (!ov || !modal) return;
    var head = '<div class="ts-modal-hdr">' +
        '<div class="ts-modal-title">Run history — ' + esc(t ? t.name : '') + '</div>' +
        '<button class="ts-modal-close" onclick="tsCloseHistory()">&times;</button>' +
      '</div>';
    var foot = '<div class="ts-modal-footer"><button class="ts-btn-ghost" onclick="tsCloseHistory()">Close</button></div>';
    modal.innerHTML = head + '<div class="ts-modal-body"><div class="ts-empty"><span class="ts-spinner"></span> Loading…</div></div>' + foot;
    ov.classList.remove('hidden');
    state.hist = { id: id, head: head, foot: foot, active: false, gen: 0 };
    loadHistory(id);
  };

  // (Re)load the recorded runs; the page stays as it is until the answer comes
  function loadHistory(id) {
    var h = state.hist, ov = document.getElementById('ts-hist-overlay'), modal = document.getElementById('ts-hist-modal');
    if (!h || h.id !== id || !ov || !modal) return;
    var gen = ++h.gen;
    callApi({ action: 'history', id: id }).then(function (res) {
      if (ov.classList.contains('hidden') || state.hist !== h || gen !== h.gen) return;
      var t = state.tasks.find(function (x) { return x.id === id; });
      var current = isActive(t) ? t : null;
      var ended = h.active && !current;      // the current run just became the newest entry
      h.active = !!current;
      var body, scroll = modal.querySelector('.ts-modal-body');
      var top = scroll ? scroll.scrollTop : 0;
      var open = {};
      modal.querySelectorAll('details[data-k]').forEach(function (d) {
        var k = d.getAttribute('data-k'), m = /^(tl|err)-(\d+|cur)$/.exec(k);
        if (ended && m) k = m[1] + '-' + (m[2] === 'cur' ? 0 : +m[2] + 1);     // rows moved down by one
        if (d.open) open[k] = true;
      });
      histCopy = {};
      if (!Array.isArray(res.entries)) {
        body = '<div class="ts-load-error">Could not load the history: ' + esc(res._tsError || res.error || 'unexpected response') + '</div>';
      } else {
        body = '<div class="ts-hist-note">Last ' + esc(res.days) + ' day' + (res.days === 1 ? '' : 's') +
          ' (setting “History retention” in Settings → Plugins), newest first.</div>' + buildHistoryRows(res.entries, current);
      }
      modal.innerHTML = h.head + '<div class="ts-modal-body">' + body + '</div>' + h.foot;
      modal.querySelectorAll('details[data-k]').forEach(function (d) { if (open[d.getAttribute('data-k')]) d.open = true; });
      scroll = modal.querySelector('.ts-modal-body');
      if (scroll) scroll.scrollTop = top;
    });
  }

  window.tsCloseHistory = function () {
    var ov = document.getElementById('ts-hist-overlay');
    if (ov) ov.classList.add('hidden');
    state.hist = null;
  };

  window.tsRunAll = function () {
    var n = state.tasks.filter(function (t) {
      return isManual(t) && t.status !== 'running' && t.status !== 'queued' && (t.paths || []).length;
    }).length;
    if (!n) return;
    openDeleteConfirm(null, String(n), 'runall');
  };

  // ── Global actions ────────────────────────────────────────────────────────────

  window.tsToggleGlobal = function () {
    callApi({ action: 'toggle_global' }).then(function (res) {
      if (typeof res.global_enabled !== 'boolean') {
        // Failed call: the switch keeps its last known state
        state.loadError = res._tsError || res.error || 'Could not change the scheduler state';
        renderLoadError();
        return;
      }
      state.globalEnabled = res.global_enabled;
      renderGlobalToggle();
    });
  };

  window.tsToggleTask = function (id) {
    var t = state.tasks.find(function (x) { return x.id === id; });
    if (!t) return;
    callApi({ action: 'update', id: id, enabled: !t.enabled }).then(refresh);
  };

  window.tsRun = function (id) {
    callApi({ action: 'run', id: id }).then(refresh);
  };

  window.tsStop = function (id) {
    var t = state.tasks.find(function (x) { return x.id === id; });
    openDeleteConfirm(id, t ? t.name : '', 'stop');
  };

  window.tsEdit = function (id) { openWizard(id); };

  window.tsAskDelete = function (id, name) { openDeleteConfirm(id, name); };

  window.tsCloseDelete = function () {
    var ov = document.getElementById('ts-del-overlay');
    if (ov) ov.classList.add('hidden');
  };

  window.tsConfirmDelete = function () {
    var kind = state.confirmKind;
    var id = state.deleteTargetId;
    if (kind === 'runall') {
      window.tsCloseDelete();
      callApi({ action: 'run_all' }).then(refresh);
      return;
    }
    if (!id) return;
    window.tsCloseDelete();
    callApi({ action: kind === 'stop' ? 'stop' : 'delete', id: id }).then(refresh);
  };

  window.tsOpenNew = function () { openWizard(null); };

  window.tsCloseWizard = function () {
    var ov = document.getElementById('ts-wizard-overlay');
    if (ov) ov.classList.add('hidden');
  };

  window.tsBrowseTo = function (path) {
    loadBrowserDir(path);
  };

  window.tsCrumb = function (i) {
    if (state.crumbs[i] != null) loadBrowserDir(state.crumbs[i]);
  };

  window.tsRowOpen = function (i) {
    if (state.rowPaths[i] != null) loadBrowserDir(state.rowPaths[i]);
  };

  // Selecting an item measures its size (once: the result stays cached)
  window.tsRowSelect = function (i) {
    var path = state.rowPaths[i];
    if (path == null) return;
    var idx = state.selectedPaths.indexOf(path);
    if (idx >= 0) state.selectedPaths.splice(idx, 1);
    else { state.selectedPaths.push(path); requestSize(path); requestStashSize(path); }
    renderBrowserBody();
  };

  // ── Preview ───────────────────────────────────────────────────────────────────

  function previewKind(path) {
    var m = /\.([^.\/]+)$/.exec(path || '');
    return m ? PREVIEW_EXT[m[1].toLowerCase()] || null : null;
  }

  // Plays the files of the folder as listed (filters and sort applied), starting with row i
  window.tsPreview = function (i) {
    var player = window.stashPluginsShared && window.stashPluginsShared.mediaPlayer;
    if (!player) {
      alert('The preview needs the kkdepp_lib plugin: install and enable it, then reload the page.');
      return;
    }
    var start = 0, items = [], byPath = {};
    state.browserEntries.forEach(function (e) { byPath[e.path] = e; });
    state.rowPaths.forEach(function (p, j) {
      var kind = previewKind(p);
      var e = byPath[p];
      if (!kind || !e || e.dir) return;
      if (j === i) start = items.length;
      items.push({ name: e.name || basename(p), path: p, kind: kind });
    });
    player.open({
      items: items,
      index: start,
      load: function (item) {
        return callApi({ action: 'media_link', path: item.path }).then(function (res) {
          if (!res.name) return { error: res.error || res._tsError || 'unexpected response' };
          return { url: MEDIA_URL + encodeURIComponent(res.name), handle: res.name };
        });
      },
      release: function (name) { callApi({ action: 'media_unlink', name: name }); },
      keepAlive: function (name) { callApi({ action: 'media_ping', name: name }); }
    });
  };

  // Selected path chip: open its parent folder and point at the item
  window.tsGotoSel = function (i) {
    var p = state.selectedPaths[i];
    if (p == null) return;
    var parent = p.replace(/\/+$/, '').replace(/\/[^\/]*$/, '') || '/';
    loadBrowserDir(parent, p);
  };

  window.tsDeselectIdx = function (i) {
    if (i >= 0 && i < state.selectedPaths.length) state.selectedPaths.splice(i, 1);
    renderBrowserBody();
  };

  window.tsSetSort = function (sortKey) {
    if (state.sort === sortKey) {
      state.sortDir = -state.sortDir;            // same column: flip the order
    } else {
      state.sort = sortKey;
      state.sortDir = sortKey === 'name' ? 1 : -1;   // names A-Z, newest / biggest first
    }
    renderBrowserBody();
  };

  // Filter row: a dropdown change redraws the row (inputs appear / disappear), typing does not
  window.tsBf = function (field, value, redraw) {
    if (!(field in state.bf)) return;
    state.bf[field] = value;
    if (redraw) renderBrowserFilters();
    else {
      var clr = document.querySelector('#ts-browser-filters .ts-bf-clear');
      if (clr) clr.disabled = !browserFiltersActive();
    }
    renderBrowserBody();
  };

  window.tsBfClear = function () {
    state.bf = defaultBrowserFilters();
    renderBrowserFilters();
    renderBrowserBody();
  };

  window.tsQuickPath = function (sel) {
    var p = sel.value;
    sel.selectedIndex = 0;
    if (p) window.tsBrowseTo(p);
  };

  window.tsWizardNext = function () {
    var nameEl = document.getElementById('ts-task-name');
    if (nameEl) state.taskName = nameEl.value.trim();
    if (!state.taskName) { alert('Please enter a task name.'); return; }
    if (!state.selectedPaths.length) { alert('Please select at least one path to scan.'); return; }
    state.wizardStep = 2;
    renderWizardStep2();
  };

  window.tsWizardBack = function () {
    readSchedInputs();
    state.wizardStep = 1;
    renderWizardStep1();
    loadBrowserDir(state.browserPath);
  };

  window.tsOpenDefaults = function () {
    state.scripts = fromServerScripts(state.scriptDefaults);
    state.wizardStep = 0;
    var ov = document.getElementById('ts-wizard-overlay');
    var modal = document.getElementById('ts-wizard-modal');
    if (!ov || !modal) return;
    modal.classList.add('ts-compact');
    ov.classList.remove('hidden');
    modal.innerHTML =
      '<div class="ts-modal-hdr">' +
        '<div class="ts-modal-title">Pre/Post Scripts \u2014 defaults for new tasks</div>' +
        '<button class="ts-modal-close" onclick="tsCloseWizard()">&times;</button>' +
      '</div>' +
      '<div class="ts-wizard-body ts-body-col">' + scriptHelp(null) + buildScriptsSection() + '</div>' +
      '<div class="ts-modal-footer">' +
        '<button class="ts-btn-ghost" onclick="tsCloseWizard()">Cancel</button>' +
        '<button class="ts-btn ts-btn-primary" onclick="tsSaveDefaults()">Save defaults</button>' +
      '</div>';
  };

  window.tsSaveDefaults = function () {
    var sc = toServerScripts(state.scripts);
    callApi({ action: 'set_script_defaults', scripts: sc }).then(function (res) {
      if (res && res.scripts) state.scriptDefaults = res.scripts;
      window.tsCloseWizard();
      refresh();
    });
  };

  window.tsWizardNext2 = function () {
    readSchedInputs();
    if (state.schedType === 'once' && !state.schedAt) { alert('Please choose a date and time for this one-time task.'); return; }
    state.wizardStep = 3;
    renderWizardStep3();
  };

  window.tsWizardBack3 = function () {
    state.wizardStep = 2;
    renderWizardStep2();
  };

  window.tsWizardNext3 = function () {
    state.wizardStep = 4;
    renderWizardStep4();
  };

  window.tsWizardBack4 = function () {
    state.wizardStep = 3;
    renderWizardStep3();
  };

  window.tsIdEnable = function (on) {
    state.identify.enabled = !!on;
    renderIdentifyBody();
  };

  window.tsIdToggle = function (i) {
    var s = state.idRows[i];
    if (!s) return;
    var k = idKey(s), list = state.identify.sources;
    var at = -1;
    list.forEach(function (x, j) { if (idKey(x) === k) at = j; });
    if (at >= 0) list.splice(at, 1);
    else list.push({ type: s.type, endpoint: s.endpoint, id: s.id, name: s.name });
    if (list.length) state.identify.enabled = true;     // choosing a source means wanting the Identify
    var sw = document.getElementById('ts-id-enabled');
    if (sw) sw.checked = state.identify.enabled;
    renderIdentifyBody();
  };

  window.tsIdMove = function (i, dir) {
    var list = state.identify.sources, j = i + dir;
    if (j < 0 || j >= list.length) return;
    var x = list[i]; list[i] = list[j]; list[j] = x;
    renderIdentifyBody();
  };

  window.tsIdRemove = function (i) {
    state.identify.sources.splice(i, 1);
    renderIdentifyBody();
  };

  window.tsIdUseDefaults = function () {
    var cat = state.idCatalog || {};
    if (!cat.defaults || !cat.defaults.length) return;
    state.identify.sources = cat.defaults.map(function (s) {
      return { type: s.type, endpoint: s.endpoint, id: s.id, name: s.name };
    });
    state.identify.enabled = true;
    var sw = document.getElementById('ts-id-enabled');
    if (sw) sw.checked = true;
    renderIdentifyBody();
  };

  window.tsAddScript = function (phase) {
    state.scripts[phase].push({ cmd: '', cont: false });
    var el = document.getElementById('ts-scripts-' + phase);
    if (el) {
      el.innerHTML = buildScriptRows(phase);
      var inputs = el.querySelectorAll('.ts-script-cmd');
      if (inputs.length) inputs[inputs.length - 1].focus();
    }
  };

  window.tsRemoveScript = function (phase, idx) {
    state.scripts[phase].splice(idx, 1);
    var el = document.getElementById('ts-scripts-' + phase);
    if (el) el.innerHTML = buildScriptRows(phase);
  };

  window.tsScriptCont = function (phase, idx, on) {
    if (state.scripts[phase][idx]) state.scripts[phase][idx].cont = !!on;
  };

  window.tsToggleOpt = function (key) {
    state.scanOpts[key] = !state.scanOpts[key];
    var el = document.getElementById('ts-scan-opts');
    if (el) el.innerHTML = buildScanOpts();
  };

  window.tsSetSchedType = function (typ) {
    readSchedInputs();
    state.schedType = typ;
    var el = document.getElementById('ts-sched-section');
    if (el) el.innerHTML = buildSchedSection();
  };

  window.tsToggleDay = function (d) {
    var idx = state.schedDays.indexOf(d);
    if (idx >= 0) state.schedDays.splice(idx, 1); else state.schedDays.push(d);
    var el = document.getElementById('ts-sched-section');
    if (el) el.innerHTML = buildSchedSection();
  };

  window.tsSaveTask = function () {
    if (state.identify.enabled && !state.identify.sources.length) {
      alert('Choose at least one source for the Identify, or turn it off.');
      return;
    }
    readSchedInputs();
    var sizes = {};
    state.selectedPaths.forEach(function (p) {
      var s = state.sizes[p];
      if (s && typeof s.bytes === 'number') sizes[p] = { bytes: s.bytes, complete: !!s.complete };
    });
    var args = {
      sizes: sizes,
      action: state.editingId ? 'update' : 'create',
      id: state.editingId || undefined,
      name: state.taskName,
      paths: state.selectedPaths,
      options: state.scanOpts,
      schedule_type: state.schedType,
      schedule_time: state.schedTime,
      schedule_at:   state.schedType === 'once' ? localInputToIso(state.schedAt) : '',
      schedule_days: state.schedDays,
      scripts: {
        pre:  state.scripts.pre.map(function (x) { return { cmd: x.cmd, 'continue': !!x.cont }; }),
        post: state.scripts.post.map(function (x) { return { cmd: x.cmd, 'continue': !!x.cont }; })
      },
      identify: { enabled: state.identify.enabled, sources: state.identify.sources },
    };
    callApi(args)
      .then(function () {
        window.tsCloseWizard();
        refresh();
      })
      .catch(function () {
        window.tsCloseWizard();
        refresh();
      });
  };

  // Input filter delegate
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'ts-filter-input') {
      state.filter = e.target.value;
      var br = document.getElementById('ts-browser-rows');
      if (br) br.innerHTML = buildBrowserRows();   // also refreshes rowPaths (row indexes)
    }
    if (e.target && e.target.getAttribute && e.target.getAttribute('data-ts-script')) {
      var sp = e.target.getAttribute('data-ts-script');
      var si = parseInt(e.target.getAttribute('data-idx'), 10);
      if (state.scripts && state.scripts[sp] && state.scripts[sp][si]) state.scripts[sp][si].cmd = e.target.value;
    }
    if (e.target && e.target.id === 'ts-task-name') {
      state.taskName = e.target.value;
    }
    if (e.target && e.target.id === 'ts-id-filter') {
      state.idFilter = e.target.value;
      var al = document.getElementById('ts-id-avail');
      if (al) al.innerHTML = buildIdAvailable();     // also refreshes idRows (row indexes)
    }
  });

  // ── Panel HTML ────────────────────────────────────────────────────────────────

  function buildPanel() {
    var div = document.createElement('div');
    div.className = 'ts-wrap';
    div.innerHTML =
      '<div class="ts-hdr">' +
        '<div class="ts-title">&#9203; Task Scheduler</div>' +
        '<div class="ts-hdr-right">' +
          '<span class="ts-daemon" id="ts-daemon"></span>' +
          '<span class="ts-global-lbl on" id="ts-global-label">Enabled</span>' +
          '<button class="ts-tog on" id="ts-global-toggle" onclick="tsToggleGlobal()">' +
            '<span class="ts-tog-thumb"></span>' +
          '</button>' +
          '<button class="ts-btn ts-btn-ghost ts-runall" id="ts-runall" onclick="tsRunAll()" title="Run all manual tasks one after another, in the order shown"></button>' +
          '<button class="ts-btn ts-btn-ghost" onclick="tsOpenDefaults()" title="Scripts run before / after the scan of every new task">&#9881; Pre/Post Scripts</button>' +
          '<button class="ts-btn ts-btn-primary" onclick="tsOpenNew()">+ New Task</button>' +
        '</div>' +
      '</div>' +
      '<div class="ts-load-error" id="ts-load-error" hidden></div>' +
      '<div class="ts-filters" id="ts-filters"></div>' +
      '<div class="ts-tbl-wrap">' +
        '<table class="ts-tbl">' +
          '<thead id="ts-thead"></thead>' +
          '<tbody id="ts-tbody">' +
            '<tr><td colspan="9" class="ts-empty">Loading tasks...</td></tr>' +
          '</tbody>' +
        '</table>' +
      '</div>';
    return div;
  }

  // ── Overlays ──────────────────────────────────────────────────────────────────

  function ensureOverlays() {
    if (!document.getElementById('ts-wizard-overlay')) {
      var ov = document.createElement('div');
      ov.className = 'ts-ov hidden';
      ov.id = 'ts-wizard-overlay';
      // No click-outside-to-close for the wizard: use Cancel or finish the setup
      var modal = document.createElement('div');
      modal.className = 'ts-modal ts-wizard';
      modal.id = 'ts-wizard-modal';
      ov.appendChild(modal);
      document.body.appendChild(ov);
    }
    if (!document.getElementById('ts-del-overlay')) {
      var dov = document.createElement('div');
      dov.className = 'ts-ov hidden';
      dov.id = 'ts-del-overlay';
      dov.onclick = function (e) { if (e.target === dov) window.tsCloseDelete(); };
      var dmodal = document.createElement('div');
      dmodal.className = 'ts-modal ts-del-modal';
      dmodal.id = 'ts-del-modal';
      dov.appendChild(dmodal);
      document.body.appendChild(dov);
    }
    if (!document.getElementById('ts-hist-overlay')) {
      var hov = document.createElement('div');
      hov.className = 'ts-ov hidden';
      hov.id = 'ts-hist-overlay';
      hov.onclick = function (e) { if (e.target === hov) window.tsCloseHistory(); };
      var hmodal = document.createElement('div');
      hmodal.className = 'ts-modal ts-hist-modal';
      hmodal.id = 'ts-hist-modal';
      hov.appendChild(hmodal);
      document.body.appendChild(hov);
    }
  }

  // ── Inject ────────────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('ts-css')) return;
    var s = document.createElement('style');
    s.id = 'ts-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  var PAGE_ROUTE = '/task-scheduler';   // outside /plugin/*: Stash serves its own handler there, which returns 404 on a hard reload
  var routeRegistered = false;

  function isToolsPage() {
    return window.location.search.indexOf('tab=tools') !== -1;
  }

  // ── Full page (React route hosting the vanilla UI) ───────────────────────────

  function mountPage() {
    var host = document.getElementById('ts-page-host');
    if (!host || document.getElementById('ts-panel')) return;
    var panel = buildPanel();
    panel.id = 'ts-panel';
    host.appendChild(panel);
    loadLibraryPaths().then(function () {
      refresh();
      startPolling();
    });
  }

  function unmountPage() {
    stopPolling();
    var p = document.getElementById('ts-panel');
    if (p) p.remove();
  }

  function registerRoute() {
    var api = window.PluginApi;
    if (!api || !api.React || !api.register || typeof api.register.route !== 'function') return false;
    var R = api.React;
    function TaskSchedulerPage() {
      R.useEffect(function () {
        mountPage();
        return unmountPage;
      }, []);
      return R.createElement('div', { id: 'ts-page-host', className: 'ts-page' });
    }
    api.register.route(PAGE_ROUTE, TaskSchedulerPage);
    return true;
  }

  window.tsOpenPage = function () {
    if (!routeRegistered) {
      // Older Stash without PluginApi.register.route: show the panel inline under the button
      if (!document.getElementById('ts-page-host')) {
        var host = document.createElement('div');
        host.id = 'ts-page-host';
        host.className = 'ts-page';
        var w = document.getElementById('ts-btn-wrapper');
        if (w) w.parentNode.insertBefore(host, w.nextSibling);
        mountPage();
      }
      return;
    }
    // Client-side navigation: react-router listens to popstate
    window.history.pushState({}, '', PAGE_ROUTE);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  };

  // ── Button on Settings > Tools, below "Scene Tools" ──────────────────────────

  function tryInjectButton() {
    if (document.getElementById('ts-btn-wrapper')) return;
    var sections = Array.prototype.filter.call(
      document.querySelectorAll('.setting-section'),
      function (el) { return el.offsetParent !== null; }
    );
    if (!sections.length) return;
    var anchor = null;
    sections.forEach(function (el) {
      var h = el.querySelector('h1,h2,h3');
      if (h && /scene tools/i.test(h.textContent)) anchor = el;
    });
    if (!anchor) anchor = sections[sections.length - 1];

    var wrapper = document.createElement('div');
    wrapper.className = 'setting-section';
    wrapper.id = 'ts-btn-wrapper';
    wrapper.innerHTML =
      '<h1>Task Scheduler</h1>' +
      '<div class="card"><div class="setting"><div>' +
        '<button type="button" class="btn btn-primary" onclick="tsOpenPage()">&#9203; Open Task Scheduler</button>' +
      '</div></div></div>';
    anchor.parentNode.insertBefore(wrapper, anchor.nextSibling);
  }

  // Link next to the "Task Queue" heading on Settings > Tasks
  function isTasksPage() {
    return window.location.search.indexOf('tab=tasks') !== -1;
  }

  function tryInjectQueueLink() {
    if (document.getElementById('ts-queue-link')) return;
    var heads = document.querySelectorAll('.setting-section h1, h1');
    var i, h = null;
    for (i = 0; i < heads.length; i++) {
      if (heads[i].offsetParent !== null && /^\s*task queue\s*$/i.test(heads[i].textContent)) { h = heads[i]; break; }
    }
    if (!h) return;
    var a = document.createElement('a');
    a.id = 'ts-queue-link';
    a.href = PAGE_ROUTE;
    a.className = 'btn btn-secondary btn-sm';
    a.style.cssText = 'margin-left:16px;font-size:14px;font-weight:400;vertical-align:middle';
    a.innerHTML = '&#9203; Task Scheduler';
    a.onclick = function (e) { e.preventDefault(); window.tsOpenPage(); };
    h.appendChild(a);
  }

  function removeButton() {
    var w = document.getElementById('ts-btn-wrapper');
    if (w) w.remove();
  }

  // Any Stash page: ask the backend to check the scheduler (it re-arms cron when no pass ran
  // recently), so a container restart is repaired by the first visit to Stash, not only by a
  // visit to this plugin's page. At most once a minute; the plugin's own page does it on refresh.
  var SCHEDULER_CHECK_MS = 60000;
  var _lastSchedulerCheck = 0;

  function checkScheduler() {
    if (window.location.pathname === PAGE_ROUTE) return;
    var now = Date.now();
    if (now - _lastSchedulerCheck < SCHEDULER_CHECK_MS) return;
    _lastSchedulerCheck = now;
    callApi({ action: 'status' });     // result unused here; callApi never rejects
  }

  function onLocation() {
    checkScheduler();
    if (isToolsPage()) {
      if (!document.getElementById('ts-btn-wrapper')) {
        var attempts = 0;
        var t = setInterval(function () {
          attempts++;
          tryInjectButton();
          if (document.getElementById('ts-btn-wrapper') || attempts > 15) clearInterval(t);
        }, 300);
      }
    } else {
      removeButton();
    }
    if (isTasksPage() && !document.getElementById('ts-queue-link')) {
      var tries = 0;
      var t2 = setInterval(function () {
        tries++;
        tryInjectQueueLink();
        if (document.getElementById('ts-queue-link') || tries > 15 || !isTasksPage()) clearInterval(t2);
      }, 300);
    }
  }

  function init() {
    injectStyles();
    ensureOverlays();
    routeRegistered = registerRoute();
    if (window.PluginApi && window.PluginApi.Event) {
      window.PluginApi.Event.addEventListener('stash:location', onLocation);
    }
    var lastHref = window.location.href;
    setInterval(function () {
      if (window.location.href !== lastHref) { lastHref = window.location.href; onLocation(); }
    }, 500);
    onLocation();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
