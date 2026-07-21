/* eslint-disable */
// collector.js — the "One-click bookmark" collector for validating FoW data.
//
// A loader bookmarklet injects this <script> while the user is on forces.flamesofwar.com, so it runs IN
// their authenticated tab: every fetch is same-origin and carries their session + cf_clearance (passes
// Cloudflare, no bot fight). It scrapes the books the account unlocks — FULL depth — and sends the data
// ONE BOOK AT A TIME to WORKER_URL (a Cloudflare Worker that drops each book's JSON into a private bucket).
//
// Each book is self-contained: its own structure + its own units' stats (loadouts, weapons, etc.) inline.
// There is NO global catalog file and nothing is load-bearing — if the user quits after 2 of 5 books,
// those 2 books are already sent and independently importable. `catalog` below is only an in-memory
// L-code cache so a unit shared across books is fetched once per run (never re-fetched), never emitted.
//
// The parsing is a faithful browser port of scraper/forces_scraper/forces_scraper_pw_v3.py (Part I):
// selectors, URL grammar, no-access guards, multi-unit-card splitting and denied-stub-never-drop all
// mirror that file. DATA ONLY — no images/assets. Pacing is purely sequential `await`s.

// Version 1.0.1 - UPDATE ME AFTER EACH UPDATE OR CODE CHANGE!!


