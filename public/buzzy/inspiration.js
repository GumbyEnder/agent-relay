/*
 * BeeZilla "Inspiration" wall for the Talk page.
 *
 * Plain ES5, no build step, no external libraries.
 *
 *   var wall = BeeZillaInspiration.mount(el, { onPrompt: function (text) { ... } });
 *   wall.refresh();        // re-read assets and documents; returns a Promise
 *   wall.filter(fn);       // show only the items where fn(item) is truthy
 *   wall.filter('photo');  // or one kind: photo, audio, 3d, file, document
 *   wall.filter(null);     // show everything again
 *   wall.destroy();        // remove everything this mount added to the page
 *
 * Reads only the two same-origin endpoints:
 *   GET /api/buzzy/assets?limit=200  -> { ok, files: <a count>, items: [...] }
 *   GET /api/buzzy/documents         -> { documents: [...] }
 * Asset rows are taken from the first array the response holds (items, files, assets, rows).
 */
(function (global) {
  'use strict';

  var ASSETS_URL = '/api/buzzy/assets?limit=200';
  var DOCUMENTS_URL = '/api/buzzy/documents';
  var ASSET_FILE_PREFIX = '/api/buzzy/assets/';
  var LIBRARY_PATH = '/buzzy/library?job=';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var FOCUSABLE = 'a[href], button:not([disabled]), audio[controls], input:not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  var IDEAS = [
    'Design a logo for my bakery',
    "Make a song for my shop's opening",
    'Make a 3D model of my product',
    'Write a price list for my services',
    'Draft a welcome email for new customers',
    'Plan a launch week'
  ];

  var KIND_NAMES = {
    photo: 'Photo',
    audio: 'Audio',
    '3d': '3D model',
    file: 'File',
    document: 'Document',
    idea: 'Idea'
  };

  var IMAGE_EXT = { png: true, jpg: true, jpeg: true, gif: true, webp: true, avif: true, bmp: true, svg: true };
  var AUDIO_EXT = { mp3: true, wav: true, m4a: true, aac: true, ogg: true, oga: true, flac: true };
  var MODEL_EXT = { glb: true, gltf: true, obj: true, usdz: true };

  // The four typographic looks. Each item keeps its look because it is picked by a hash of its id.
  var TYPE_STYLES = [
    { cls: 'insp-type--ink', rule: false },   // yellow on black
    { cls: 'insp-type--paper', rule: true },  // black on off-white, with a short yellow rule
    { cls: 'insp-type--sun', rule: false },   // black on yellow, uppercase
    { cls: 'insp-type--plain', rule: false }  // black on off-white
  ];

  var uid = 0;

  /* ---------- small helpers ---------- */

  function h(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function decorative(node) {
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  function str(v) {
    return v == null ? '' : String(v);
  }

  function inMap(map, key) {
    return key !== '' && Object.prototype.hasOwnProperty.call(map, key);
  }

  function hashString(s) {
    var hash = 0;
    for (var i = 0; i < s.length; i++) {
      hash = (hash * 31 + s.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  function styleFor(seed) {
    return TYPE_STYLES[hashString(str(seed)) % TYPE_STYLES.length];
  }

  function lengthClass(text) {
    var n = text.length;
    if (n <= 22) return 'insp-len-s';
    if (n <= 56) return 'insp-len-m';
    return 'insp-len-l';
  }

  function makeButton(cls, label, glyph) {
    var b = h('button', cls, glyph);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    return b;
  }

  function cubeSvg(cls) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    var path = document.createElementNS(SVG_NS, 'path');
    svg.setAttribute('class', cls);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    path.setAttribute('d', 'M12 2.5 20.5 7.25v9.5L12 21.5 3.5 16.75v-9.5L12 2.5zM3.5 7.25 12 12l8.5-4.75M12 12v9.5');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function makeAudio(url, cls) {
    var audio = document.createElement('audio');
    audio.className = cls;
    audio.controls = true;
    audio.preload = 'none';
    audio.src = url;
    return audio;
  }

  function downloadLink(url, name, label) {
    var a = document.createElement('a');
    a.className = 'insp-btn-link';
    a.href = url;
    a.setAttribute('download', name);
    a.textContent = label;
    return a;
  }

  function elementOf(node) {
    var n = node;
    while (n && n.nodeType !== 1) n = n.parentNode;
    return n || null;
  }

  /* ---------- data normalisation (no DOM needed) ---------- */

  // Epoch seconds or milliseconds, or a date string. Anything unreadable sorts last (0).
  function toTime(v) {
    var n;
    if (v == null || v === '') return 0;
    if (typeof v === 'number') {
      n = v;
    } else {
      var s = String(v).trim();
      if (/^\d+(\.\d+)?$/.test(s)) {
        n = Number(s);
      } else {
        var parsed = Date.parse(s);
        return isNaN(parsed) ? 0 : parsed;
      }
    }
    if (!isFinite(n) || n <= 0) return 0;
    return n < 1e11 ? n * 1000 : n;
  }

  function toBytes(v) {
    if (v == null || v === '') return null;
    var n = Number(v);
    return isFinite(n) && n >= 0 ? n : null;
  }

  function formatBytes(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return Math.round(bytes) + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  function extOf(name) {
    var s = str(name);
    var dot = s.lastIndexOf('.');
    return dot < 0 || dot === s.length - 1 ? '' : s.slice(dot + 1).toLowerCase();
  }

  function baseName(path) {
    var parts = str(path).replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || '';
  }

  // The list key is not fixed: take the first array the response holds, preferring known names.
  function pickArray(data, keys) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];
    var i;
    for (i = 0; i < keys.length; i++) {
      if (Array.isArray(data[keys[i]])) return data[keys[i]];
    }
    for (var k in data) {
      if (Object.prototype.hasOwnProperty.call(data, k) && Array.isArray(data[k])) return data[k];
    }
    return [];
  }

  function assetKind(ct, ext) {
    if (ct.indexOf('image/') === 0) return 'photo';
    if (ct.indexOf('audio/') === 0 || inMap(AUDIO_EXT, ext)) return 'audio';
    if (ct.indexOf('model/') === 0 || inMap(MODEL_EXT, ext)) return '3d';
    if ((ct === '' || ct === 'application/octet-stream') && inMap(IMAGE_EXT, ext)) return 'photo';
    return 'file';
  }

  function fileLabel(ext) {
    if (ext === 'docx' || ext === 'doc') return 'Word document';
    if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') return 'Spreadsheet';
    if (ext === 'pdf') return 'PDF document';
    if (ext === 'pptx' || ext === 'ppt') return 'Presentation';
    return ext ? ext.toUpperCase() + ' file' : 'File';
  }

  function fileBadge(ext) {
    if (ext === 'docx' || ext === 'doc') return { text: 'W', cls: 'insp-badge--blue' };
    if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') return { text: 'E', cls: 'insp-badge--green' };
    if (ext === 'pdf') return { text: 'PDF', cls: 'insp-badge--red' };
    return { text: ext ? ext.toUpperCase().slice(0, 4) : 'FILE', cls: 'insp-badge--neutral' };
  }

  function assetItem(row, order) {
    if (!row || typeof row !== 'object' || row.id == null || row.id === '') return null;
    var id = String(row.id);
    var relPath = str(row.rel_path);
    var title = str(row.filename).trim() || baseName(relPath) || 'Untitled file';
    var contentType = str(row.content_type).split(';')[0].trim().toLowerCase();
    var ext = extOf(title) || extOf(relPath);
    var kind = assetKind(contentType, ext);
    var jobTitle = str(row.job_title).trim();
    var sub = jobTitle;
    if (kind === 'file') sub = fileLabel(ext);
    if (kind === '3d') sub = '3D model';
    return {
      key: 'asset:' + id,
      kind: kind,
      id: id,
      title: title,
      url: ASSET_FILE_PREFIX + encodeURIComponent(id),
      libraryUrl: '',
      contentType: contentType,
      ext: ext,
      bytes: toBytes(row.bytes),
      ts: toTime(row.created_at) || toTime(row.updated_at),
      order: order,
      jobTitle: jobTitle,
      sub: sub
    };
  }

  function documentItem(doc, order) {
    if (!doc || typeof doc !== 'object') return null;
    var id = str(doc.id);
    var jobId = str(doc.job_id);
    if (!id && !jobId) return null;
    var key = id || jobId;
    var libraryUrl = LIBRARY_PATH + encodeURIComponent(jobId || id);
    return {
      key: 'doc:' + key,
      kind: 'document',
      id: key,
      title: str(doc.title).trim() || 'Untitled document',
      url: libraryUrl,
      libraryUrl: libraryUrl,
      contentType: '',
      ext: '',
      bytes: null,
      ts: toTime(doc.updated_at) || toTime(doc.created_at),
      order: order,
      jobTitle: '',
      sub: [str(doc.type).trim(), str(doc.status).trim()].filter(Boolean).join(' · ')
    };
  }

  function ideaItems() {
    var list = [];
    for (var i = 0; i < IDEAS.length; i++) {
      list.push({
        key: 'idea:' + i,
        kind: 'idea',
        id: 'idea-' + i,
        title: IDEAS[i],
        url: '',
        libraryUrl: '',
        contentType: '',
        ext: '',
        bytes: null,
        ts: 0,
        order: i,
        jobTitle: '',
        sub: ''
      });
    }
    return list;
  }

  // Newest first. Items with no usable timestamp keep their arrival order at the end.
  function buildItems(assetRows, documentRows) {
    var items = [];
    var i;
    var item;
    for (i = 0; i < assetRows.length; i++) {
      item = assetItem(assetRows[i], items.length);
      if (item) items.push(item);
    }
    for (i = 0; i < documentRows.length; i++) {
      item = documentItem(documentRows[i], items.length);
      if (item) items.push(item);
    }
    items.sort(function (a, b) {
      if (a.ts !== b.ts) return b.ts - a.ts;
      return a.order - b.order;
    });
    return items;
  }

  /* ---------- network ---------- */

  function getJSON(url, signal) {
    if (typeof global.fetch !== 'function') {
      return Promise.reject(new Error('fetch is not available'));
    }
    var init = { credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (signal) init.signal = signal;
    return global.fetch(url, init).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  // Any failure (signed out, offline, bad JSON) reads as "nothing here yet". No error is shown.
  function loadList(url, keys, signal) {
    return getJSON(url, signal).then(function (data) {
      return pickArray(data, keys);
    }, function () {
      return [];
    });
  }

  /* ---------- state ---------- */

  function setItems(state, items) {
    var index = {};
    var i;
    for (i = 0; i < state.ideas.length; i++) index[state.ideas[i].key] = state.ideas[i];
    for (i = 0; i < items.length; i++) index[items[i].key] = items[i];
    state.items = items;
    state.index = index;
  }

  function itemByKey(state, key) {
    return inMap(state.index, key) ? state.index[key] : null;
  }

  function passes(fn, item) {
    try {
      return !!fn(item);
    } catch (err) {
      return false;
    }
  }

  function visibleItems(state) {
    if (!state.filter) return state.items;
    var out = [];
    for (var i = 0; i < state.items.length; i++) {
      if (passes(state.filter.fn, state.items[i])) out.push(state.items[i]);
    }
    return out;
  }

  function kindFilter(kind, label) {
    return {
      label: label,
      fn: function (item) {
        return item.kind === kind;
      }
    };
  }

  function setFilter(state, filter, focusType) {
    if (state.destroyed) return;
    state.filter = filter;
    state.filterSeq += 1;
    state.focusNext = focusType ? { type: focusType } : null;
    render(state);
  }

  function setFilterArg(state, arg) {
    if (typeof arg === 'function') {
      setFilter(state, { label: 'Filtered', fn: arg }, null);
    } else if (typeof arg === 'string' && arg !== '') {
      setFilter(state, kindFilter(arg, 'Filtered'), null);
    } else {
      setFilter(state, null, null);
    }
  }

  function refresh(state) {
    if (state.destroyed) return Promise.resolve();
    state.seq += 1;
    var seq = state.seq;
    if (state.ctrl && state.ctrl.abort) state.ctrl.abort();
    var ctrl = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    state.ctrl = ctrl;
    var signal = ctrl ? ctrl.signal : null;
    state.loading = true;
    render(state);
    return Promise.all([
      loadList(ASSETS_URL, ['items', 'files', 'assets', 'rows'], signal),
      loadList(DOCUMENTS_URL, ['documents', 'rows', 'items'], signal)
    ]).then(function (results) {
      if (state.destroyed || seq !== state.seq) return;
      state.loaded = true;
      state.loading = false;
      setItems(state, buildItems(results[0], results[1]));
      render(state);
    });
  }

  function destroy(state) {
    if (state.destroyed) return;
    state.destroyed = true;
    if (state.ctrl && state.ctrl.abort) state.ctrl.abort();
    closeViewer(state, false);
    if (state.root.parentNode) state.root.parentNode.removeChild(state.root);
    state.items = [];
    state.index = {};
    state.filter = null;
  }

  /* ---------- rendering ---------- */

  function render(state) {
    if (state.destroyed) return;
    var root = state.root;
    var showIdeas = state.loaded && state.items.length === 0;
    var list = state.loaded && !showIdeas ? visibleItems(state) : [];
    var sig = [
      state.loaded ? 'loaded' : 'pending',
      showIdeas ? 'ideas' : 'work',
      state.filterSeq,
      list.map(function (it) {
        return it.key + '\u0001' + it.title + '\u0001' + it.sub;
      }).join('\u0002')
    ].join('|');

    root.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    if (sig === state.sig && !state.focusNext) return;

    var target = state.focusNext || focusTargetOf(root);
    state.focusNext = null;
    state.sig = sig;

    root.textContent = '';
    if (!state.loaded) {
      root.appendChild(h('p', 'insp-sr', 'Loading finished work'));
      root.appendChild(buildSkeleton());
    } else if (showIdeas) {
      root.appendChild(h('h3', 'insp-empty-title', 'Finished work shows up here.'));
      root.appendChild(buildWall(state.ideas));
    } else {
      if (state.filter) root.appendChild(buildFilterBar(state));
      if (list.length) {
        root.appendChild(buildWall(list));
      } else {
        root.appendChild(h('p', 'insp-none', 'Nothing matches this filter.'));
      }
    }

    if (target) applyFocus(root, target);
  }

  function buildFilterBar(state) {
    var bar = h('div', 'insp-filter');
    var pill = h('div', 'insp-filter-pill');
    var clear = h('button', 'insp-filter-clear');
    clear.type = 'button';
    clear.title = 'Show all work';
    clear.setAttribute('aria-label', 'Show all work');
    clear.appendChild(document.createTextNode('Show all '));
    clear.appendChild(decorative(h('span', 'insp-filter-x', '✕')));
    pill.appendChild(h('span', 'insp-filter-label', state.filter.label));
    pill.appendChild(decorative(h('span', 'insp-filter-sep', '·')));
    pill.appendChild(clear);
    bar.appendChild(pill);
    return bar;
  }

  function buildWall(items) {
    var wall = h('div', 'insp-wall');
    for (var i = 0; i < items.length; i++) {
      wall.appendChild(buildCard(items[i]));
    }
    return wall;
  }

  function buildSkeleton() {
    var sizes = [
      'insp-skel--m', 'insp-skel--l', 'insp-skel--s', 'insp-skel--s',
      'insp-skel--l', 'insp-skel--m', 'insp-skel--s', 'insp-skel--m'
    ];
    var wall = decorative(h('div', 'insp-wall'));
    for (var i = 0; i < sizes.length; i++) {
      wall.appendChild(h('div', 'insp-skel ' + sizes[i]));
    }
    return wall;
  }

  function buildCard(item) {
    if (item.kind === 'idea') return buildIdeaCard(item);
    if (item.kind === 'document') return buildDocumentCard(item);

    var card = h('article', 'insp-card insp-card--' + item.kind);
    card.tabIndex = 0;
    card.draggable = true;
    card.setAttribute('data-kind', item.kind);
    card.setAttribute('data-key', item.key);
    card.setAttribute('aria-label', (KIND_NAMES[item.kind] || 'File') + ': ' + item.title);
    if (item.kind === 'photo') {
      fillPhoto(card, item);
    } else if (item.kind === 'audio') {
      fillAudio(card, item);
    } else if (item.kind === '3d') {
      fill3d(card, item);
    } else {
      fillFile(card, item);
    }
    appendControls(card);
    return card;
  }

  function fillPhoto(card, item) {
    var img = document.createElement('img');
    img.className = 'insp-img';
    img.alt = item.title;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    img.addEventListener('error', function () {
      card.classList.add('insp-card--broken');
    });
    img.src = item.url;
    card.appendChild(img);
  }

  function fillAudio(card, item) {
    card.appendChild(decorative(h('div', 'insp-glyph', '♪')));
    card.appendChild(h('div', 'insp-name', item.title));
    if (item.sub) card.appendChild(h('div', 'insp-sub', item.sub));
    card.appendChild(makeAudio(item.url, 'insp-audio'));
  }

  function fill3d(card, item) {
    card.appendChild(cubeSvg('insp-cube'));
    card.appendChild(h('div', 'insp-name', item.title));
    card.appendChild(h('div', 'insp-sub', '3D model'));
  }

  function fillFile(card, item) {
    var badge = fileBadge(item.ext);
    card.appendChild(decorative(h('span', 'insp-badge ' + badge.cls, badge.text)));
    card.appendChild(h('div', 'insp-name', item.title));
    if (item.sub) card.appendChild(h('div', 'insp-sub', item.sub));
  }

  function appendControls(card) {
    card.appendChild(makeButton('insp-btn insp-btn--similar', 'Show similar work', '↗'));
    card.appendChild(makeButton('insp-btn insp-btn--expand', 'Expand', '⛶'));
  }

  function buildDocumentCard(item) {
    var style = styleFor(item.id);
    var card = h('article', 'insp-card insp-card--document insp-type ' + style.cls + ' ' + lengthClass(item.title));
    card.tabIndex = 0;
    card.draggable = true;
    card.setAttribute('data-kind', 'document');
    card.setAttribute('data-key', item.key);
    card.setAttribute('aria-label', 'Document: ' + item.title);
    card.appendChild(h('span', 'insp-type-text', item.title));
    if (style.rule) card.appendChild(decorative(h('span', 'insp-rule')));
    if (item.sub) card.appendChild(h('span', 'insp-sub', item.sub));
    appendControls(card);
    return card;
  }

  function buildIdeaCard(item) {
    var style = styleFor(item.title);
    var card = h('button', 'insp-card insp-card--idea insp-type ' + style.cls + ' ' + lengthClass(item.title));
    card.type = 'button';
    card.setAttribute('data-kind', 'idea');
    card.setAttribute('data-key', item.key);
    card.setAttribute('aria-label', 'Idea: ' + item.title);
    card.appendChild(h('span', 'insp-tag', 'Idea'));
    card.appendChild(h('span', 'insp-type-text', item.title));
    return card;
  }

  function findCard(root, key) {
    var cards = root.querySelectorAll('.insp-card');
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute('data-key') === key) return cards[i];
    }
    return null;
  }

  // Where focus was, so a re-render (refresh, filter change) puts it back on the same control.
  function focusTargetOf(root) {
    var active = document.activeElement;
    if (!active || active === root || !root.contains(active)) return null;
    if (active.classList.contains('insp-filter-clear')) return { type: 'filter-clear' };
    var card = active.closest ? active.closest('.insp-card') : null;
    if (!card) return null;
    var key = card.getAttribute('data-key');
    if (active === card) return { type: 'card', key: key, which: 'card' };
    if (active.classList.contains('insp-btn--similar')) return { type: 'card', key: key, which: 'similar' };
    if (active.classList.contains('insp-btn--expand')) return { type: 'card', key: key, which: 'expand' };
    return null;
  }

  function applyFocus(root, target) {
    var node = null;
    if (target.type === 'filter-clear') {
      node = root.querySelector('.insp-filter-clear');
    } else if (target.type === 'first-card') {
      node = root.querySelector('.insp-card');
    } else if (target.type === 'card') {
      node = findCard(root, target.key);
      if (node && target.which !== 'card') {
        node = node.querySelector(target.which === 'similar' ? '.insp-btn--similar' : '.insp-btn--expand') || node;
      }
    }
    if (node && node.focus) node.focus({ preventScroll: true });
  }

  /* ---------- events on the wall ---------- */

  function cardFromEvent(state, e) {
    var el = elementOf(e.target);
    var card = el && el.closest ? el.closest('.insp-card') : null;
    return card && state.root.contains(card) ? card : null;
  }

  function goTo(url, e) {
    if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) {
      global.open(url, '_blank', 'noopener');
    } else {
      global.location.href = url;
    }
  }

  function onRootClick(state, e) {
    var el = elementOf(e.target);
    if (!el || !el.closest) return;
    if (el.closest('.insp-filter-clear')) {
      setFilter(state, null, 'first-card');
      return;
    }
    var card = cardFromEvent(state, e);
    if (!card) return;
    var item = itemByKey(state, card.getAttribute('data-key'));
    if (!item) return;
    if (item.kind === 'idea') {
      if (state.onPrompt) state.onPrompt(item.title);
      return;
    }
    if (el.closest('.insp-btn--similar')) {
      setFilter(state, kindFilter(item.kind, 'Showing similar'), 'filter-clear');
      return;
    }
    var expand = el.closest('.insp-btn--expand');
    if (expand) {
      openViewer(state, item, expand);
      return;
    }
    // Native controls inside a card (the audio player, links) keep their own clicks.
    if (el.closest('audio, video, a, input, select, textarea, button, label')) return;
    if (item.kind === 'document') {
      goTo(item.libraryUrl, e);
      return;
    }
    openViewer(state, item, card);
  }

  function onRootKeydown(state, e) {
    if (e.key !== 'Enter') return;
    var card = cardFromEvent(state, e);
    if (!card || elementOf(e.target) !== card) return;
    var item = itemByKey(state, card.getAttribute('data-key'));
    if (!item || item.kind === 'idea') return;
    e.preventDefault();
    openViewer(state, item, card);
  }

  function onRootDragStart(state, e) {
    var card = cardFromEvent(state, e);
    if (!card || !e.dataTransfer) return;
    var item = itemByKey(state, card.getAttribute('data-key'));
    if (!item || item.kind === 'idea') return;
    try {
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('application/x-beezilla-card', JSON.stringify({
        kind: item.kind,
        id: item.id,
        title: item.title,
        url: item.url,
        contentType: item.contentType
      }));
      e.dataTransfer.setData('text/plain', item.title);
    } catch (err) {
      // Some browsers refuse a custom type; the drag then carries whatever they accept.
    }
    card.classList.add('insp-dragging');
  }

  function onRootDragEnd(state) {
    var dragging = state.root.querySelectorAll('.insp-dragging');
    for (var i = 0; i < dragging.length; i++) {
      dragging[i].classList.remove('insp-dragging');
    }
  }

  /* ---------- viewer (expand) ---------- */

  function documentTypeCard(item) {
    var style = styleFor(item.id);
    var card = h('div', 'insp-viewer-type insp-type ' + style.cls);
    card.appendChild(h('span', 'insp-type-text', item.title));
    if (style.rule) card.appendChild(decorative(h('span', 'insp-rule')));
    if (item.sub) card.appendChild(h('span', 'insp-sub', item.sub));
    return card;
  }

  function viewerContent(item) {
    var wrap = h('div', 'insp-viewer');
    var meta = [item.sub, formatBytes(item.bytes)].filter(Boolean).join(' · ');
    var link;

    if (item.kind === 'photo') {
      var img = document.createElement('img');
      img.className = 'insp-viewer-img';
      img.alt = item.title;
      img.decoding = 'async';
      img.src = item.url;
      wrap.appendChild(img);
      if (meta) wrap.appendChild(h('p', 'insp-viewer-meta', meta));
    } else if (item.kind === 'audio') {
      wrap.appendChild(decorative(h('div', 'insp-glyph insp-glyph--big', '♪')));
      wrap.appendChild(h('p', 'insp-viewer-name', item.title));
      wrap.appendChild(makeAudio(item.url, 'insp-audio insp-audio--big'));
      if (meta) wrap.appendChild(h('p', 'insp-viewer-meta', meta));
    } else if (item.kind === '3d') {
      wrap.appendChild(decorative(cubeSvg('insp-cube insp-cube--big')));
      wrap.appendChild(h('p', 'insp-viewer-name', item.title));
      wrap.appendChild(h('p', 'insp-viewer-meta', meta || '3D model'));
      wrap.appendChild(downloadLink(item.url, item.title, 'Download model'));
    } else if (item.kind === 'document') {
      wrap.appendChild(documentTypeCard(item));
      link = document.createElement('a');
      link.className = 'insp-btn-link';
      link.href = item.libraryUrl;
      link.textContent = 'Open in Library';
      wrap.appendChild(link);
    } else {
      var badge = fileBadge(item.ext);
      wrap.appendChild(decorative(h('span', 'insp-badge insp-badge--big ' + badge.cls, badge.text)));
      wrap.appendChild(h('p', 'insp-viewer-name', item.title));
      if (meta) wrap.appendChild(h('p', 'insp-viewer-meta', meta));
      wrap.appendChild(downloadLink(item.url, item.title, 'Download file'));
    }
    return wrap;
  }

  function focusablesIn(node) {
    return Array.prototype.slice.call(node.querySelectorAll(FOCUSABLE));
  }

  function lockScroll(state) {
    if (state.scrollLocked) return;
    state.scrollLocked = true;
    state.savedOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
  }

  function unlockScroll(state) {
    if (!state.scrollLocked) return;
    state.scrollLocked = false;
    document.documentElement.style.overflow = state.savedOverflow;
  }

  function openViewer(state, item, returnEl) {
    if (state.destroyed) return;
    closeViewer(state, false);
    uid += 1;
    var titleId = 'insp-viewer-title-' + uid;

    var overlay = h('div', 'insp-overlay insp-theme');
    var dialog = h('div', 'insp-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.tabIndex = -1;

    var head = h('div', 'insp-dialog-head');
    var heading = h('h2', 'insp-dialog-title', item.title);
    heading.id = titleId;
    var minimiseBtn = makeButton('insp-dlg-btn insp-dlg-min', 'Minimise', '–');
    var closeBtn = makeButton('insp-dlg-btn insp-dlg-close', 'Close', '✕');
    head.appendChild(heading);
    head.appendChild(minimiseBtn);
    head.appendChild(closeBtn);

    var body = h('div', 'insp-dialog-body');
    body.appendChild(viewerContent(item));

    dialog.appendChild(head);
    dialog.appendChild(body);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    state.viewer = {
      item: item,
      overlay: overlay,
      dialog: dialog,
      mini: null,
      minimised: false,
      returnEl: returnEl || null
    };
    minimiseBtn.addEventListener('click', function () {
      minimiseViewer(state);
    });
    closeBtn.addEventListener('click', function () {
      closeViewer(state, true);
    });
    document.addEventListener('keydown', state.handlers.key, true);
    document.addEventListener('focusin', state.handlers.focusin, false);
    lockScroll(state);
    dialog.focus({ preventScroll: true });
  }

  function closeViewer(state, restoreFocus) {
    var v = state.viewer;
    if (!v) return;
    state.viewer = null;
    document.removeEventListener('keydown', state.handlers.key, true);
    document.removeEventListener('focusin', state.handlers.focusin, false);
    if (v.overlay.parentNode) v.overlay.parentNode.removeChild(v.overlay);
    if (v.mini && v.mini.parentNode) v.mini.parentNode.removeChild(v.mini);
    unlockScroll(state);
    if (restoreFocus && v.returnEl && document.documentElement.contains(v.returnEl) &&
        typeof v.returnEl.focus === 'function') {
      v.returnEl.focus({ preventScroll: true });
    }
  }

  function minimiseViewer(state) {
    var v = state.viewer;
    if (!v || v.minimised) return;
    v.minimised = true;
    v.overlay.hidden = true;
    unlockScroll(state);
    var mini = h('button', 'insp-mini insp-theme');
    mini.type = 'button';
    mini.title = 'Restore';
    mini.setAttribute('aria-label', 'Restore: ' + v.item.title);
    mini.appendChild(decorative(h('span', 'insp-mini-dot')));
    mini.appendChild(h('span', 'insp-mini-title', v.item.title));
    mini.addEventListener('click', function () {
      restoreViewer(state);
    });
    document.body.appendChild(mini);
    v.mini = mini;
    mini.focus({ preventScroll: true });
  }

  function restoreViewer(state) {
    var v = state.viewer;
    if (!v || !v.minimised) return;
    v.minimised = false;
    if (v.mini && v.mini.parentNode) v.mini.parentNode.removeChild(v.mini);
    v.mini = null;
    v.overlay.hidden = false;
    lockScroll(state);
    v.dialog.focus({ preventScroll: true });
  }

  // Escape closes. While the viewer is open, Tab stays inside it.
  function onDocumentKey(state, e) {
    var v = state.viewer;
    if (!v) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation();
      closeViewer(state, true);
      return;
    }
    if (e.key !== 'Tab' || v.minimised) return;
    var items = focusablesIn(v.dialog);
    if (items.length === 0) {
      e.preventDefault();
      v.dialog.focus({ preventScroll: true });
      return;
    }
    var first = items[0];
    var last = items[items.length - 1];
    var active = document.activeElement;
    var inside = v.dialog.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first || active === v.dialog) {
        e.preventDefault();
        last.focus({ preventScroll: true });
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  function onDocumentFocusIn(state, e) {
    var v = state.viewer;
    if (!v || v.minimised || v.dialog.contains(e.target)) return;
    var items = focusablesIn(v.dialog);
    var target = items[0] || v.dialog;
    target.focus({ preventScroll: true });
  }

  /* ---------- mount ---------- */

  function mount(el, opts) {
    if (!el || el.nodeType !== 1) {
      throw new TypeError('BeeZillaInspiration.mount needs a DOM element');
    }
    var options = opts || {};
    var root = h('div', 'insp-root insp-theme');
    var state = {
      root: root,
      onPrompt: typeof options.onPrompt === 'function' ? options.onPrompt : null,
      ideas: ideaItems(),
      items: [],
      index: {},
      loaded: false,
      loading: true,
      destroyed: false,
      seq: 0,
      ctrl: null,
      filter: null,
      filterSeq: 0,
      focusNext: null,
      sig: null,
      viewer: null,
      scrollLocked: false,
      savedOverflow: '',
      handlers: null
    };
    setItems(state, []);
    state.handlers = {
      key: function (e) {
        onDocumentKey(state, e);
      },
      focusin: function (e) {
        onDocumentFocusIn(state, e);
      }
    };
    root.addEventListener('click', function (e) {
      onRootClick(state, e);
    });
    root.addEventListener('keydown', function (e) {
      onRootKeydown(state, e);
    });
    root.addEventListener('dragstart', function (e) {
      onRootDragStart(state, e);
    });
    root.addEventListener('dragend', function () {
      onRootDragEnd(state);
    });
    el.appendChild(root);
    refresh(state);

    return {
      refresh: function () {
        return refresh(state);
      },
      destroy: function () {
        destroy(state);
      },
      filter: function (arg) {
        setFilterArg(state, arg);
      }
    };
  }

  global.BeeZillaInspiration = { mount: mount };
})(typeof window !== 'undefined' ? window : this);
