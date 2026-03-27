// ==UserScript==
// @name         GitHub Issue Private Manager (Notes + Kanban)
// @namespace    https://github.com/astarx233/github_issue_private_manager
// @version      0.3.4
// @description  Local-only private notes/tags for GitHub Issues with a 3-column Kanban workflow, drag-and-drop status, quick Done toggle, import/export, enriched per-column copy, and native GitHub labels in Kanban view.
// @match        https://github.com/*/*/issues*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var DEBUG = true;
  function log() { if (DEBUG) console.log.apply(console, ['[GHPN]'].concat([].slice.call(arguments))); }
  function warn() { if (DEBUG) console.warn.apply(console, ['[GHPN]'].concat([].slice.call(arguments))); }

  var STORAGE_KEY = 'ghpn_notes_v1';
  var UI_ID = 'ghpn-modal-root';
  var FAB_ID = 'ghpn-fab';
  var STYLE_ID = 'ghpn-style';
  var SCAN_DEBOUNCE_MS = 120;
  var scanTimer = null;
  var lastScanLogSig = '';

  function loadDB() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function saveDB(db) { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); }

  function safeText(s) {
    return String(s == null ? '' : s);
  }

  function nowISO() {
    return new Date().toISOString();
  }

  function getRepoFromPath() {
    var m = location.pathname.match(/^\/([^\/]+)\/([^\/]+)\/issues/);
    if (!m) return null;
    return { owner: m[1], repo: m[2] };
  }

  function findRows() {
    var lis = Array.prototype.slice.call(document.querySelectorAll('li[role="listitem"]'));
    return lis.filter(function (li) {
      return li.querySelector('a[data-testid="issue-pr-title-link"]');
    });
  }

  function parseIssueNumber(href) {
    var m = String(href || '').match(/\/issues\/(\d+)(?:$|\?)/);
    return m ? parseInt(m[1], 10) : null;
  }

  function buildKey(repo, num) {
    return repo.owner + '/' + repo.repo + '#' + num;
  }

  function upsertRecord(db, key, patch) {
    var rec = db[key] || {};
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) rec[k] = patch[k];
    }
    db[key] = rec;
    return rec;
  }

  function hasMark(rec) {
    return !!(rec && (rec.tag || rec.note || rec.done));
  }

  // -------------------------
  // Native GitHub labels extraction (robust + visual fallback)
  // -------------------------

  function toArray(nodeList) {
    return Array.prototype.slice.call(nodeList || []);
  }

  function uniqByRef(arr) {
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var el = arr[i];
      var exists = false;
      for (var j = 0; j < out.length; j++) {
        if (out[j] === el) { exists = true; break; }
      }
      if (!exists) out.push(el);
    }
    return out;
  }

  function normName(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function looksLikeLabelName(name) {
    if (!name) return false;
    var low = name.toLowerCase();
    if (low === 'labels') return false;
    if (name.length > 60) return false;
    return true;
  }

  function isTransparentColor(c) {
    return !c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)';
  }

  function getComputed(el) {
    try { return window.getComputedStyle(el); } catch (e) { return null; }
  }

  function readColorsFrom(el) {
    var cs = getComputed(el);
    var bg = cs ? cs.backgroundColor : '';
    var fg = cs ? cs.color : '';
    var bd = cs ? cs.borderColor : '';

    if (isTransparentColor(bg) && el && el.parentElement) {
      var cs2 = getComputed(el.parentElement);
      if (cs2 && !isTransparentColor(cs2.backgroundColor)) {
        bg = cs2.backgroundColor;
        fg = fg || cs2.color;
        bd = bd || cs2.borderColor;
      }
    }

    return { bg: bg, fg: fg, bd: bd };
  }

  function getRect(el) {
    try { return el.getBoundingClientRect(); } catch (e) { return null; }
  }

  function nearTitleArea(li, el, titleLink) {
    if (!titleLink) return true;
    if (titleLink.contains(el) || el.contains(titleLink)) return true;

    var cur = titleLink;
    var maxHops = 6;
    while (cur && maxHops-- > 0) {
      if (cur.contains && cur.contains(el)) return true;
      cur = cur.parentElement;
    }

    var rT = getRect(titleLink);
    var rE = getRect(el);
    if (rT && rE) {
      var dy = Math.abs((rE.top + rE.height / 2) - (rT.top + rT.height / 2));
      if (dy < 36) return true;
    }

    return false;
  }

  function looksLikePill(el) {
    var cs = getComputed(el);
    if (!cs) return false;

    var bg = cs.backgroundColor;
    if (isTransparentColor(bg)) return false;

    var h = parseFloat(cs.height) || 0;
    var fs = parseFloat(cs.fontSize) || 0;

    if (h <= 0 || h > 32) return false;
    if (fs < 10 || fs > 14) return false;

    var br = cs.borderRadius || '';
    var brNum = parseFloat(br) || 0;
    if (br.indexOf('999') === -1 && brNum < 6) return false;

    var r = getRect(el);
    if (r && (r.width > 360 || r.height > 40)) return false;

    return true;
  }

  function extractLabelsFromRow(li) {
    var titleLink = li.querySelector('a[data-testid="issue-pr-title-link"]');

    var cands = [];
    cands = cands.concat(toArray(li.querySelectorAll('a[data-hovercard-type="label"]')));
    cands = cands.concat(toArray(li.querySelectorAll('a[href*="/labels/"]')));
    cands = cands.concat(toArray(li.querySelectorAll('[data-name][data-color]')));
    cands = cands.concat(toArray(li.querySelectorAll('a[data-name][data-color]')));
    cands = uniqByRef(cands);

    var out = [];

    function pushLabelFromEl(el) {
      if (!el) return;
      var name = normName(el.getAttribute('data-name') || el.textContent);
      if (!looksLikeLabelName(name)) return;

      var pill = el;
      var inner = el.querySelector('span');
      if (inner && looksLikePill(inner)) pill = inner;

      if (!looksLikePill(pill)) {
        var spans = toArray(el.querySelectorAll('span'));
        for (var i = 0; i < spans.length; i++) {
          if (looksLikePill(spans[i])) { pill = spans[i]; break; }
        }
      }

      var colors = readColorsFrom(pill);
      out.push({ name: name, bg: colors.bg, fg: colors.fg, bd: colors.bd });
    }

    for (var i1 = 0; i1 < cands.length; i1++) {
      var el1 = cands[i1];
      if (!nearTitleArea(li, el1, titleLink)) continue;
      pushLabelFromEl(el1);
    }

    if (!out.length) {
      var pool = [];
      pool = pool.concat(toArray(li.querySelectorAll('a')));
      pool = pool.concat(toArray(li.querySelectorAll('span')));
      pool = pool.concat(toArray(li.querySelectorAll('div')));
      pool = uniqByRef(pool);

      var maxScan = 220;
      var scanned = 0;

      for (var k = 0; k < pool.length && scanned < maxScan; k++) {
        var el = pool[k];
        scanned++;

        if (!el || !el.textContent) continue;
        if (!nearTitleArea(li, el, titleLink)) continue;

        var name2 = normName(el.textContent);
        if (!looksLikeLabelName(name2)) continue;
        if (!looksLikePill(el)) continue;

        if (/^#\d+$/.test(name2)) continue;

        var low2 = name2.toLowerCase();
        if (low2 === 'open' || low2 === 'closed' || low2 === 'merged') continue;

        var colors2 = readColorsFrom(el);
        out.push({ name: name2, bg: colors2.bg, fg: colors2.fg, bd: colors2.bd });
      }
    }

    var byName = {};
    var finalOut = [];
    for (var x = 0; x < out.length; x++) {
      var it = out[x];
      var key = it.name.toLowerCase();
      if (!byName[key]) {
        byName[key] = 1;
        finalOut.push(it);
      }
    }

    if (DEBUG && finalOut.length === 0) {
      var t = titleLink ? normName(titleLink.textContent) : '(no title link)';
      warn('No native labels found for:', t);
    }

    return finalOut;
  }

  function makeNativeLabelsWrap(labels) {
    var wrap = document.createElement('div');
    wrap.className = 'ghpn-native-labels';
    wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;align-items:center;';
    if (!labels || !labels.length) return wrap;

    for (var i = 0; i < labels.length; i++) {
      var lb = labels[i];
      var pill = document.createElement('span');
      pill.textContent = lb.name;

      var bg = lb.bg || '#f6f8fa';
      var fg = lb.fg || '#24292f';
      var bd = lb.bd || 'rgba(208,215,222,1)';

      pill.style.cssText =
        'display:inline-flex;align-items:center;max-width:240px;' +
        'padding:0 8px;height:20px;line-height:20px;border-radius:999px;' +
        'border:1px solid ' + bd + ';' +
        'background:' + bg + ';' +
        'color:' + fg + ';' +
        'font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';

      wrap.appendChild(pill);
    }
    return wrap;
  }

  function getIssueMetaFromRow(li, repo) {
    var link = li.querySelector('a[data-testid="issue-pr-title-link"]');
    if (!link) return null;

    var href = link.getAttribute('href') || '';
    var num = parseIssueNumber(href);
    if (!num) return null;

    var key = buildKey(repo, num);
    var title = (link.textContent || '').trim();
    var url = new URL(href, location.origin).toString();

    var labels = extractLabelsFromRow(li);

    return { key: key, num: num, title: title, url: url, linkEl: link, labels: labels };
  }

  function isVisibleEl(el) {
    if (!el) return false;
    var cs = getComputed(el);
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    var r = getRect(el);
    if (!r) return false;
    return r.width > 0 && r.height > 0;
  }

  function findDetailTitleEl() {
    var sels = [
      '[data-testid="issue-header"] [data-testid="issue-title"]',
      'h1 [data-testid="issue-title"]',
      '[data-testid="issue-title"]',
      'h1.gh-header-title .js-issue-title',
      'h1 .js-issue-title',
      'bdi.js-issue-title'
    ];
    var seen = [];
    var fallback = null;
    for (var i = 0; i < sels.length; i++) {
      var list = toArray(document.querySelectorAll(sels[i]));
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        if (seen.indexOf(el) !== -1) continue;
        seen.push(el);
        if (!fallback) fallback = el;
        if (isVisibleEl(el)) return el;
      }
    }
    return fallback;
  }

  function getIssueMetaFromDetail(repo) {
    var m = location.pathname.match(/^\/([^\/]+)\/([^\/]+)\/issues\/(\d+)(?:$|\/|\?)/);
    if (!m) return null;

    if (repo && (repo.owner !== m[1] || repo.repo !== m[2])) return null;

    var num = parseInt(m[3], 10);
    if (!num) return null;

    var titleEl = findDetailTitleEl();
    var title = titleEl ? normName(titleEl.textContent || '') : '';
    if (!title) title = '(no title)';

    var issueUrl = location.origin + '/' + m[1] + '/' + m[2] + '/issues/' + m[3];
    var key = buildKey({ owner: m[1], repo: m[2] }, num);

    return { key: key, num: num, title: title, url: issueUrl, titleEl: titleEl, labels: [] };
  }

  function ensureDetailToolsHost(meta) {
    if (!meta || !meta.titleEl) return null;

    var titleEl = meta.titleEl;
    var host = titleEl.parentElement || titleEl;

    if (!host) return null;

    var olds = toArray(document.querySelectorAll('span.ghpn-detail-tools[data-ghpn-key="' + meta.key + '"]'));
    for (var oi = 0; oi < olds.length; oi++) {
      if (olds[oi].parentElement !== host) olds[oi].remove();
    }

    var tools = host.querySelector('span.ghpn-detail-tools');
    if (tools && tools.getAttribute('data-ghpn-key') !== meta.key) {
      tools.remove();
      tools = null;
    }

    if (!tools) {
      tools = document.createElement('span');
      tools.className = 'ghpn-detail-tools';
      tools.setAttribute('data-ghpn-key', meta.key);
      tools.style.cssText =
        'display:inline-flex;align-items:center;gap:6px;margin-left:8px;vertical-align:middle;';

      if (titleEl && titleEl.parentNode) {
        var next = titleEl.nextSibling;
        if (next) titleEl.parentNode.insertBefore(tools, next);
        else titleEl.parentNode.appendChild(tools);
      } else {
        host.appendChild(tools);
      }
    }

    return tools;
  }

  // ---------- Inline inject: badge + edit button + quick done ----------
  // CHANGE #1: DO NOT inject native labels into the original GitHub issue list UI anymore.
  function refreshInjectedRow(li, repo) {
    if (!li) return;

    var meta = getIssueMetaFromRow(li, repo);
    if (!meta) return;
    var key = meta.key;

    var badge =
      li.querySelector('span.ghpn-badge') ||
      li.querySelector('span[data-ghpn-role="badge"]');
    var doneBtn =
      li.querySelector('button[data-ghpn-role="done"]') ||
      li.querySelector('button[title="Toggle DONE (only if marked)"]');

    if (!badge || !doneBtn) return;

    var db = loadDB();
    var rec = db[key];

    if (hasMark(rec)) {
      var parts = [];
      if (rec.done) parts.push('DONE');
      if (rec.tag) parts.push('#' + rec.tag);
      if (rec.note) {
        var n = safeText(rec.note).replace(/\s+/g, ' ').slice(0, 60);
        if (n) parts.push(n);
      }
      badge.textContent = parts.join(' · ');
      badge.style.display = 'inline-flex';

      if (rec.done) {
        badge.style.borderColor = '#1f883d';
        badge.style.background = '#dafbe1';
      } else {
        badge.style.borderColor = '#d0d7de';
        badge.style.background = '#f6f8fa';
      }
    } else {
      badge.style.display = 'none';
      badge.style.borderColor = '#d0d7de';
      badge.style.background = '#f6f8fa';
    }

    if (hasMark(rec)) {
      doneBtn.style.display = 'inline-flex';
      if (rec.done) {
        doneBtn.style.borderColor = '#1f883d';
        doneBtn.style.background = '#dafbe1';
      } else {
        doneBtn.style.borderColor = '#d0d7de';
        doneBtn.style.background = '#fff';
      }
    } else {
      doneBtn.style.display = 'none';
      doneBtn.style.borderColor = '#d0d7de';
      doneBtn.style.background = '#fff';
    }
  }

  function ensureInjected(li, repo) {
    if (li.getAttribute('data-ghpn') === '1') {
      refreshInjectedRow(li, repo);
      return;
    }

    var meta = getIssueMetaFromRow(li, repo);
    if (!meta) return;

    var key = meta.key;
    var link = meta.linkEl;

    var anchor =
      li.querySelector('span[class*="trailingBadgesContainer"]') ||
      li.querySelector('div[data-listview-item-title-container="true"]') ||
      link.parentElement ||
      li;

    var badge = document.createElement('span');
    badge.style.cssText =
      'display:none;margin-left:8px;padding:0 8px;height:22px;line-height:22px;' +
      'border-radius:999px;border:1px solid #d0d7de;background:#f6f8fa;font-size:12px;max-width:320px;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    badge.className = 'ghpn-badge';
    badge.setAttribute('data-ghpn-role', 'badge');

    var btn = document.createElement('button');
    btn.textContent = '📝';
    btn.title = 'Private tag/note';
    btn.type = 'button';
    btn.style.cssText =
      'display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;margin-left:8px;' +
      'border:1px solid #d0d7de;border-radius:6px;background:#fff;cursor:pointer;user-select:none;font-size:14px;';

    var doneBtn = document.createElement('button');
    doneBtn.textContent = '✅';
    doneBtn.title = 'Toggle DONE (only if marked)';
    doneBtn.setAttribute('data-ghpn-role', 'done');
    doneBtn.type = 'button';
    doneBtn.style.cssText =
      'display:none;align-items:center;justify-content:center;width:26px;height:26px;margin-left:6px;' +
      'border:1px solid #d0d7de;border-radius:6px;background:#fff;cursor:pointer;user-select:none;font-size:14px;';

    function refresh() {
      var db = loadDB();
      var rec = db[key];

      if (hasMark(rec)) {
        var parts = [];
        if (rec.done) parts.push('DONE');
        if (rec.tag) parts.push('#' + rec.tag);
        if (rec.note) {
          var n = safeText(rec.note).replace(/\s+/g, ' ').slice(0, 60);
          if (n) parts.push(n);
        }
        badge.textContent = parts.join(' · ');
        badge.style.display = 'inline-flex';

        if (rec.done) {
          badge.style.borderColor = '#1f883d';
          badge.style.background = '#dafbe1';
        } else {
          badge.style.borderColor = '#d0d7de';
          badge.style.background = '#f6f8fa';
        }
      } else {
        badge.style.display = 'none';
        badge.style.borderColor = '#d0d7de';
        badge.style.background = '#f6f8fa';
      }

      if (hasMark(rec)) {
        doneBtn.style.display = 'inline-flex';
        if (rec.done) {
          doneBtn.style.borderColor = '#1f883d';
          doneBtn.style.background = '#dafbe1';
        } else {
          doneBtn.style.borderColor = '#d0d7de';
          doneBtn.style.background = '#fff';
        }
      } else {
        doneBtn.style.display = 'none';
        doneBtn.style.borderColor = '#d0d7de';
        doneBtn.style.background = '#fff';
      }
    }

    function openEditPrompts(existingRec) {
      var db = loadDB();
      var rec = existingRec || db[key] || {};

      var tag = prompt('Tag for ' + key + ' (empty ok)', rec.tag || '');
      if (tag === null) return;

      var note = prompt('Note for ' + key + ' (empty ok)', rec.note || '');
      if (note === null) return;

      tag = String(tag).trim();
      note = String(note).trim();

      if (!tag && !note && !rec.done) {
        delete db[key];
      } else {
        upsertRecord(db, key, {
          tag: tag,
          note: note,
          done: !!rec.done,
          title: (link.textContent || '').trim(),
          url: meta.url,
          updatedAt: nowISO()
        });
      }

      saveDB(db);
      refresh();
      tryRenderModalIfOpen();
      log('saved', key);
    }

    btn.addEventListener('click', function () {
      openEditPrompts(null);
    });

    doneBtn.addEventListener('click', function () {
      var db = loadDB();
      var rec = db[key];
      if (!hasMark(rec)) {
        alert('这个 issue 还没标注（tag/note）。先点 📝 标注一下，再用 ✅ 切换 DONE。');
        return;
      }
      rec.done = !rec.done;
      rec.updatedAt = nowISO();
      db[key] = rec;
      saveDB(db);
      refresh();
      tryRenderModalIfOpen();
    });

    try {
      anchor.appendChild(badge);
      anchor.appendChild(btn);
      anchor.appendChild(doneBtn);

      li.setAttribute('data-ghpn', '1');
      refresh();
      log('injected', key);
    } catch (e) {
      warn('append failed', e);
    }
  }

  function ensureInjectedDetail(repo) {
    var meta = getIssueMetaFromDetail(repo);
    if (!meta || !meta.titleEl) return;

    var key = meta.key;
    var tools = ensureDetailToolsHost(meta);
    if (!tools) return;

    var badge = tools.querySelector('.ghpn-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'ghpn-badge';
      badge.style.cssText =
        'display:none;padding:0 8px;height:22px;line-height:22px;' +
        'border-radius:999px;border:1px solid #d0d7de;background:#f6f8fa;font-size:12px;max-width:420px;' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      tools.appendChild(badge);
    }

    var btn = tools.querySelector('button[data-ghpn-role="edit"]');
    if (!btn) {
      btn = document.createElement('button');
      btn.setAttribute('data-ghpn-role', 'edit');
      btn.textContent = '📝';
      btn.title = 'Private tag/note';
      btn.type = 'button';
      btn.style.cssText =
        'display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;' +
        'border:1px solid #d0d7de;border-radius:6px;background:#fff;cursor:pointer;user-select:none;font-size:14px;';
      tools.appendChild(btn);
    }

    var doneBtn = tools.querySelector('button[data-ghpn-role="done"]');
    if (!doneBtn) {
      doneBtn = document.createElement('button');
      doneBtn.setAttribute('data-ghpn-role', 'done');
      doneBtn.textContent = '✅';
      doneBtn.title = 'Toggle DONE (only if marked)';
      doneBtn.type = 'button';
      doneBtn.style.cssText =
        'display:none;align-items:center;justify-content:center;width:26px;height:26px;' +
        'border:1px solid #d0d7de;border-radius:6px;background:#fff;cursor:pointer;user-select:none;font-size:14px;';
      tools.appendChild(doneBtn);
    }

    function refresh() {
      var db = loadDB();
      var rec = db[key];

      if (hasMark(rec)) {
        var parts = [];
        if (rec.done) parts.push('DONE');
        if (rec.tag) parts.push('#' + rec.tag);
        if (rec.note) {
          var n = safeText(rec.note).replace(/\s+/g, ' ').slice(0, 60);
          if (n) parts.push(n);
        }
        badge.textContent = parts.join(' · ');
        badge.style.display = 'inline-flex';

        if (rec.done) {
          badge.style.borderColor = '#1f883d';
          badge.style.background = '#dafbe1';
        } else {
          badge.style.borderColor = '#d0d7de';
          badge.style.background = '#f6f8fa';
        }
      } else {
        badge.style.display = 'none';
        badge.style.borderColor = '#d0d7de';
        badge.style.background = '#f6f8fa';
      }

      if (hasMark(rec)) {
        doneBtn.style.display = 'inline-flex';
        if (rec.done) {
          doneBtn.style.borderColor = '#1f883d';
          doneBtn.style.background = '#dafbe1';
        } else {
          doneBtn.style.borderColor = '#d0d7de';
          doneBtn.style.background = '#fff';
        }
      } else {
        doneBtn.style.display = 'none';
        doneBtn.style.borderColor = '#d0d7de';
        doneBtn.style.background = '#fff';
      }
    }

    function openEditPrompts(existingRec) {
      var latestMeta = getIssueMetaFromDetail(repo) || meta;
      var db = loadDB();
      var rec = existingRec || db[key] || {};

      var tag = prompt('Tag for ' + key + ' (empty ok)', rec.tag || '');
      if (tag === null) return;

      var note = prompt('Note for ' + key + ' (empty ok)', rec.note || '');
      if (note === null) return;

      tag = String(tag).trim();
      note = String(note).trim();

      if (!tag && !note && !rec.done) {
        delete db[key];
      } else {
        upsertRecord(db, key, {
          tag: tag,
          note: note,
          done: !!rec.done,
          title: latestMeta.title || meta.title || '',
          url: latestMeta.url || meta.url,
          updatedAt: nowISO()
        });
      }

      saveDB(db);
      refresh();
      tryRenderModalIfOpen();
      log('saved(detail)', key);
    }

    if (btn.getAttribute('data-ghpn-bound') !== '1') {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openEditPrompts(null);
      });
      btn.setAttribute('data-ghpn-bound', '1');
    }

    if (doneBtn.getAttribute('data-ghpn-bound') !== '1') {
      doneBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();

        var db = loadDB();
        var rec = db[key];
        if (!hasMark(rec)) {
          alert('这个 issue 还没标注（tag/note）。先点 📝 标注一下，再用 ✅ 切换 DONE。');
          return;
        }
        rec.done = !rec.done;
        rec.updatedAt = nowISO();
        db[key] = rec;
        saveDB(db);
        refresh();
        tryRenderModalIfOpen();
      });
      doneBtn.setAttribute('data-ghpn-bound', '1');
    }

    refresh();
  }

  // ---------- Kanban modal ----------
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.type = 'text/css';
    style.textContent =
      '' +
      '#'+UI_ID+'{position:fixed;inset:0;z-index:999999;display:none;}' +
      '#'+UI_ID+'.open{display:block;}' +
      '#'+UI_ID+' .ghpn-backdrop{position:absolute;inset:0;background:rgba(0,0,0,0.45);}' +
      '#'+UI_ID+' .ghpn-panel{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);' +
        'width:min(1180px,94vw);height:min(80vh,860px);background:#fff;border:1px solid #d0d7de;' +
        'border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,0.25);display:flex;flex-direction:column;overflow:hidden;}' +
      '#'+UI_ID+' .ghpn-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #d0d7de;background:#f6f8fa;}' +
      '#'+UI_ID+' .ghpn-title{font-weight:700;font-size:14px;}' +
      '#'+UI_ID+' .ghpn-spacer{flex:1;}' +
      '#'+UI_ID+' .ghpn-btn{border:1px solid #d0d7de;background:#fff;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:12px;}' +
      '#'+UI_ID+' .ghpn-btn:hover{background:#f6f8fa;}' +
      '#'+UI_ID+' .ghpn-input{border:1px solid #d0d7de;border-radius:8px;padding:6px 10px;font-size:12px;min-width:260px;}' +
      '#'+UI_ID+' .ghpn-body{flex:1;display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;padding:10px;background:#fff;overflow:hidden;}' +
      '#'+UI_ID+' .ghpn-col{border:1px solid #d0d7de;border-radius:10px;display:flex;flex-direction:column;overflow:hidden;}' +
      '#'+UI_ID+' .ghpn-colhead{padding:10px 10px;border-bottom:1px solid #d0d7de;background:#f6f8fa;font-size:12px;font-weight:700;display:flex;align-items:center;gap:8px;}' +
      '#'+UI_ID+' .ghpn-colactions{margin-left:auto;display:flex;align-items:center;gap:4px;}' +
      '#'+UI_ID+' .ghpn-colaction{border:none;background:none;cursor:pointer;opacity:0.6;font-size:14px;padding:2px 6px;border-radius:4px;}' +
      '#'+UI_ID+' .ghpn-colaction:hover{opacity:1;background:rgba(0,0,0,0.05);}' +
      '#'+UI_ID+' .ghpn-count{font-weight:600;color:#57606a;}' +
      '#'+UI_ID+' .ghpn-list{padding:8px;overflow:auto;}' +
      '#'+UI_ID+' .ghpn-card{border:1px solid #d0d7de;border-radius:10px;padding:8px;margin-bottom:8px;background:#fff;}' +
      '#'+UI_ID+' .ghpn-card.done{border-color:#1f883d;background:#dafbe1;}' +
      '#'+UI_ID+' .ghpn-card.dragging{opacity:0.6;}' +
      '#'+UI_ID+' .ghpn-col.dropover{outline:2px dashed #0969da; outline-offset:-6px;}' +
      '#'+UI_ID+' .ghpn-row1{display:flex;align-items:flex-start;gap:6px;flex-direction:column;}' +
      '#'+UI_ID+' .ghpn-issue{font-size:12px;font-weight:700;width:100%}' +
      '#'+UI_ID+' .ghpn-link{font-size:12px;color:#0969da;text-decoration:none;flex:1;overflow:hidden;}' +
      '#'+UI_ID+' .ghpn-link:hover{text-decoration:underline;}' +
      '#'+UI_ID+' .ghpn-meta{margin-top:6px;font-size:12px;color:#57606a;}' +
      '#'+UI_ID+' .ghpn-actions{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;}' +
      '#'+UI_ID+' .ghpn-checkbox{display:inline-flex;align-items:center;gap:6px;font-size:12px;}' +
      '#'+FAB_ID+'{position:fixed;right:18px;bottom:18px;z-index:999998;' +
        'width:44px;height:44px;border-radius:999px;border:1px solid #d0d7de;' +
        'background:#fff;box-shadow:0 8px 20px rgba(0,0,0,0.18);cursor:pointer;font-size:18px;}' +
      '#'+FAB_ID+':hover{background:#f6f8fa;}';

    document.head.appendChild(style);
  }

  function ensureModal() {
    ensureStyle();

    var root = document.getElementById(UI_ID);
    if (root) return root;

    root = document.createElement('div');
    root.id = UI_ID;

    var backdrop = document.createElement('div');
    backdrop.className = 'ghpn-backdrop';

    var panel = document.createElement('div');
    panel.className = 'ghpn-panel';

    var head = document.createElement('div');
    head.className = 'ghpn-head';

    var title = document.createElement('div');
    title.className = 'ghpn-title';
    title.textContent = 'GitHub Issue Private Manager 看板（可拖拽）';

    var scopeBtn = document.createElement('button');
    scopeBtn.className = 'ghpn-btn';
    scopeBtn.type = 'button';
    scopeBtn.setAttribute('data-scope', 'page');
    scopeBtn.textContent = '范围：当前页';

    var search = document.createElement('input');
    search.className = 'ghpn-input';
    search.type = 'text';
    search.placeholder = '搜索：标题 / tag / note / #号';

    var exportBtn = document.createElement('button');
    exportBtn.className = 'ghpn-btn';
    exportBtn.type = 'button';
    exportBtn.textContent = '导出 JSON';

    var importBtn = document.createElement('button');
    importBtn.className = 'ghpn-btn';
    importBtn.type = 'button';
    importBtn.textContent = '导入 JSON';

    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'ghpn-btn';
    refreshBtn.type = 'button';
    refreshBtn.textContent = '刷新';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'ghpn-btn';
    closeBtn.type = 'button';
    closeBtn.textContent = '关闭';

    var spacer = document.createElement('div');
    spacer.className = 'ghpn-spacer';

    head.appendChild(title);
    head.appendChild(scopeBtn);
    head.appendChild(search);
    head.appendChild(spacer);
    head.appendChild(exportBtn);
    head.appendChild(importBtn);
    head.appendChild(refreshBtn);
    head.appendChild(closeBtn);

    var body = document.createElement('div');
    body.className = 'ghpn-body';
    body.setAttribute('data-ghpn-body', '1');

    panel.appendChild(head);
    panel.appendChild(body);

    root.appendChild(backdrop);
    root.appendChild(panel);

    backdrop.addEventListener('click', function () { closeModal(); });
    closeBtn.addEventListener('click', function () { closeModal(); });
    refreshBtn.addEventListener('click', function () { renderModal(); });

    scopeBtn.addEventListener('click', function () {
      var cur = scopeBtn.getAttribute('data-scope') || 'page';
      var next = cur === 'page' ? 'repo' : 'page';
      scopeBtn.setAttribute('data-scope', next);
      scopeBtn.textContent = next === 'page' ? '范围：当前页' : '范围：全仓(仅已标注)';
      renderModal();
    });

    search.addEventListener('input', function () { renderModal(); });

    exportBtn.addEventListener('click', function () { exportData(); });
    importBtn.addEventListener('click', function () { importData(); });

    document.body.appendChild(root);
    return root;
  }

  function ensureFAB() {
    ensureStyle();
    var btn = document.getElementById(FAB_ID);
    if (btn) return btn;

    btn = document.createElement('button');
    btn.id = FAB_ID;
    btn.type = 'button';
    btn.title = '打开 GitHub Issue Private Manager 看板';
    btn.textContent = '📋';
    btn.addEventListener('click', function () { openModal(); });

    document.body.appendChild(btn);
    return btn;
  }

  function openModal() {
    var root = ensureModal();
    root.classList.add('open');
    renderModal();
  }

  function closeModal() {
    var root = document.getElementById(UI_ID);
    if (!root) return;
    root.classList.remove('open');
    scan();
  }

  function isModalOpen() {
    var root = document.getElementById(UI_ID);
    return !!(root && root.classList.contains('open'));
  }

  function tryRenderModalIfOpen() {
    if (isModalOpen()) renderModal();
  }

  function collectPageIssues(repo) {
    var rows = findRows();
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var meta = getIssueMetaFromRow(rows[i], repo);
      if (meta) out.push(meta);
    }
    return out;
  }

  function collectRepoTagged(repo, db) {
    var prefix = repo.owner + '/' + repo.repo + '#';
    var keys = Object.keys(db);
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.indexOf(prefix) !== 0) continue;
      var rec = db[k];
      if (!hasMark(rec)) continue;

      var numStr = k.slice(prefix.length);
      var num = parseInt(numStr, 10);

      out.push({
        key: k,
        num: isNaN(num) ? null : num,
        title: rec.title || '',
        url: rec.url || '',
        linkEl: null,
        labels: []
      });
    }
    out.sort(function (a, b) {
      var an = a.num || 0;
      var bn = b.num || 0;
      return bn - an;
    });
    return out;
  }

  function matchFilter(meta, rec, q) {
    if (!q) return true;
    q = String(q).toLowerCase().trim();
    if (!q) return true;

    var fields = [];
    fields.push(String(meta.num || ''));
    fields.push(String(meta.title || ''));
    if (rec) {
      fields.push(String(rec.tag || ''));
      fields.push(String(rec.note || ''));
      fields.push(rec.done ? 'done' : '');
    }
    var hay = fields.join(' ').toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  // ---------- Export / Import ----------
  function exportData() {
    var repo = getRepoFromPath();
    var db = loadDB();
    var payload = {
      version: 'ghpn-0.3.3',
      exportedAt: nowISO(),
      origin: {
        host: location.host,
        repo: repo ? (repo.owner + '/' + repo.repo) : ''
      },
      storageKey: STORAGE_KEY,
      data: db
    };

    var text = '';
    try { text = JSON.stringify(payload, null, 2); } catch (e) { text = JSON.stringify(payload); }

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          alert('已复制到剪贴板（JSON）。');
        }).catch(function () {
          prompt('复制下面 JSON（已全选）', text);
        });
      } else {
        prompt('复制下面 JSON（已全选）', text);
      }
    } catch (e2) {
      prompt('复制下面 JSON（已全选）', text);
    }
  }

  function importData() {
    var raw = prompt('粘贴你导出的 JSON（会合并到当前 DB；同 key 会覆盖）', '');
    if (raw === null) return;

    raw = String(raw || '').trim();
    if (!raw) return;

    var obj = null;
    try { obj = JSON.parse(raw); }
    catch (e) { alert('JSON 解析失败：' + e); return; }

    var incoming = null;
    if (obj && obj.data && typeof obj.data === 'object') incoming = obj.data;
    else if (obj && typeof obj === 'object') incoming = obj;

    if (!incoming || typeof incoming !== 'object') {
      alert('导入内容不是有效对象。');
      return;
    }

    var db = loadDB();
    var keys = Object.keys(incoming);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      db[k] = incoming[k];
    }
    saveDB(db);

    scan();
    tryRenderModalIfOpen();
    alert('导入完成：' + keys.length + ' 条（同 key 已覆盖）。');
  }

  // ---------- Drag & Drop logic ----------
  function applyDropChange(targetCol, meta) {
    var db = loadDB();
    var rec = db[meta.key] || null;

    if (targetCol === 'untagged') {
      delete db[meta.key];
      saveDB(db);
      scan();
      renderModal();
      return;
    }

    if (targetCol === 'tagged') {
      if (!rec) {
        var tag = prompt('拖拽到“已标注”：请输入 Tag（可空）', '');
        if (tag === null) return;
        var note = prompt('请输入 Note（可空）', '');
        if (note === null) return;

        tag = String(tag).trim();
        note = String(note).trim();

        if (!tag && !note) {
          alert('Tag/Note 都为空，未创建标注。');
          return;
        }

        rec = {
          tag: tag,
          note: note,
          done: false,
          title: meta.title || '',
          url: meta.url || '',
          updatedAt: nowISO()
        };
      } else {
        rec.done = false;
        rec.updatedAt = nowISO();
      }

      db[meta.key] = rec;
      saveDB(db);
      scan();
      renderModal();
      return;
    }

    if (targetCol === 'done') {
      if (!rec) {
        alert('拖到 DONE 前请先标注（tag/note）。你可以拖到“已标注”列，会自动让你填一下。');
        return;
      }
      rec.done = true;
      rec.updatedAt = nowISO();
      db[meta.key] = rec;
      saveDB(db);
      scan();
      renderModal();
      return;
    }
  }

  // ---------- Render modal ----------
  function renderModal() {
    var repo = getRepoFromPath();
    if (!repo) return;

    var root = ensureModal();
    var body = root.querySelector('div[data-ghpn-body="1"]');
    if (!body) return;

    var headBtns = root.querySelectorAll('.ghpn-head .ghpn-btn');
    var scopeBtn = headBtns && headBtns.length ? headBtns[0] : null;
    var scope = scopeBtn ? (scopeBtn.getAttribute('data-scope') || 'page') : 'page';

    var search = root.querySelector('input.ghpn-input');
    var q = search ? (search.value || '') : '';

    var db = loadDB();

    var items = [];
    if (scope === 'page') items = collectPageIssues(repo);
    else items = collectRepoTagged(repo, db);

    var untagged = [];
    var tagged = [];
    var done = [];

    for (var i = 0; i < items.length; i++) {
      var meta = items[i];
      var rec = db[meta.key];

      if (!matchFilter(meta, rec, q)) continue;

      if (!hasMark(rec)) untagged.push(meta);
      else if (rec && rec.done) done.push(meta);
      else tagged.push(meta);
    }

    function sortByUpdate(a, b) {
      var rA = db[a.key] || {};
      var rB = db[b.key] || {};
      var tA = rA.updatedAt || '';
      var tB = rB.updatedAt || '';
      if (tA > tB) return -1;
      if (tA < tB) return 1;
      return 0;
    }
    tagged.sort(sortByUpdate);
    done.sort(sortByUpdate);

    while (body.firstChild) body.removeChild(body.firstChild);

    function attachDropHandlers(colEl, colName) {
      colEl.addEventListener('dragover', function (e) {
        e.preventDefault();
        colEl.classList.add('dropover');
      });
      colEl.addEventListener('dragleave', function () {
        colEl.classList.remove('dropover');
      });
      colEl.addEventListener('drop', function (e) {
        e.preventDefault();
        colEl.classList.remove('dropover');

        var key = '';
        try { key = e.dataTransfer.getData('text/plain') || ''; } catch (err) { key = ''; }
        key = String(key || '').trim();
        if (!key) return;

        var rec = loadDB()[key] || null;
        var num = null;
        var m = key.match(/#(\d+)$/);
        if (m) num = parseInt(m[1], 10);

        var meta = {
          key: key,
          num: num,
          title: (rec && rec.title) ? rec.title : key,
          url: (rec && rec.url) ? rec.url : '',
          labels: []
        };

        applyDropChange(colName, meta);
      });
    }

    // helper: write to clipboard or fallback
    function writeClipboard(text, okMsg) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() {
          if (okMsg) alert(okMsg);
        }).catch(function() {
          prompt('复制以下内容：', text);
        });
      } else {
        prompt('复制以下内容：', text);
      }
    }

    function normalizeInlineText(s) {
      return safeText(s).replace(/\s+/g, ' ').trim();
    }

    function formatIssueMarkdownLine(item, includeLocalMark) {
      var n = item.num ? ('#' + item.num) : '???';
      var t = normalizeInlineText(item.title).replace(/[\[\]]/g, '');
      var u = item.url || '';
      var line = u ? ('- ' + n + ' [' + t + '](' + u + ')') : ('- ' + n + ' ' + t);

      if (!includeLocalMark) return line;

      var rec = db[item.key] || null;
      var extras = [];
      if (rec) {
        if (rec.tag) extras.push('#' + normalizeInlineText(rec.tag));
        if (rec.note) extras.push(normalizeInlineText(rec.note));
      }
      if (extras.length) line += ' · ' + extras.join(' · ');

      return line;
    }

    function makeCol(titleText, list, colName) {
      var col = document.createElement('div');
      col.className = 'ghpn-col';
      col.setAttribute('data-col', colName);

      attachDropHandlers(col, colName);

      var head = document.createElement('div');
      head.className = 'ghpn-colhead';

      var title = document.createElement('div');
      title.textContent = titleText;

      var count = document.createElement('div');
      count.className = 'ghpn-count';
      count.textContent = '(' + list.length + ')';

      // existing copy button: markdown list with title + link
      var copyBtn = document.createElement('button');
      copyBtn.className = 'ghpn-colaction';
      copyBtn.type = 'button';
      copyBtn.title = '复制该列为列表 (Markdown)';
      copyBtn.textContent = '📄';
      copyBtn.addEventListener('click', function() {
        if (!list || !list.length) {
          alert('列表为空，无法复制。');
          return;
        }
        var lines = [];
        for (var i = 0; i < list.length; i++) {
          lines.push(formatIssueMarkdownLine(list[i], false));
        }
        var text = lines.join('\n');
        writeClipboard(text, '已复制 ' + lines.length + ' 条到剪贴板。');
      });

      var copyMarkedBtn = document.createElement('button');
      copyMarkedBtn.className = 'ghpn-colaction';
      copyMarkedBtn.type = 'button';
      copyMarkedBtn.title = '复制该列为列表 (Markdown，附 tag/note)';
      copyMarkedBtn.textContent = '📋';
      copyMarkedBtn.addEventListener('click', function() {
        if (!list || !list.length) {
          alert('列表为空，无法复制。');
          return;
        }
        var lines = [];
        for (var i = 0; i < list.length; i++) {
          lines.push(formatIssueMarkdownLine(list[i], true));
        }
        var text = lines.join('\n');
        writeClipboard(text, '已复制 ' + lines.length + ' 条（含 tag/note）到剪贴板。');
      });

      // CHANGE #2: simple copy button: only "#123" per line
      var copyNoBtn = document.createElement('button');
      copyNoBtn.className = 'ghpn-colaction';
      copyNoBtn.type = 'button';
      copyNoBtn.title = '复制该列：仅 #号（每行一个）';
      copyNoBtn.textContent = '🔢';
      copyNoBtn.addEventListener('click', function() {
        if (!list || !list.length) {
          alert('列表为空，无法复制。');
          return;
        }
        var lines = [];
        for (var i = 0; i < list.length; i++) {
          var item = list[i];
          if (item.num) lines.push('#' + item.num);
        }
        var text = lines.join('\n');
        writeClipboard(text, '已复制 ' + lines.length + ' 个 #号到剪贴板。');
      });

      var actionWrap = document.createElement('div');
      actionWrap.className = 'ghpn-colactions';
      actionWrap.appendChild(copyNoBtn);
      actionWrap.appendChild(copyBtn);
      actionWrap.appendChild(copyMarkedBtn);

      head.appendChild(title);
      head.appendChild(count);
      head.appendChild(actionWrap);

      var ul = document.createElement('div');
      ul.className = 'ghpn-list';

      for (var i = 0; i < list.length; i++) {
        ul.appendChild(makeCard(list[i], colName));
      }

      col.appendChild(head);
      col.appendChild(ul);
      return col;
    }

    function makeCard(meta, kind) {
      var rec = db[meta.key] || null;

      var card = document.createElement('div');
      card.className = 'ghpn-card' + ((rec && rec.done) ? ' done' : '');
      card.setAttribute('data-key', meta.key);

      card.draggable = true;
      card.addEventListener('dragstart', function (e) {
        card.classList.add('dragging');
        try { e.dataTransfer.setData('text/plain', meta.key); } catch (err) {}
      });
      card.addEventListener('dragend', function () {
        card.classList.remove('dragging');
      });

      var row1 = document.createElement('div');
      row1.className = 'ghpn-row1';

      var issue = document.createElement('div');
      issue.className = 'ghpn-issue';
      issue.textContent = '#' + String(meta.num || '?');

      var link = document.createElement('a');
      link.className = 'ghpn-link';
      link.href = meta.url || '#';
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = meta.title || meta.key;

      row1.appendChild(issue);
      row1.appendChild(link);

      // Keep native labels in Kanban (page scope only)
      var labelsWrap = makeNativeLabelsWrap(meta.labels || []);
      row1.appendChild(labelsWrap);

      var metaLine = document.createElement('div');
      metaLine.className = 'ghpn-meta';

      var parts = [];
      if (rec) {
        if (rec.tag) parts.push('#' + rec.tag);
        if (rec.note) parts.push(safeText(rec.note).replace(/\s+/g, ' ').slice(0, 80));
        if (rec.updatedAt) parts.push('(updated ' + rec.updatedAt.slice(0, 19).replace('T', ' ') + ')');
      } else {
        parts.push('未标注（可拖到已标注列开始标注）');
      }
      metaLine.textContent = parts.join(' · ');

      var actions = document.createElement('div');
      actions.className = 'ghpn-actions';

      var doneWrap = document.createElement('label');
      doneWrap.className = 'ghpn-checkbox';

      var doneCb = document.createElement('input');
      doneCb.type = 'checkbox';
      doneCb.disabled = !rec;
      doneCb.checked = !!(rec && rec.done);

      var doneTxt = document.createElement('span');
      doneTxt.textContent = 'DONE';

      doneWrap.appendChild(doneCb);
      doneWrap.appendChild(doneTxt);

      doneCb.addEventListener('change', function () {
        var db2 = loadDB();
        var r2 = db2[meta.key] || null;
        if (!r2) return;
        r2.done = !!doneCb.checked;
        r2.updatedAt = nowISO();
        db2[meta.key] = r2;
        saveDB(db2);
        scan();
        renderModal();
      });

      var editBtn = document.createElement('button');
      editBtn.className = 'ghpn-btn';
      editBtn.type = 'button';
      editBtn.textContent = rec ? '编辑' : '标注';

      editBtn.addEventListener('click', function () {
        var db2 = loadDB();
        var r2 = db2[meta.key] || {};

        var tag = prompt('Tag for ' + meta.key + ' (empty ok)', r2.tag || '');
        if (tag === null) return;

        var note = prompt('Note for ' + meta.key + ' (empty ok)', r2.note || '');
        if (note === null) return;

        tag = String(tag).trim();
        note = String(note).trim();

        if (!tag && !note && !r2.done) {
          delete db2[meta.key];
        } else {
          upsertRecord(db2, meta.key, {
            tag: tag,
            note: note,
            done: !!r2.done,
            title: meta.title || r2.title || '',
            url: meta.url || r2.url || '',
            updatedAt: nowISO()
          });
        }

        saveDB(db2);
        scan();
        renderModal();
      });

      var clearBtn = document.createElement('button');
      clearBtn.className = 'ghpn-btn';
      clearBtn.type = 'button';
      clearBtn.textContent = '清除';
      clearBtn.disabled = !rec;

      clearBtn.addEventListener('click', function () {
        if (!rec) return;
        if (!confirm('Clear note/tag for ' + meta.key + '?')) return;
        var db2 = loadDB();
        delete db2[meta.key];
        saveDB(db2);
        scan();
        renderModal();
      });

      actions.appendChild(doneWrap);
      actions.appendChild(editBtn);
      actions.appendChild(clearBtn);

      card.appendChild(row1);
      card.appendChild(metaLine);
      card.appendChild(actions);

      return card;
    }

    if (scope === 'repo') {
      var colA = makeCol('未标注', [], 'untagged');
      var hint = document.createElement('div');
      hint.className = 'ghpn-card';
      hint.draggable = false;
      hint.textContent = '全仓范围无法识别“未标注”（GitHub 不提供全量 issue 列表给脚本）。切到“当前页”即可看到未标注。';
      colA.querySelector('.ghpn-list').appendChild(hint);

      body.appendChild(colA);
      body.appendChild(makeCol('已标注', tagged, 'tagged'));
      body.appendChild(makeCol('DONE', done, 'done'));
    } else {
      body.appendChild(makeCol('未标注', untagged, 'untagged'));
      body.appendChild(makeCol('已标注', tagged, 'tagged'));
      body.appendChild(makeCol('DONE', done, 'done'));
    }
  }

  // ---------- Scan loop ----------
  function scan() {
    var repo = getRepoFromPath();
    if (!repo) return;

    ensureInjectedDetail(repo);

    var rows = findRows();
    var sig = String(rows.length) + '|' + String(location.href);
    if (sig !== lastScanLogSig) {
      lastScanLogSig = sig;
      log('scan rows=', rows.length, 'url=', location.href);
    }

    for (var i = 0; i < rows.length; i++) {
      ensureInjected(rows[i], repo);
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      scan();
    }, SCAN_DEBOUNCE_MS);
  }

  function boot() {
    scan();
    ensureFAB();

    var mo = new MutationObserver(function () { scheduleScan(); });
    mo.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('turbo:load', function () { scheduleScan(); });
    window.addEventListener('pjax:end', function () { scheduleScan(); });
    window.addEventListener('popstate', function () { scheduleScan(); });

    log('booted');
  }

  boot();
})();
