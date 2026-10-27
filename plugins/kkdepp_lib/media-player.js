/**
 * Shared media player (ES5) — a preview modal for videos and images, shipped by the kkdepp_lib
 * library plugin. A plugin using it lists kkdepp_lib under ui.requires so this file loads first.
 *
 * The plugin gives the files and how to get a URL for each one; the player only shows them:
 *
 *   window.stashPluginsShared.mediaPlayer.open({
 *     items: [{ name: 'clip.mp4', path: '/library/clip.mp4', kind: 'video' | 'image' }, ...],
 *     index: 0,                                  // item shown first
 *     load: function (item) {},                  // -> Promise of { url, handle } or { error }
 *     release: function (handle) {},             // the item is not shown any more
 *     keepAlive: function (handle) {}            // called every minute while it is shown
 *   });
 *
 * Plays what the browser can decode, as is: no transcoding, no fallback. Previous / Next,
 * arrow keys (when the video does not have the focus), Page Up / Page Down, Esc to close.
 * Older plugins shipped their own copy of this file: the highest version stays installed.
 */
(function () {
  'use strict';

  var VERSION = 1;
  var NS = window.stashPluginsShared = window.stashPluginsShared || {};
  if (NS.mediaPlayer && NS.mediaPlayer.version >= VERSION) return;

  var KEEP_ALIVE_MS = 60000;
  var TEXT = {
    loading: 'Preparing the preview…',
    prev: 'Previous',
    next: 'Next',
    close: 'Close (Esc)',
    unsupported: 'Your browser cannot play this file: its format or codec is not supported. ' +
      'The preview only plays what the browser can decode, without conversion.',
    unreadable: 'The file could not be read.',
    imageError: 'The image could not be shown.',
    failed: 'Preview not available: '
  };

  var CSS = [
    '.smp-ov{position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,.88);display:flex;flex-direction:column}',
    '.smp-hdr{display:flex;align-items:center;gap:12px;padding:10px 16px;color:#e0e4f0;font:14px system-ui,sans-serif}',
    '.smp-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}',
    '.smp-count{color:#8b93b0;font-size:12px;white-space:nowrap}',
    '.smp-btn{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);color:#e0e4f0;border-radius:6px;',
    'padding:6px 12px;font-size:13px;cursor:pointer;white-space:nowrap}',
    '.smp-btn:hover:not(:disabled){background:rgba(255,255,255,.16)}',
    '.smp-btn:disabled{opacity:.35;cursor:default}',
    '.smp-x{font-size:22px;line-height:1;padding:2px 10px}',
    '.smp-stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:0 12px}',
    '.smp-stage video,.smp-stage img{max-width:100%;max-height:100%;object-fit:contain;background:#000;outline:none}',
    '.smp-msg{color:#e0e4f0;font:14px system-ui,sans-serif;max-width:560px;text-align:center;line-height:1.5}',
    '.smp-msg.err{color:#f0a830}',
    '.smp-path{color:#8b93b0;font:11px monospace;padding:8px 16px 12px;word-break:break-all;text-align:center}',
    '@media (max-width:700px){.smp-hdr{padding:8px 10px;gap:8px}.smp-stage{padding:0}.smp-btn{padding:6px 9px}}'
  ].join('');

  var cur = null;          // the open player

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function injectCss() {
    if (document.getElementById('smp-style')) return;
    var st = document.createElement('style');
    st.id = 'smp-style';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function releaseCurrent(p) {
    if (p.timer) { clearInterval(p.timer); p.timer = null; }
    var stage = p.el.querySelector('.smp-stage');
    var v = stage && stage.querySelector('video');
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }   // stop the download before the link goes
    if (p.handle != null) {
      try { p.opts.release(p.handle); } catch (e) { /* the plugin's own cleanup catches up */ }
      p.handle = null;
    }
  }

  function message(p, text, isError) {
    p.el.querySelector('.smp-stage').innerHTML = '<div class="smp-msg' + (isError ? ' err' : '') + '">' + esc(text) + '</div>';
  }

  function show(p, i) {
    var items = p.opts.items;
    if (i < 0 || i >= items.length) return;
    releaseCurrent(p);
    p.index = i;
    var item = items[i];
    var seq = ++p.seq;
    p.el.querySelector('.smp-name').textContent = item.name || '';
    p.el.querySelector('.smp-count').textContent = (i + 1) + ' / ' + items.length;
    p.el.querySelector('.smp-path').textContent = item.path || '';
    p.el.querySelector('.smp-prev').disabled = i === 0;
    p.el.querySelector('.smp-next').disabled = i === items.length - 1;
    message(p, TEXT.loading, false);
    Promise.resolve(p.opts.load(item)).then(function (res) {
      res = res || {};
      if (cur !== p || seq !== p.seq) {           // closed or moved on meanwhile
        if (res.handle != null) p.opts.release(res.handle);
        return;
      }
      if (!res.url) { message(p, TEXT.failed + (res.error || 'unknown error'), true); return; }
      p.handle = res.handle;
      if (p.opts.keepAlive && res.handle != null) {
        p.timer = setInterval(function () { p.opts.keepAlive(res.handle); }, KEEP_ALIVE_MS);
      }
      var stage = p.el.querySelector('.smp-stage');
      var media;
      if (item.kind === 'image') {
        media = document.createElement('img');
        media.alt = item.name || '';
        media.onerror = function () { if (seq === p.seq) message(p, TEXT.imageError, true); };
      } else {
        media = document.createElement('video');
        media.controls = true;
        media.autoplay = true;
        media.setAttribute('playsinline', '');
        media.onerror = function () {
          if (seq !== p.seq) return;
          var code = media.error && media.error.code;
          message(p, code === 2 ? TEXT.unreadable : TEXT.unsupported, true);   // 2 = network, 3/4 = decode / format
        };
      }
      media.src = res.url;
      stage.innerHTML = '';
      stage.appendChild(media);
      if (media.focus) media.focus();
    }, function (e) {
      if (cur === p && seq === p.seq) message(p, TEXT.failed + (e && e.message ? e.message : e), true);
    });
  }

  function onKey(e) {
    var p = cur;
    if (!p) return;
    var inVideo = e.target && e.target.tagName === 'VIDEO';
    var k = e.key;
    if (k === 'Escape') close();
    else if (k === 'PageDown' || (k === 'ArrowRight' && !inVideo)) show(p, p.index + 1);
    else if (k === 'PageUp' || (k === 'ArrowLeft' && !inVideo)) show(p, p.index - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();       // the dialogs behind the player do not see these keys
  }

  function close() {
    var p = cur;
    if (!p) return;
    releaseCurrent(p);
    cur = null;
    document.removeEventListener('keydown', onKey, true);
    if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
  }

  function open(opts) {
    if (!opts || !opts.items || !opts.items.length || typeof opts.load !== 'function') return;
    close();
    injectCss();
    opts.release = opts.release || function () {};
    var el = document.createElement('div');
    el.className = 'smp-ov';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML =
      '<div class="smp-hdr">' +
        '<button class="smp-btn smp-prev" title="' + TEXT.prev + ' (Page Up)">&#8249; ' + TEXT.prev + '</button>' +
        '<div class="smp-name"></div><div class="smp-count"></div>' +
        '<button class="smp-btn smp-next" title="' + TEXT.next + ' (Page Down)">' + TEXT.next + ' &#8250;</button>' +
        '<button class="smp-btn smp-x" title="' + TEXT.close + '" aria-label="' + TEXT.close + '">&times;</button>' +
      '</div>' +
      '<div class="smp-stage"></div>' +
      '<div class="smp-path"></div>';
    var p = { el: el, opts: opts, index: -1, seq: 0, handle: null, timer: null };
    el.querySelector('.smp-prev').onclick = function () { show(p, p.index - 1); };
    el.querySelector('.smp-next').onclick = function () { show(p, p.index + 1); };
    el.querySelector('.smp-x').onclick = close;
    el.onclick = function (e) { if (e.target === el || e.target.classList.contains('smp-stage')) close(); };
    document.body.appendChild(el);
    document.addEventListener('keydown', onKey, true);
    cur = p;
    show(p, Math.max(0, Math.min(opts.index || 0, opts.items.length - 1)));
  }

  NS.mediaPlayer = { version: VERSION, open: open, close: close };
})();