(function () {
  'use strict';

  if (window.__fowCollectorRunning) {
    var ex = document.getElementById('fow-collector-overlay');
    if (ex) ex.style.display = 'flex';
    return;
  }
  window.__fowCollectorRunning = true;

  // ── deposit endpoint ───────────────────────────────────────────────────────────────────────────
  // The Cloudflare Worker that receives each book's JSON. Set this one line to your Worker's URL.
  var WORKER_URL = 'https://fow-data-worker.hunter2379.workers.dev';

  var BASE = window.location.origin;    // https://forces.flamesofwar.com (we run on that page)
  var SOURCE = 'forces.flamesofwar.com';
  var SCHEMA_VERSION = 3;
  var COLLECTOR_VERSION = 'fow-collector-1';
  // Random id for THIS run, stamped on every book so multi-book / multi-user submissions stay distinct.
  var RUN_ID = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
             : 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  // An LG-style code: 2-4 uppercase letters + 3-4 digits (LG520, LH101). Same as the Python CODE_RE.
  var CODE_RE = /^[A-Za-z]{2,4}\d{3,4}$/;
  var SAVE_SUFFIX_RE = /_[0-9A-Za-z]{4}$/;

  // Accumulated across the run. `catalog` is the in-memory L-code cache: each unique unit is fetched once
  // per run and never re-fetched — but it is NEVER emitted as a global blob; every book's JSON carries its
  // own units inline, so no single file is load-bearing.
  var books = [];
  var catalog = {};        // L-code → unit stats — transient run cache only
  var errors = [];
  var failedPayloads = []; // per-book payloads that failed to send — offered as a download at the end
  var cancelled = false;   // set by the Stop button so the loop bails before the next book

  // Rate-limit handling for the concurrent fetches. All workers share your IP, so one 429/challenge
  // pauses the WHOLE pool via `pausedUntil`; every get() waits on it, backs off, and retries the SAME
  // url (never skips the unit). After MAX_BLOCK_RETRIES straight blocks we `hardBlocked` and stop loudly.
  var MAX_BLOCK_RETRIES = 5;
  var pausedUntil = 0;     // epoch ms — shared brake every fetch respects
  var blockedCount = 0;    // times a fetch came back blocked (shown live in the overlay)
  var hardBlocked = false; // retries exhausted → stop the run instead of stubbing everything 'error'

  // ── progress overlay ───────────────────────────────────────────────────────────────────────────
  var ui = buildOverlay();

  function buildOverlay() {
    var wrap = document.createElement('div');
    wrap.id = 'fow-collector-overlay';
    wrap.setAttribute('style', [
      'position:fixed', 'inset:0', 'z-index:2147483647', 'display:flex',
      'align-items:center', 'justify-content:center', 'background:rgba(20,22,18,0.55)',
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif'
    ].join(';'));

    var card = document.createElement('div');
    card.setAttribute('style', [
      'width:min(92vw,440px)', 'max-height:86vh', 'overflow:auto', 'background:#f7f6f0',
      'color:#25281f', 'border-radius:14px', 'box-shadow:0 20px 60px rgba(0,0,0,0.45)',
      'border:1px solid #d8d5c6', 'padding:0'
    ].join(';'));

    var head = document.createElement('div');
    head.setAttribute('style', 'background:#3f473c;color:#f2f0e6;padding:14px 16px;border-radius:14px 14px 0 0;');
    head.innerHTML =
      '<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.75">FoW List Builder</div>' +
      '<div style="font-weight:700;font-size:16px;margin-top:2px">Sending your book data…</div>';

    var body = document.createElement('div');
    body.setAttribute('style', 'padding:16px;');

    var status = document.createElement('div');
    status.setAttribute('style', 'font-size:14px;font-weight:600;margin-bottom:10px;');
    status.textContent = 'Starting…';

    var barOuter = document.createElement('div');
    barOuter.setAttribute('style', 'height:9px;border-radius:99px;background:#e2dfd1;overflow:hidden;margin-bottom:8px;');
    var bar = document.createElement('div');
    bar.setAttribute('style', 'height:100%;width:0%;background:#3f473c;transition:width .15s ease;');
    barOuter.appendChild(bar);

    var sub = document.createElement('div');
    sub.setAttribute('style', 'font-size:12px;color:#6b6f62;min-height:16px;');

    var foot = document.createElement('div');
    foot.setAttribute('style', 'margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;');

    body.appendChild(status);
    body.appendChild(barOuter);
    body.appendChild(sub);
    body.appendChild(foot);
    card.appendChild(head);
    card.appendChild(body);
    wrap.appendChild(card);
    document.body.appendChild(wrap);

    return { wrap: wrap, head: head, status: status, bar: bar, sub: sub, foot: foot };
  }

  function setStatus(text) { ui.status.textContent = text; ui.sub.textContent = ''; }
  function setProgress(done, total, label) {
    var pct = total > 0 ? Math.round((done / total) * 100) : 0;
    ui.bar.style.width = pct + '%';
    ui.sub.textContent = (label || '') + '  (' + done + '/' + total + ')';
  }
  function button(text, bg, onClick) {
    var b = document.createElement('button');
    b.textContent = text;
    b.setAttribute('style', 'flex:1;min-width:120px;border:0;border-radius:9px;padding:10px 12px;font-weight:700;font-size:13px;cursor:pointer;background:' + bg + ';color:#fff;');
    b.onclick = onClick;
    return b;
  }
  function offerDownload(data, label) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'fow-unsent-books-' + Date.now() + '.json';
    a.textContent = label || 'Download the data as a file';
    a.setAttribute('style', 'flex:1;min-width:120px;text-align:center;border-radius:9px;padding:10px 12px;font-weight:700;font-size:13px;background:#8a8f7d;color:#fff;text-decoration:none;');
    ui.foot.appendChild(a);
  }
  function finishHead(text, ok) {
    ui.head.style.background = ok ? '#3f6b3c' : '#8a3b34';
    ui.head.innerHTML = '<div style="font-weight:700;font-size:16px">' + text + '</div>';
  }
  function addClose() { ui.foot.appendChild(button('Close', '#3f473c', function () { ui.wrap.remove(); window.__fowCollectorRunning = false; })); }

  function fatal(msg) {
    ui.foot.innerHTML = ''; // drop the Stop button if it was showing
    finishHead('Stopped', false);
    setStatus(msg);
    addClose();
  }
  // Final summary once every book has been attempted. Unsent books (if any) are offered as a download so
  // the user never loses collected work; re-running the bookmark simply re-sends them.
  function finishSummary(sent, total, failed) {
    ui.foot.innerHTML = ''; // drop the Stop button now that the run is finished
    ui.bar.style.width = '100%';
    if (sent === total) {
      finishHead('Done — ' + sent + ' book' + (sent === 1 ? '' : 's') + ' sent. Thank you!', true);
      setStatus('All ' + total + ' books sent. You can close this tab.');
    } else {
      finishHead('Sent ' + sent + ' of ' + total + ' books', false);
      setStatus('Didn’t send: ' + failed.join(', ') + '. Re-run the bookmark to retry, or download them below.');
      if (failedPayloads.length) offerDownload(failedPayloads, 'Download the ' + failedPayloads.length + ' unsent book(s)');
    }
    addClose();
  }

  // ── low-level fetch + guards (ports get() / no_access / looks_like_page) ─────────────────────────
  function parseHTML(html) { return new DOMParser().parseFromString(html || '', 'text/html'); }
  function decode(u) { try { return decodeURIComponent(u); } catch (e) { return u || ''; } }

  function noAccess(html, url) {
    if ((html || '').toLowerCase().indexOf('do not have access') !== -1) return true;
    return decode(url || '').toLowerCase().indexOf('do not have access') !== -1;
  }
  function looksLikePage(html) { return (html || '').indexOf('cssSkin') !== -1; }

  function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  // A Cloudflare block/throttle — deliberately NOT the same as a real "no access" page (that's a normal
  // 200 with 'do not have access' text, handled by noAccess()). We only retry on THESE, never on denied.
  function looksBlocked(status, html) {
    if (status === 429 || status === 503) return true;
    var h = (html || '').toLowerCase();
    return h.indexOf('just a moment') !== -1 || h.indexOf('challenge-platform') !== -1 ||
           h.indexOf('cf-chl') !== -1 || h.indexOf('attention required') !== -1;
  }

  // Shared brake: hold here until the pool-wide pause clears (or a hard block ends the run).
  async function waitForGate() {
    var wait = pausedUntil - Date.now();
    while (wait > 0 && !hardBlocked) { await sleep(Math.min(wait, 1000)); wait = pausedUntil - Date.now(); }
  }

  async function get(path) {
    var url = /^https?:/i.test(path) ? path : BASE + path;
    for (var attempt = 0; ; attempt++) {
      await waitForGate();
      if (hardBlocked) return { html: '', url: url, status: 0 }; // run is stopping — don't fetch
      var resp = await fetch(url, { credentials: 'include', redirect: 'follow' });
      var html = await resp.text();
      if (!looksBlocked(resp.status, html)) {
        return { html: html, url: resp.url || url, status: resp.status };
      }
      blockedCount++;
      if (attempt >= MAX_BLOCK_RETRIES) {
        hardBlocked = true;
        return { html: html, url: resp.url || url, status: resp.status };
      }
      // Pause the whole pool: honor Retry-After if present, else exponential backoff + jitter.
      var ra = parseInt((resp.headers && resp.headers.get('Retry-After')) || '', 10);
      var backoff = !isNaN(ra) ? ra * 1000
        : Math.min(30000, 1000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 500);
      if (Date.now() + backoff > pausedUntil) pausedUntil = Date.now() + backoff;
      ui.sub.textContent = '⏸ Rate-limited — pausing ' + Math.ceil(backoff / 1000) +
        's, retrying (blocked ' + blockedCount + '×)';
      await waitForGate();
    }
  }

  // ── asset/code helpers (only for reading codes off CardImages srcs — no downloads) ───────────────
  function assetStem(src) {
    if (!src) return '';
    var name = src.split('?')[0].split('#')[0].split('/').pop() || '';
    name = decode(name);
    var stem = name.replace(/\.[^.]*$/, '');
    return stem.replace(SAVE_SUFFIX_RE, '');
  }
  function isCardImage(src) {
    if (!src) return false;
    if (src.toLowerCase().indexOf('cardimages') !== -1) return true;
    return CODE_RE.test(assetStem(src));
  }
  function codeFromCardImage(src) {
    var stem = assetStem(src);
    return CODE_RE.test(stem) ? stem.toUpperCase() : '';
  }

  // ── PASS 0: books (ports parse_books, incl. era grouping) ────────────────────────────────────────
  var ERA_MARKERS = [
    [/<!--\s*Early\s*War\s*-->/gi, 'Early War'],
    [/id="Early"/g, 'Early War'],
    [/<!--\s*Late\s*War\s*-->/gi, 'Late War'],
    [/id="Late"/g, 'Late War'],
    [/<!--\s*Mid\s*War\s*-->/gi, 'Mid War'],
    [/id="Mid"/g, 'Mid War'],
    [/<!--\s*Great\s*War\s*-->/gi, 'Great War'],
    [/id="GW"/g, 'Great War']
  ];
  function parseBooks(html) {
    var boundaries = [];
    ERA_MARKERS.forEach(function (pair) {
      var rx = pair[0], era = pair[1], m;
      rx.lastIndex = 0;
      while ((m = rx.exec(html))) {
        boundaries.push([m.index, era]);
        if (m.index === rx.lastIndex) rx.lastIndex++;
      }
    });
    boundaries.sort(function (a, b) { return a[0] - b[0]; });
    function eraFor(pos) {
      var cur = '';
      for (var i = 0; i < boundaries.length; i++) {
        if (boundaries[i][0] <= pos) cur = boundaries[i][1]; else break;
      }
      return cur;
    }
    var doc = parseHTML(html);
    var seen = {}, out = [];
    doc.querySelectorAll('a[href*="/Home/FormationSelected/"]').forEach(function (a) {
      var href = a.getAttribute('href') || '';
      var m = href.match(/\/FormationSelected\/(\d+)/);
      if (!m) return;
      var bid = parseInt(m[1], 10);
      if (seen[bid]) return;
      seen[bid] = 1;
      var pm = html.search(new RegExp('/FormationSelected/' + bid + '\\b'));
      var pos = pm >= 0 ? pm : 0;
      var name = a.getAttribute('title') || (a.textContent || '').trim();
      out.push({ book_id: bid, book_name: name, era: eraFor(pos), points_mode: null, sort_order: out.length });
    });
    return out;
  }

  // ── PASS 1: structure + layout (ports parse_layout_sections / _column_index_of / parse_boxes /
  //            parse_picker / parse_points_mode / discover_formations / build_book_structure) ────────
  function columnIndexOf(el) {
    var p = el.parentElement;
    while (p) {
      for (var i = 0; i < p.classList.length; i++) {
        var m = p.classList[i].match(/^ColumnBreak(\d+)$/);
        if (m) return parseInt(m[1], 10);
      }
      p = p.parentElement;
    }
    return null;
  }
  function parseLayoutSections(doc) {
    var sectionById = {}, order = [], current = '';
    doc.querySelectorAll('*').forEach(function (el) {
      if (el.classList.contains('cssFS')) {
        current = (el.textContent || '').trim();
        if (current && order.indexOf(current) === -1) order.push(current);
        return;
      }
      var isBox = false;
      for (var i = 0; i < el.classList.length; i++) {
        if (el.classList[i].indexOf('BoxOuterType') === 0) { isBox = true; break; }
      }
      var id = el.getAttribute('id') || '';
      if (isBox && /^\d+$/.test(id)) sectionById[parseInt(id, 10)] = current;
    });
    return { sectionById: sectionById, order: order };
  }
  function parseBoxes(doc) {
    var sections = parseLayoutSections(doc).sectionById;
    var boxes = [];
    doc.querySelectorAll("[class*='BoxOuter']").forEach(function (div) {
      var bid = div.getAttribute('id') || '';
      if (!/^\d+$/.test(bid)) return;
      var bidI = parseInt(bid, 10);
      var inner = div.querySelector("[class*='BoxRequired']");
      var icls = inner ? (inner.getAttribute('class') || '') : '';
      var rm = icls.match(/BoxRequired(\d+)/);
      var requiredLevel = rm ? parseInt(rm[1], 10) : null;
      var groupEl = div.querySelector('.cssGroup');
      var slotType = groupEl ? (groupEl.textContent || '').trim() : '';
      var outerType = '';
      for (var i = 0; i < div.classList.length; i++) {
        if (div.classList[i].indexOf('BoxOuterType') === 0) { outerType = div.classList[i]; break; }
      }
      var tip = div.querySelector('.tooltiptext2');
      var description = tip ? (tip.textContent || '').trim() : '';

      // formation-tile ref: presence only decides "this box is addable" (icon/id not emitted).
      var hasFormationRef = false;
      var fa = div.querySelector('a[href*="/SubFormationSelected/"]');
      if (fa) {
        var fm = (fa.getAttribute('href') || '').match(/\/SubFormationSelected\/[^/]+\/[^/]+\/\d+\/(\d+)\/(\d+)/);
        if (fm) hasFormationRef = true;
      }

      var units = [];
      div.querySelectorAll('a[href*="/UnitSelected/"]').forEach(function (a) {
        var nameEl = a.querySelector('.D3t');
        var codeEl = a.querySelector('.small2');
        units.push({
          code: codeEl ? (codeEl.textContent || '').trim() : '',
          name: nameEl ? (nameEl.textContent || '').trim() : '',
          url: a.getAttribute('href') || ''
        });
      });

      var alliedOptions = [], alliesNote = '';
      var isAllied = (outerType === 'BoxOuterType33' || outerType === 'BoxOuterType44') ||
        (slotType === 'Allied Formation' || slotType === 'Allied Unit');
      var sel = isAllied ? div.querySelector('select') : null;
      if (sel) {
        var alliesEl = div.querySelector('.Allies');
        alliesNote = alliesEl ? (alliesEl.textContent || '').trim() : '';
        sel.querySelectorAll('option').forEach(function (opt) {
          var val = (opt.getAttribute('value') || '').trim();
          if (val === '' || val === '0') return;
          var text = (opt.textContent || '').trim();
          // CODE is the LAST (...) group because names can contain parens.
          var m = text.match(/^([\s\S]*)\(([^)]+)\)\s*$/);
          alliedOptions.push({
            value: val,
            name: m ? m[1].trim() : text,
            code: m ? m[2].trim() : ''
          });
        });
      }

      if (!units.length && !alliedOptions.length && !hasFormationRef) return;

      boxes.push({
        box_id: bidI,
        box_type: outerType,
        slot_type: slotType,
        mandatory: requiredLevel === 2,
        column_index: columnIndexOf(div),
        section: sections[bidI] !== undefined ? sections[bidI] : '',
        description: description,
        units: units,
        allied_options: alliedOptions,
        allies_note: alliesNote
      });
    });
    return boxes;
  }
  function parsePicker(doc) {
    var real = [], groups = [], seen = {};
    doc.querySelectorAll('a[href*="/SubFormationSelected/"]').forEach(function (a) {
      var href = a.getAttribute('href') || '';
      var m = href.match(/\/SubFormationSelected\/[^/]+\/[^/]+\/\d+\/(\d+)\/(\d+)/);
      if (!m) return;
      var fid = parseInt(m[1], 10), slot = parseInt(m[2], 10);
      if (slot !== 1 || seen[fid]) return;
      seen[fid] = 1;
      var nameDiv = a.querySelector('.D3tF');
      if (!nameDiv) return;
      var codeEl = nameDiv.querySelector('.small');
      var code = codeEl ? (codeEl.textContent || '').trim() : '';
      var clone = nameDiv.cloneNode(true);
      var cs = clone.querySelector('.small');
      if (cs) cs.parentNode.removeChild(cs);
      var name = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      if (name === 'Start New') return;
      if (CODE_RE.test(code)) real.push({ formation_id: fid, name: name, code: code });
      else groups.push({ formation_id: fid, name: name });
    });
    return { real: real, groups: groups };
  }
  function parsePointsMode(html) {
    return (html || '').toLowerCase().indexOf('using dynamic points') !== -1 ? 'dynamic' : 'fixed';
  }
  async function enterBook(bookId) {
    var r = await get('/Home/FormationSelected/' + bookId);
    var m = (r.url || '').match(/\/ForceDiagram\/\w+\/([0-9a-f-]{36})\//);
    if (!m) throw new Error('no force GUID (book ' + bookId + ' not accessible)');
    return { guid: m[1], html: r.html };
  }
  async function discoverFormations(guid, bookId, pickerDoc) {
    var all = [];
    var pk = parsePicker(pickerDoc);
    pk.real.forEach(function (f) { all.push(f); });
    for (var gi = 0; gi < pk.groups.length; gi++) {
      var g = pk.groups[gi];
      // "{Book} Formations" tiles are cross-book navigation — recursing duplicates another book. Skip.
      if (/Formations$/.test(g.name)) continue;
      var r = await get('/ForceDiagram/SubFormationSelected/' + guid + '/' + bookId + '/1/' + g.formation_id + '/1');
      if (noAccess(r.html, r.url)) { all.push({ formation_id: g.formation_id, name: g.name, code: '' }); continue; }
      var gd = parseHTML(r.html);
      var sub = parsePicker(gd);
      sub.real.forEach(function (f) { all.push(f); });
      if (sub.groups.length) {
        for (var si = 0; si < sub.groups.length; si++) {
          var sg = sub.groups[si];
          if (/Formations$/.test(sg.name)) continue;
          var sr = await get('/ForceDiagram/SubFormationSelected/' + guid + '/' + bookId + '/1/' + sg.formation_id + '/1');
          if (noAccess(sr.html, sr.url)) { all.push({ formation_id: sg.formation_id, name: sg.name, code: '' }); continue; }
          var sd = parseHTML(sr.html);
          var ss = parsePicker(sd);
          ss.real.forEach(function (f) { all.push(f); });
          if (!ss.real.length && parseBoxes(sd).length) all.push({ formation_id: sg.formation_id, name: sg.name, code: '' });
        }
        if (parseBoxes(gd).length) all.push({ formation_id: g.formation_id, name: g.name, code: '' });
      } else if (!sub.real.length) {
        // empty picker + real box content = a genuine leaf (Command Cards, Formation Support pools).
        if (parseBoxes(gd).length) all.push({ formation_id: g.formation_id, name: g.name, code: '' });
      }
    }
    return all;
  }
  async function buildBookStructure(book) {
    var eb = await enterBook(book.book_id);
    var guid = eb.guid;
    var pickerDoc = parseHTML(eb.html);
    var pointsMode = parsePointsMode(eb.html);
    book.points_mode = pointsMode;
    var sectionOrder = parseLayoutSections(pickerDoc).order;
    var formations = await discoverFormations(guid, book.book_id, pickerDoc);

    // "Formation Support" units sit directly on the book's own top-level page (force_id = book_id).
    if (parseBoxes(pickerDoc).length) {
      formations.push({ formation_id: book.book_id, name: book.book_name + ' Formation Support', code: '', is_top_level: true });
    }

    var bs = {
      book_id: book.book_id, book_name: book.book_name, era: book.era || '', points_mode: pointsMode,
      sort_order: book.sort_order, section_order: sectionOrder, scraped_at: new Date().toISOString(),
      source: SOURCE, schema_version: SCHEMA_VERSION, formations: [], flags: [], errors: []
    };

    for (var idx = 0; idx < formations.length; idx++) {
      var f = formations[idx];
      var fid = f.formation_id;
      var html = '', furl = '', access = 'ok', boxes = [], fSectionOrder = [];
      try {
        if (f.is_top_level) {
          html = eb.html;
          furl = BASE + '/ForceDiagram/Index/' + guid + '/' + book.book_id + '/1';
          access = 'ok';
        } else {
          var r = await get('/ForceDiagram/SubFormationSelected/' + guid + '/' + book.book_id + '/1/' + fid + '/1');
          html = r.html; furl = r.url;
          access = noAccess(html, furl) ? 'denied' : (!looksLikePage(html) ? 'error' : 'ok');
        }
        var fdoc = parseHTML(html);
        // STRUCTURE IS ALWAYS READABLE: parse boxes even when denied (codes/names still survive).
        boxes = (access === 'ok' || access === 'denied') ? parseBoxes(fdoc) : [];
        fSectionOrder = (access === 'ok' || access === 'denied') ? parseLayoutSections(fdoc).order : [];
      } catch (e) {
        access = 'error'; boxes = []; fSectionOrder = [];
      }
      if (access === 'error') bs.errors.push({ formation_id: fid, name: f.name, url: furl });
      boxes.forEach(function (b) {
        if (b.slot_type === 'Command Card') return;
        b.units.forEach(function (u) {
          if (!u.code) bs.flags.push('formation ' + fid + ' box ' + b.box_id + ": unit '" + u.name + "' has NO code");
        });
      });
      bs.formations.push({
        formation_id: fid, name: f.name, code: f.code || '', access: access,
        sort_order: idx, url: furl, section_order: fSectionOrder, boxes: boxes
      });
    }
    bs.complete = bs.errors.length === 0;
    return bs;
  }

  // ── PASS 2: unit-card stats (ports parse_stat_box / parse_weapons / parse_one_unit / parse_unit /
  //            collect_refs / run_pass2, incl. multi-unit splitting + stub-on-denial) ───────────────
  function txt(el) { return el ? (el.textContent || '').trim() : ''; }
  function collapse(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

  function parseStatBox(div) {
    var main = div.querySelector('.cssS4red');
    var result = { name: '', roll: '' };
    if (main) {
      result.name = txt(main.querySelector('.cssS4red1'));
      result.roll = txt(main.querySelector('.cssS4red2'));
    }
    var extra = [];
    div.querySelectorAll('.cssList').forEach(function (cl) {
      var l = cl.querySelector('.cssS4L');
      var v = cl.querySelector('.cssS4R');
      if (l || v) extra.push({ label: l ? collapse(l.textContent) : '', value: txt(v) });
    });
    if (extra.length) result.extra = extra;
    return result;
  }
  function parseWeapons(scope) {
    var weapons = [], flags = [];
    var table = scope.querySelector('.Weapons table');
    if (!table) return { weapons: weapons, flags: flags };
    var current = null;
    table.querySelectorAll('tr').forEach(function (row) {
      if ((row.getAttribute('style') || '').replace(/\s/g, '').indexOf('display:none') !== -1) return;
      var cells = row.querySelectorAll('td');
      if (!cells.length) return;
      var texts = [];
      cells.forEach(function (c) { texts.push((c.textContent || '').trim()); });
      var any = texts.some(function (t) { return t; });
      if (!any || texts[0] === 'Weapon') return;

      var nameCell = cells[0];
      var name = (nameCell.textContent || '').trim();
      var optional = false;
      var span = nameCell.querySelector('span');
      if (span && (span.textContent || '').toUpperCase().indexOf('OPTIONAL') !== -1) {
        optional = true;
        name = name.replace((span.textContent || '').trim(), '').trim();
      }
      var T = function (i) { return i < texts.length ? texts[i] : ''; };
      var rofHalted, rofMoving, at, fp, notes;
      var colspanCell = cells.length > 2 ? cells[2] : null;
      if (colspanCell && colspanCell.hasAttribute('colspan')) {
        var marker = T(2);
        if (['ARTILLERY', 'SALVO'].indexOf(marker.toUpperCase()) === -1) {
          flags.push("weapon '" + name + "': unrecognized colspan marker '" + marker + "'");
        }
        rofHalted = marker; rofMoving = marker; at = T(3); fp = T(4); notes = T(5);
      } else {
        rofHalted = T(2); rofMoving = T(3); at = T(4); fp = T(5); notes = T(6);
      }
      var rowData = {
        range: T(1), rof_halted: rofHalted, rof_moving: rofMoving,
        anti_tank: at, fire_power: fp, notes: notes, optional: optional
      };
      if (current === null || nameCell.classList.contains('SS1')) {
        current = Object.assign({ weapon: name }, rowData, { fire_modes: [] });
        weapons.push(current);
      } else {
        current.fire_modes.push(Object.assign({ mode_name: name }, rowData));
      }
    });
    return { weapons: weapons, flags: flags };
  }
  function parseOneUnit(scope, knownCode) {
    var unit = {
      name: '', code: knownCode || '', options: [], upgrades: [], weapons: [],
      motivation: {}, skill: {}, is_hit_on: {}, save_type: '', save: {},
      special_rules: [], movement: {}, requirements: '', flags: []
    };

    var title = scope.querySelector('.UnitHeading .UTitle') || scope.querySelector('.DSubTitle');
    if (title) unit.name = txt(title);

    // this section's own CardImages code wins over knownCode.
    var cardImg = scope.querySelector('img[src*="/CardImages/"]');
    if (!cardImg) {
      var imgs = scope.querySelectorAll('img');
      for (var ii = 0; ii < imgs.length; ii++) {
        if (CODE_RE.test(assetStem(imgs[ii].getAttribute('src') || ''))) { cardImg = imgs[ii]; break; }
      }
    }
    if (cardImg) {
      var secCode = codeFromCardImage(cardImg.getAttribute('src') || '');
      if (secCode) unit.code = secCode;
    }

    // loadout choices (radio, mutually exclusive)
    scope.querySelectorAll('div.Choices').forEach(function (choice) {
      var oc = choice.querySelector('.OChoice');
      if (!oc) return;
      var op = oc.querySelector('.OPoints');
      var pointsText = op ? txt(op) : '';
      var pm = pointsText.match(/(-?\d+)/);
      var label = txt(oc);
      if (op) label = label.replace(txt(op), '').trim();
      var inp = choice.querySelector('input[type=radio]');
      if (!inp) unit.flags.push("option '" + label + "': no radio input found");
      if (!pm) unit.flags.push("option '" + label + "': no points value found");
      unit.options.push({
        option_id: inp ? (inp.getAttribute('value') || '') : '',
        label: label,
        points: pm ? parseInt(pm[1], 10) : null
      });
    });

    // additive upgrades (checkbox; may carry a quantity <select>)
    scope.querySelectorAll('div.Options').forEach(function (opt) {
      if (opt.classList.contains('OO') || opt.classList.contains('ORaw')) return;
      var cb = opt.querySelector('input[type=checkbox]');
      if (!cb) return;
      var quantityRange = null;
      var sel = opt.querySelector('select');
      if (sel) {
        var nums = [];
        sel.querySelectorAll('option').forEach(function (o) {
          var v = o.getAttribute('value') || '';
          if (/^\d+$/.test(v)) nums.push(parseInt(v, 10));
        });
        if (nums.length) quantityRange = [Math.min.apply(null, nums), Math.max.apply(null, nums)];
      }
      var clone = opt.cloneNode(true);
      var cs = clone.querySelector('select');
      if (cs) cs.parentNode.removeChild(cs);
      var entry = { checkbox_id: cb.getAttribute('id') || '', text: collapse(clone.textContent) };
      if (quantityRange) entry.quantity_range = quantityRange;
      unit.upgrades.push(entry);
    });

    // motivation / skill / is hit on / save-or-armour
    scope.querySelectorAll('.cssS4Left').forEach(function (box) {
      var h = box.querySelector('.cssS4H');
      if (!h) return;
      var key = (h.textContent || '').trim().toUpperCase();
      if (key === 'MOTIVATION') unit.motivation = parseStatBox(box);
      else if (key === 'SKILL') unit.skill = parseStatBox(box);
      else if (key === 'IS HIT ON') unit.is_hit_on = parseStatBox(box);
      else if (key === 'SAVE' || key === 'ARMOUR') {
        unit.save_type = key;
        var armour = box.querySelector('.cssArmour');
        if (armour) {
          var labels = armour.querySelectorAll('.cssS4LBr');
          var values = armour.querySelectorAll('.cssS4RB');
          var save = {};
          var n = Math.min(labels.length, values.length);
          for (var k = 0; k < n; k++) save[txt(labels[k])] = txt(values[k]);
          unit.save = save;
        }
      } else {
        unit.flags.push("unrecognized stat box: '" + key + "'");
      }
    });

    var special = scope.querySelector('.Special2');
    if (special) {
      unit.special_rules = (special.textContent || '').split('•').map(function (t) { return t.trim(); }).filter(Boolean);
    }

    var mv = scope.querySelector('.Movement table');
    if (mv) {
      var rows = mv.querySelectorAll('tr');
      if (rows.length >= 2) {
        var headers = [], values = [];
        rows[0].querySelectorAll('td').forEach(function (c) { headers.push((c.textContent || '').trim()); });
        rows[1].querySelectorAll('td').forEach(function (c) { values.push((c.textContent || '').trim()); });
        var mvObj = {};
        for (var mi = 0; mi < Math.min(headers.length, values.length); mi++) mvObj[headers[mi]] = values[mi];
        unit.movement = mvObj;
      }
    }

    var w = parseWeapons(scope);
    unit.weapons = w.weapons;
    unit.flags = unit.flags.concat(w.flags);

    var req = scope.querySelector('.CCReq1 .CCReq');
    if (req) unit.requirements = txt(req);

    var hasAny = unit.options.length || unit.upgrades.length || unit.weapons.length ||
      Object.keys(unit.motivation).length || Object.keys(unit.skill).length ||
      Object.keys(unit.is_hit_on).length || Object.keys(unit.save).length;
    if (unit.name && !hasAny) {
      unit.flags.push('no options/upgrades/weapons/stats extracted — page structure may be unrecognized');
    }
    return unit;
  }
  function sectionHasRealUnit(fragHTML) {
    var re = /src\s*=\s*["']([^"']+)["']/g, m;
    while ((m = re.exec(fragHTML))) { if (isCardImage(m[1])) return true; }
    return false;
  }
  function parseUnit(doc, knownCode) {
    var heads = doc.querySelectorAll('.UnitHeading');
    if (heads.length <= 1) return [parseOneUnit(doc, knownCode)];

    var realSections = [];
    heads.forEach(function (h) {
      var frag = h.outerHTML;
      var sib = h.nextElementSibling;
      while (sib && !sib.classList.contains('UnitHeading')) { frag += sib.outerHTML; sib = sib.nextElementSibling; }
      if (sectionHasRealUnit(frag)) realSections.push(frag);
    });
    if (!realSections.length) return [parseOneUnit(doc, knownCode)];

    return realSections.map(function (frag, i) {
      return parseOneUnit(parseHTML(frag), i === 0 ? knownCode : '');
    });
  }
  function collectRefs(structs) {
    var codeRefs = {}, cardBoxes = [];
    structs.forEach(function (bs) {
      bs.formations.forEach(function (f) {
        f.boxes.forEach(function (box) {
          if (box.slot_type === 'Command Card') { cardBoxes.push({ bs: bs, f: f, box: box }); return; }
          box.units.forEach(function (u) {
            if (!u.code) return;
            var refs = codeRefs[u.code] || (codeRefs[u.code] = []);
            var url = u.url || '';
            if (url && refs.some(function (r) { return r.url === url; })) return;
            refs.push({ url: url, name: u.name || '', book_id: bs.book_id });
          });
        });
      });
    });
    return { codeRefs: codeRefs, cardBoxes: cardBoxes };
  }
  function stubEntry(code, ref, access) {
    return {
      code: code, name: ref.name || '', access: access, url: ref.url || '', book_id: ref.book_id,
      options: [], upgrades: [], weapons: [], motivation: {}, skill: {}, is_hit_on: {},
      save_type: '', save: {}, special_rules: [], movement: {}, requirements: '', flags: [],
      source: SOURCE, scraped_at: new Date().toISOString()
    };
  }
  // Run `worker(item)` over items with at most `limit` in flight at once. Each item goes to exactly one
  // runner (next++ has no await between read and write, so it's atomic) — no item runs twice, no overlap.
  async function pool(items, limit, worker) {
    var next = 0;
    async function runner() {
      while (next < items.length && !hardBlocked) {
        var i = next++;
        await worker(items[i], i);
      }
    }
    var runners = [];
    var n = Math.min(limit, items.length);
    for (var k = 0; k < n; k++) runners.push(runner());
    await Promise.all(runners);
  }
  async function runPass2(structs) {
    var refs = collectRefs(structs);
    var codeRefs = refs.codeRefs, cardBoxes = refs.cardBoxes;
    var codes = Object.keys(codeRefs);
    var done = 0;

    // 5 units in flight at once (in-tab concurrency). Codes are distinct so workers never overlap, and
    // the shared `catalog` dedup (skip already-'ok', re-try denied in later books) is unchanged.
    await pool(codes, 5, async function (code) {
      done++;
      setProgress(done, codes.length + cardBoxes.length, 'Unit ' + code);
      if (catalog[code] && catalog[code].access === 'ok') return;

      var list = codeRefs[code];
      var got = false, sawDenied = false, sawUrl = false;
      var stubRef = list.find(function (r) { return r.url; }) || list[0];

      for (var ri = 0; ri < list.length; ri++) {
        var ref = list[ri];
        if (!ref.url) continue;
        sawUrl = true;
        var r;
        try { r = await get(ref.url); } catch (e) { continue; }
        if (noAccess(r.html, r.url)) { sawDenied = true; continue; }
        if (!looksLikePage(r.html)) continue;
        var units = parseUnit(parseHTML(r.html), code);
        var stamp = new Date().toISOString();
        units.forEach(function (u, i) {
          var ucode = u.code || (i === 0 ? code : '');
          if (!ucode) return;
          u.access = 'ok'; u.url = r.url; u.scraped_at = stamp; u.source = SOURCE; u.book_id = ref.book_id;
          catalog[ucode] = u;
        });
        got = true;
        break;
      }
      if (!got) {
        var access = (sawDenied || !sawUrl) ? 'denied' : 'error';
        catalog[code] = stubEntry(code, stubRef, access);
      }
    });

    // command cards: book-scoped, no code — 5 boxes in flight; each box's units are distinct objects
    // enriched in place, so concurrent boxes never touch the same entry.
    await pool(cardBoxes, 5, async function (cb) {
      done++;
      setProgress(done, codes.length + cardBoxes.length, 'Command cards');
      for (var ui2 = 0; ui2 < cb.box.units.length; ui2++) {
        var u = cb.box.units[ui2];
        u.book_id = cb.bs.book_id;
        u.formation_id = cb.f.formation_id;
        u.box_id = cb.box.box_id;
        u.effect_text = cb.box.description || '';
        if (!u.url) { u.access = 'denied'; continue; }
        try {
          var cr = await get(u.url);
          if (noAccess(cr.html, cr.url)) { u.access = 'denied'; continue; }
          if (!looksLikePage(cr.html)) { u.access = 'error'; continue; }
          var card = parseUnit(parseHTML(cr.html), '')[0];
          u.access = 'ok';
          u.points = card.options.length ? card.options[0].points : null;
          u.options = card.options;
          u.per_unit = card.upgrades.some(function (up) { return (up.text || '').toLowerCase().indexOf('total cards') !== -1; });
          u.requirements_raw = card.requirements;
          u.card_url = cr.url;
          u.flags = card.flags;
        } catch (e) {
          u.access = 'error';
        }
      }
    });
  }

  // ── assemble one book + send it ──────────────────────────────────────────────────────────────────
  // Attach each unit's stats INLINE onto its slot in the structure, so the JSON reads straight down:
  // book → force (formation) → slot → the units in it, each with its own loadouts/weapons/stats right
  // there. No separate lookup map — the book stands alone.
  function assembleBook(bs) {
    bs.formations.forEach(function (f) {
      f.boxes.forEach(function (box) {
        if (box.slot_type === 'Command Card') return; // command-card units are already enriched inline
        box.units.forEach(function (u) {
          var c = u.code && catalog[u.code];         // its stats, matched by L-code (fetched once this run)
          if (!c) return;                            // codeless / not-yet-fetched → leave as {code,name,url}
          u.access = c.access; u.options = c.options; u.upgrades = c.upgrades; u.weapons = c.weapons;
          u.motivation = c.motivation; u.skill = c.skill; u.is_hit_on = c.is_hit_on;
          u.save_type = c.save_type; u.save = c.save; u.special_rules = c.special_rules;
          u.movement = c.movement; u.requirements = c.requirements; u.flags = c.flags;
          u.scraped_at = c.scraped_at;
        });
      });
    });
    return {
      schema_version: SCHEMA_VERSION,
      source: SOURCE,
      collector_version: COLLECTOR_VERSION,
      run_id: RUN_ID,
      scraped_at: new Date().toISOString(),
      book: bs
    };
  }
  // Send one book to the Worker. text/plain keeps it a "simple" cross-origin request (no CORS preflight);
  // the Worker must return an Access-Control-Allow-Origin header for resp.ok to be readable here.
  async function uploadBook(payload) {
    var resp = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) throw new Error('server returned ' + resp.status);
  }

  // ── main ─────────────────────────────────────────────────────────────────────────────────────────
  // One book at a time, end to end: build its structure, fetch its units' stats (reusing the run cache),
  // send that book, then move on. Each book is isolated — one book failing never touches the others, and
  // anything already sent is safe if the user closes the tab mid-run.
  async function main() {
    try {
      setStatus('Reading your book list…');
      var nf = await get('/Home/NewFormation');
      if (/Account\/Login/i.test(nf.url)) {
        return fatal('You’re not signed in to forces.flamesofwar.com. Sign in there, then click the bookmark again.');
      }
      books = parseBooks(nf.html);
      if (!books.length) {
        return fatal('No books found on your account. Make sure you’re signed in to forces.flamesofwar.com, then try again.');
      }

      var sent = 0, failed = [];
      // Stop button — lets the user bail without closing the tab. Removes the overlay and flags the loop
      // to stop before the next book; any book already sent stays safe.
      ui.foot.appendChild(button('Stop', '#8a3b34', function () {
        cancelled = true;
        ui.wrap.remove();
        window.__fowCollectorRunning = false;
      }));
      for (var i = 0; i < books.length; i++) {
        if (cancelled) return;
        if (hardBlocked) break;
        var book = books[i];
        setStatus('Book ' + (i + 1) + '/' + books.length + ': ' + book.book_name + ' — reading & sending…');
        var bs;
        try {
          bs = await buildBookStructure(book);   // structure (forces, boxes, unit codes)
          await runPass2([bs]);                  // stats → shared in-memory cache; already-seen L-codes skipped
        } catch (e) {
          errors.push('book ' + book.book_id + ' (' + book.book_name + '): ' + (e.message || e));
          failed.push(book.book_name);
          continue;
        }
        if (hardBlocked) break;                  // scraped while blocked — don't upload a corrupt book
        var payload = assembleBook(bs);          // self-contained: this book + its own units inline
        try {
          await uploadBook(payload);
          sent++;
        } catch (e) {
          failed.push(book.book_name);
          failedPayloads.push(payload);          // keep it so the user can still download what didn't send
        }
      }

      if (hardBlocked) {
        ui.foot.innerHTML = '';
        finishHead('Stopped — the site blocked us', false);
        setStatus('Rate-limited/blocked after ' + blockedCount + ' tries. ' + sent + ' book(s) sent. ' +
          'Sign in again on forces.flamesofwar.com and re-run to finish.');
        if (failedPayloads.length) offerDownload(failedPayloads, 'Download ' + failedPayloads.length + ' unsent book(s)');
        addClose();
      } else {
        finishSummary(sent, books.length, failed);
      }
    } catch (e) {
      fatal('Something went wrong: ' + (e.message || e));
    }
  }

  main();
})();
