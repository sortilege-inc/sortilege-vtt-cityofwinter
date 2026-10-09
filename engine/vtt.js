// engine/vtt.js — the table: a map with a grid, tokens, effects, fog and pings, in
// its own window (vtt.html). System-agnostic: a token is { id, label, kind, owner,
// x, y, size, hidden, color }; what a token stands for (a party member, a cast
// member, a marker) is the system's business and arrives through the token itself.
// Map state lives per map in the shared state (State.state.maps): a map is one the
// system ships for a scene (a floor of a building, the grounds — a scene may have
// several) or, for a scene with none, the scene itself as a blank grid. Which map
// the table is showing is shared too (State.state.table.map), so the player view
// follows the GM's floor. Every change goes through ops, so the GM page, the table
// and the player view all agree.
//
// Two views of the same page:
//   vtt.html               GM view: toolbar, drag, right-click menu, fog at half
//                          opacity, hidden tokens dimmed
//   vtt.html?view=player   player view: no controls, fog opaque, hidden and fogged
//                          tokens not drawn; a player may drag their own tokens
// ?map=<id> pins a map (?scene=<id> its first map); without it the window follows
// the GM's table — the map they last showed, else their current scene's first map.
//
// Units: map state is in grid cells (floats allowed); the SVG user space is image
// pixels; grid.size is the cell in pixels, grid.ox/oy the offset of the first line —
// the calibration the GM dials in for a map not drawn on a known grid.
(function () {
  const { el } = window.VttRender;
  const State = window.VttState;
  const Bus = window.VttBus;
  const Sys = window.VttSystem;       // the system's table adapter (system/teeth/table.js)
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const params = new URLSearchParams(location.search);
  const PLAYER = params.get('view') === 'player';
  if (PLAYER) document.body.classList.add('player');

  const svg = document.getElementById('map');
  const stage = document.getElementById('vtt-stage');
  const toolbar = document.getElementById('vtt-toolbar');
  const hint = document.getElementById('vtt-hint');

  let follow = !(params.get('map') || params.get('scene'));
  let mapId = null;
  let sceneId = null;            // the scene the current map belongs to
  let map = null;
  let legendOpen = false;        // this window's, never shared
  let tool = 'select';           // select | ping | circle | line | square | reveal
  let selectedId = null;         // the token last clicked (the keys and the menu start from it)
  let selectedIds = new Set();   // every selected token: a marquee, or the one
  let selectedEffect = null;
  let spaceHeld = false;         // Space + drag pans while the select tool is up
  function select(ids, primary) {
    selectedIds = new Set(ids);
    selectedId = primary != null ? primary : (ids.length ? ids[ids.length - 1] : null);
  }
  function selectedTokens() {
    return map ? map.tokens.filter((t) => selectedIds.has(t.id)) : [];
  }
  let view = { x: 0, y: 0, w: 2400, h: 1600 };

  // The player's seat. The player's page holds the socket; this window (the table in its own tab,
  // or the frame the player's page embeds) reads the same session record from storage.
  function myMemberId() {
    if (window.VttSession) return window.VttSession.memberId();
    try {
      const info = JSON.parse(localStorage.getItem((window.VttConfig.storagePrefix || 'sortilege-vtt') + ':session') || 'null');
      return info && info.role === 'player' ? info.memberId || null : null;
    } catch (e) {
      return null;
    }
  }

  // the token that stands for the player at the table, as the system describes it (owner = the member)
  function myTokenDef() {
    const me = myMemberId();
    if (!me || !Sys.tokenSources) return null;
    let found = null;
    Sys.tokenSources(sceneId).forEach((g) => (g.items || []).forEach((t) => { if (!found && t.owner === me) found = t; }));
    return found;
  }

  function myToken() {
    const me = myMemberId();
    return me && map ? map.tokens.find((t) => t.owner === me) : null;
  }

  // a player puts their own token down in the middle of what they are looking at, then drags it
  function placeMyToken() {
    const def = myTokenDef();
    if (!def || myToken() || !(State.state.maps || {})[mapId]) return;
    const c = toCell(view.x + view.w / 2, view.y + view.h / 2);
    const token = Object.assign({ size: 1, hidden: false }, def, { id: def.id || State.genId('tk'), x: snap(c.x - 0.5), y: snap(c.y - 0.5) });
    State.commit('placeToken', [mapId, token]);
    loadMap();
    selectedId = token.id;
    renderTokens();
    buildToolbar();
    syncHint();
  }

  function canDrag(t) {
    if (!PLAYER) return true;
    const me = myMemberId();
    return !!me && t.owner === me;
  }

  // ── scenes ─────────────────────────────────────────────────────────
  const scenes = () => Sys.scenes();                    // [{ id, name, moduleId }] in play order

  function gmScene() {
    return Sys.currentSceneId();
  }

  function mapScene(id) {
    const d = Sys.mapDef(id);
    return d ? d.sceneId : id;             // a scene with no shipped map is its own blank map
  }

  function hasMap(id) {                    // does this scene have anything to show?
    if (Sys.defaultMapId(id) !== id) return true;
    const m = (State.state.maps || {})[id];
    return !!(m && m.image);
  }

  let followNote = '';
  function defaultFor(h) {
    if (!h) {
      followNote = '';
      const first = scenes()[0];
      return first ? Sys.defaultMapId(first.id) : null;
    }
    if (hasMap(h)) {
      followNote = '';
      return Sys.defaultMapId(h);
    }
    const mapped = scenes().find((s) => hasMap(s.id));
    if (!mapped) {
      followNote = '';
      return h;
    }
    const cur = scenes().find((s) => s.id === h);
    followNote = `${cur ? cur.name : 'The current scene'} has no map yet — showing ${mapped.name}.`;
    return Sys.defaultMapId(mapped.id);
  }

  // What a following window shows: the map the GM's table last showed, if it belongs
  // to the GM's current scene (players take it as it is); else that scene's first map.
  function followedMap() {
    const t = State.state.table || {};
    const h = gmScene();
    if (t.map && (PLAYER || !h || mapScene(t.map) === h)) {
      followNote = '';
      return t.map;
    }
    return defaultFor(h);
  }

  function scene() {
    return scenes().find((s) => s.id === sceneId) || null;
  }

  function mapName() {
    const sc = scene();
    const d = Sys.mapDef(mapId);
    return [sc && sc.name, d && d.name].filter(Boolean).join(' · ') || 'Table';
  }

  function blankMap() {
    return { image: null, w: 2400, h: 1600, grid: { size: 80, ox: 0, oy: 0, show: true, snap: true }, tokens: [], effects: [], fog: { enabled: false, revealed: [] } };
  }

  // The table works on its own copy of the map and commits copies back: the state's object
  // is never mutated in place, so an op's inverse (undo) sees the state as it was.
  function loadMap() {
    let m = (State.state.maps || {})[mapId];
    if (m) m = JSON.parse(JSON.stringify(m));
    if (!m) {
      m = blankMap();
      const d = Sys.mapDef(mapId);
      if (d) {
        m.image = d.image;
        m.w = d.w;
        m.h = d.h;
        Object.assign(m.grid, d.grid || {});
      }
      if (!PLAYER && mapId) State.commit('setMapState', [mapId, JSON.parse(JSON.stringify(m))]);
    }
    m.tokens = m.tokens || [];
    m.effects = m.effects || [];
    m.fog = m.fog || { enabled: false, revealed: [] };
    map = m;
  }

  function persist() {
    if (!PLAYER && mapId) State.commit('setMapState', [mapId, JSON.parse(JSON.stringify(map))]);
  }

  // ── geometry ───────────────────────────────────────────────────────
  // Square grid: a cell is `size` px on a side. Isometric grid (grid.iso): a cell is a diamond
  // `size` wide and `size × ratio` tall, cell x running down-right and cell y down-left, so
  // cell space stays a plain square lattice and tokens, fog and effects need no other change.
  const cell = () => map.grid.size;
  const iso = () => !!map.grid.iso;
  const ratio = () => map.grid.ratio || 0.5;
  const toPx = (cx, cy) => iso()
    ? { x: map.grid.ox + (cx - cy) * cell() / 2, y: map.grid.oy + (cx + cy) * cell() * ratio() / 2 }
    : { x: map.grid.ox + cx * cell(), y: map.grid.oy + cy * cell() };
  const toCell = (px, py) => {
    if (!iso()) return { x: (px - map.grid.ox) / cell(), y: (py - map.grid.oy) / cell() };
    const u = (px - map.grid.ox) / (cell() / 2);
    const v = (py - map.grid.oy) / (cell() * ratio() / 2);
    return { x: (u + v) / 2, y: (v - u) / 2 };
  };
  // a cell-space rectangle as a pixel polygon (a rectangle on a square grid, a rhombus on an isometric one)
  const cellPoly = (x, y, w, h) => [toPx(x, y), toPx(x + w, y), toPx(x + w, y + h), toPx(x, y + h)].map((p) => `${p.x},${p.y}`).join(' ');

  function svgPoint(clientX, clientY) {
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }

  function applyView() {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  }

  function fit() {
    view = { x: 0, y: 0, w: map.w, h: map.h };
    applyView();
  }

  function zoomAt(clientX, clientY, factor) {
    const p = svgPoint(clientX, clientY);
    view.w *= factor;
    view.h *= factor;
    view.x = p.x - (p.x - view.x) * factor;
    view.y = p.y - (p.y - view.y) * factor;
    applyView();
  }

  function isRevealed(t) {
    if (!map.fog.enabled) return true;
    const cx = t.x + t.size / 2;
    const cy = t.y + t.size / 2;
    return map.fog.revealed.some((r) => (r.r != null ? Math.hypot(cx - r.x, cy - r.y) <= r.r : cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h));
  }
  // a cell-space circle as a pixel polygon (an ellipse on an iso grid)
  const cellCircle = (x, y, r) => Array.from({ length: 28 }, (_, i) => { const a = (i / 28) * Math.PI * 2; const p = toPx(x + Math.cos(a) * r, y + Math.sin(a) * r); return `${p.x},${p.y}`; }).join(' ');

  // ── SVG ────────────────────────────────────────────────────────────
  function s(tag, attrs, children) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
    (children || []).forEach((c) => c && n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return n;
  }

  const layers = {};
  function buildLayers() {
    svg.innerHTML = '';
    const defs = s('defs');
    const pattern = s('pattern', { id: 'gridpat', patternUnits: 'userSpaceOnUse' });
    pattern.appendChild(s('path', { class: 'grid-line', fill: 'none' }));
    const mask = s('mask', { id: 'fogmask' });
    mask.appendChild(s('rect', { x: -1e5, y: -1e5, width: 2e5, height: 2e5, fill: 'white' }));
    layers.fogHoles = s('g');
    mask.appendChild(layers.fogHoles);
    defs.appendChild(pattern);
    defs.appendChild(mask);
    svg.appendChild(defs);
    layers.pattern = pattern;
    layers.image = s('image', { x: 0, y: 0 });
    layers.grid = s('rect', { x: 0, y: 0, fill: 'url(#gridpat)', class: 'grid-fill' });
    layers.effects = s('g', { class: 'effects' });
    layers.fog = s('rect', { x: 0, y: 0, class: 'fog', mask: 'url(#fogmask)' });
    layers.tokens = s('g', { class: 'tokens' });
    layers.pings = s('g', { class: 'pings' });
    layers.preview = s('g', { class: 'preview' });
    ['image', 'grid', 'effects', 'fog', 'tokens', 'preview', 'pings'].forEach((k) => svg.appendChild(layers[k]));
  }

  function renderBase() {
    if (map.image) layers.image.setAttribute('href', map.image);
    else layers.image.removeAttribute('href');
    layers.image.setAttribute('width', map.w);
    layers.image.setAttribute('height', map.h);
    ['grid', 'fog'].forEach((k) => {
      layers[k].setAttribute('width', map.w);
      layers[k].setAttribute('height', map.h);
    });
    const c = cell();
    if (iso()) {
      const h = c * ratio();
      layers.pattern.setAttribute('width', c);
      layers.pattern.setAttribute('height', h);
      layers.pattern.setAttribute('x', map.grid.ox - c / 2);
      layers.pattern.setAttribute('y', map.grid.oy);
      layers.pattern.firstChild.setAttribute('d', `M 0 ${h / 2} L ${c / 2} 0 L ${c} ${h / 2} M 0 ${h / 2} L ${c / 2} ${h} L ${c} ${h / 2}`);
    } else {
      layers.pattern.setAttribute('width', c);
      layers.pattern.setAttribute('height', c);
      layers.pattern.setAttribute('x', map.grid.ox);
      layers.pattern.setAttribute('y', map.grid.oy);
      layers.pattern.firstChild.setAttribute('d', `M ${c} 0 L 0 0 0 ${c}`);
    }
    layers.grid.style.display = map.grid.show === false ? 'none' : '';
    layers.fog.style.display = map.fog.enabled ? '' : 'none';
    layers.fogHoles.innerHTML = '';
    map.fog.revealed.forEach((r) => {
      layers.fogHoles.appendChild(s('polygon', { points: r.r != null ? cellCircle(r.x, r.y, r.r) : cellPoly(r.x, r.y, r.w, r.h), fill: 'black' }));
    });
    renderClocks();
  }

  function initials(name) {
    const parts = String(name || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/);
    const core = parts.filter((p) => !/^\d+$/.test(p) && !/^(the|of|de|le|la|von|van|miss|mr|mrs|sir|lady|lord|dr)$/i.test(p));
    const num = parts.find((p) => /^\d+$/.test(p));
    const ini = (core.length ? core : parts).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
    return num ? ini + num : ini;
  }

  function renderTokens() {
    layers.tokens.innerHTML = '';
    const c = cell();
    map.tokens.forEach((t) => {
      if (PLAYER && (t.hidden || !isRevealed(t))) return;
      // a token sits on the centre of its cell(s); on an iso grid it is sized to the diamond's height
      const d = t.size * (iso() ? c * ratio() : c);
      const ctr = toPx(t.x + t.size / 2, t.y + t.size / 2);
      const cx = ctr.x;
      const cy = ctr.y;
      const r = d / 2 - Math.max(2, c * 0.06);
      const color = t.color || Sys.tokenColor(t);
      const status = Sys.tokenStatus(t);           // { text, cls } or null — the system's word for the token's state
      const g = s('g', {
        class: 'token kind-' + (t.kind || 'marker') + (selectedIds.has(t.id) ? ' selected' : '') + (t.labelMode === 'hover' ? ' label-hover' : '') + (t.hidden ? ' hidden-token' : '') + (status && status.cls ? ' ' + status.cls : '') + (PLAYER && canDrag(t) ? ' mine' : ''),
        'data-id': t.id,
        transform: `translate(${cx},${cy})`,
      });
      g.appendChild(s('circle', { class: 'hit', r: r + Math.max(6, c * 0.12), fill: 'transparent', stroke: 'none' }));   // a grab a little wider than the ring
      g.appendChild(s('circle', { class: 'ring-outline', r: r + 3, fill: 'none', stroke: color, 'stroke-width': Math.max(2, c * 0.05) }));
      g.appendChild(s('circle', { class: 'body', r, stroke: color, 'stroke-width': 1.5 }));
      if (t.image) g.appendChild(s('image', { href: t.image, x: -r, y: -r, width: 2 * r, height: 2 * r, 'clip-path': 'circle(50%)' }));
      else g.appendChild(s('text', { class: 'ini', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': r * 0.9 }, [initials(t.label)]));
      // pips over the top of the ring: the system's (an injury level, red) and the token's harm clock
      // (one per segment, red when filled); a string pip is a filled one with that title
      const pips = (status && status.pips ? status.pips : []).map((p) => (typeof p === 'string' ? { title: p, on: true } : p));
      if (t.clock && t.clock.segments > 0) {
        // the players see the harm marked, not how much there is to take: filled pips only, no count
        const shown = PLAYER ? (t.clock.filled || 0) : t.clock.segments;
        for (let i = 0; i < shown; i++) pips.push({ title: PLAYER ? 'Harm' : `Harm ${t.clock.filled || 0} / ${t.clock.segments}`, on: i < (t.clock.filled || 0), clock: true });
        if ((t.clock.filled || 0) >= t.clock.segments) g.classList.add('down');
      }
      const n = Math.min(pips.length, 12);
      const spread = Math.min(Math.PI * 0.8, 0.42 * (n - 1));
      pips.slice(0, 12).forEach((pip, i) => {
        const a = -Math.PI / 2 + (n > 1 ? -spread / 2 + (i * spread) / (n - 1) : 0);
        g.appendChild(s('circle', { class: 'pip' + (pip.on ? '' : ' off') + (pip.clock ? ' clock' : ''), cx: Math.cos(a) * (r + 3), cy: Math.sin(a) * (r + 3), r: Math.max(3, c * 0.09) }, [s('title', {}, [pip.title || ''])]));
      });
      const label = status && status.text && (!PLAYER || t.kind === 'party') ? `${t.label} · ${status.text}` : t.label;
      g.appendChild(s('text', { class: 'label', 'text-anchor': 'middle', y: r + Math.max(12, c * 0.3), 'font-size': Math.max(11, c * 0.24) }, [label]));
      layers.tokens.appendChild(g);
    });
  }

  function effectShape(e, cls) {
    const c = cell();
    if (e.kind === 'circle') {
      const p = toPx(e.x, e.y);
      return s('circle', { class: cls, cx: p.x, cy: p.y, r: e.r * c });
    }
    if (e.kind === 'square') {
      return s('polygon', { class: cls, points: cellPoly(e.x, e.y, e.w, e.h) });
    }
    if (e.kind === 'line') {
      const a = toPx(e.x1, e.y1);
      const b = toPx(e.x2, e.y2);
      return s('line', { class: cls + ' line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'stroke-width': (e.w || 1) * c * 0.4 });
    }
    return null;
  }

  function renderEffects() {
    layers.effects.innerHTML = '';
    map.effects.forEach((e) => {
      const node = effectShape(e, 'effect' + (e.id === selectedEffect ? ' selected' : ''));
      if (!node) return;
      node.dataset.id = e.id;
      if (e.label) node.appendChild(s('title', {}, [e.label]));
      layers.effects.appendChild(node);
    });
  }

  function renderAll() {
    renderBase();
    renderEffects();
    renderTokens();
    syncHint();
  }

  function refresh() {
    const next = follow ? followedMap() : mapId;
    if (next && next !== mapId) {
      switchMap(next, true);
      return;
    }
    loadMap();
    renderAll();
    if (PLAYER) buildToolbar();            // Place my token comes and goes with the map's state
  }

  function switchMap(id, refit) {
    mapId = id;
    sceneId = mapScene(id);
    if (typeof closeMenu === 'function') closeMenu();     // a menu open over the last map does not follow
    select([]);
    selectedEffect = null;
    loadMap();
    renderAll();
    if (refit) fit();
    document.title = (window.VttConfig.title || 'Table') + ' — ' + mapName();
    preloadNext();
    // the players' map is shared state (table.map) and the GM sends them to it on purpose: the
    // GM may look ahead at another map while the players stay where they are
    if (!PLAYER && mapId && !(State.state.table || {}).map) State.commit('setTableMap', [mapId]);   // nothing shown yet: this is it
    buildToolbar();
    renderLegend();
  }

  // what the players see, as a name
  function playersMapName() {
    const t = (State.state.table || {}).map;
    if (!t) return null;
    const sc = scenes().find((x) => x.id === mapScene(t));
    const d = Sys.mapDef(t);
    return [sc && sc.name, d && d.name].filter(Boolean).join(' · ') || t;
  }

  // ── the legend (GM only; the map's key, verbatim from the corpus) ──
  let legendEl = null;
  function renderLegend() {
    if (legendEl) legendEl.remove();
    legendEl = null;
    if (PLAYER || !legendOpen) return;
    const lg = Sys.legend(mapId);
    if (!lg) return;
    legendEl = el('div', { class: 'vtt-legend' }, [
      el('h4', {}, [lg.heading]),
      el('div', { class: 'muted' }, [lg.title]),
      el('div', { class: 'lines' }, lg.lines.map((line) => el('div', {}, [line]))),
    ]);
    stage.appendChild(legendEl);
  }

  // ── pings ──────────────────────────────────────────────────────────
  function showPing(cx, cy) {
    const p = toPx(cx, cy);
    const c = cell();
    const ring = s('circle', { cx: p.x, cy: p.y, r: c * 0.2, class: 'ping' });
    ring.appendChild(s('animate', { attributeName: 'r', from: c * 0.2, to: c * 2.2, dur: '1.2s', repeatCount: 1, fill: 'freeze' }));
    ring.appendChild(s('animate', { attributeName: 'opacity', from: 1, to: 0, dur: '1.2s', repeatCount: 1, fill: 'freeze' }));
    layers.pings.appendChild(ring);
    setTimeout(() => ring.remove(), 1300);
  }

  // ── interaction ────────────────────────────────────────────────────
  let drag = null;

  function tokenAt(target) {
    const g = target.closest && target.closest('.token');
    return g ? map.tokens.find((t) => t.id === g.dataset.id) : null;
  }

  function snap(v) {
    return map.grid.snap === false ? v : Math.round(v);
  }

  let rightDrag = null;          // a right-button drag pans; a right click that did not move opens the menu
  let rightDragMoved = false;
  svg.addEventListener('pointerdown', (e) => {
    if (e.button === 2) {
      rightDrag = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* a synthetic pointer */ }
      return;
    }
    closeMenu();
    const p = svgPoint(e.clientX, e.clientY);
    const t = tokenAt(e.target);
    const panning = e.button === 1 || spaceHeld || tool === 'pan';
    if (t && tool === 'select' && canDrag(t) && !panning) {
      // a token in the selection drags the whole selection; any other becomes the selection
      if (!selectedIds.has(t.id)) select([t.id]);
      selectedId = t.id;
      selectedEffect = null;
      const group = (PLAYER ? [t] : selectedTokens()).map((tk) => ({ token: tk, x0: tk.x, y0: tk.y }));
      drag = { kind: 'token', token: t, group, offX: p.x - toPx(t.x, t.y).x, offY: p.y - toPx(t.x, t.y).y, moved: false, at: { x: e.clientX, y: e.clientY } };
      svg.setPointerCapture(e.pointerId);
      renderTokens();
      return;
    }
    if (t && !PLAYER && !panning) {
      select([t.id]);
      renderTokens();
      buildToolbar();
    }
    const onEffect = e.target.closest && e.target.closest('.effect');
    const shapeTool = tool === 'circle' || tool === 'line' || tool === 'square';
    if (!PLAYER && tool !== 'select' && !(shapeTool && onEffect)) {     // with a shape tool, a click on an existing shape selects it instead of drawing
      drag = { kind: 'tool', start: toCell(p.x, p.y), cur: toCell(p.x, p.y) };
      if (tool === 'brush') brushAt(drag.cur);
      svg.setPointerCapture(e.pointerId);
      return;
    }
    if (PLAYER && tool === 'ping') {
      const c0 = toCell(p.x, p.y);
      Bus.emit('ping', { mapId, x: c0.x, y: c0.y });
      return;
    }
    const fx = e.target.closest && e.target.closest('.effect');
    if (fx && !PLAYER) {
      selectedEffect = fx.dataset.id;
      selectedId = null;
      renderEffects();
      renderTokens();
      buildToolbar();
      syncHint();
      return;                                   // a click on an effect selects it; it does not start a pan
    }
    if (!PLAYER && selectedEffect) {           // a click elsewhere clears the selection
      selectedEffect = null;
      renderEffects();
      buildToolbar();
      syncHint();
    }
    if (!PLAYER && tool === 'select' && !panning) {
      // drag a box on the map: every token whose centre it holds is selected (a bare click selects nothing)
      drag = { kind: 'marquee', start: p, cur: p, add: e.shiftKey };
      svg.setPointerCapture(e.pointerId);
      return;
    }
    if (PLAYER && !panning && e.pointerType !== 'touch') return;   // a player's left drag moves their token or nothing: the map pans by right drag, arrows, a finger
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('panning');
  });

  svg.addEventListener('pointermove', (e) => {
    if (rightDrag) {
      if (!rightDrag.moved && Math.hypot(e.clientX - rightDrag.sx, e.clientY - rightDrag.sy) < 4) return;
      rightDrag.moved = true;
      closeMenu();
      const scale = view.w / svg.clientWidth;
      view.x = rightDrag.vx - (e.clientX - rightDrag.sx) * scale;
      view.y = rightDrag.vy - (e.clientY - rightDrag.sy) * scale;
      applyView();
      return;
    }
    if (!drag) return;
    if (drag.kind === 'pan') {
      const scale = view.w / svg.clientWidth;
      view.x = drag.vx - (e.clientX - drag.sx) * scale;
      view.y = drag.vy - (e.clientY - drag.sy) * scale;
      applyView();
      return;
    }
    const p = svgPoint(e.clientX, e.clientY);
    if (drag.kind === 'token') {
      if (!drag.moved && Math.hypot(e.clientX - drag.at.x, e.clientY - drag.at.y) < 4) return;   // a click, until the pointer has gone somewhere
      const cpos = toCell(p.x - drag.offX, p.y - drag.offY);
      const lead = drag.group.find((g) => g.token === drag.token);
      const dx = cpos.x - lead.x0;
      const dy = cpos.y - lead.y0;
      drag.moved = true;
      drag.group.forEach((gm) => {
        gm.token.x = gm.x0 + dx;
        gm.token.y = gm.y0 + dy;
        const g = layers.tokens.querySelector(`[data-id="${gm.token.id}"]`);
        if (g) {
          const ctr = toPx(gm.token.x + gm.token.size / 2, gm.token.y + gm.token.size / 2);
          g.setAttribute('transform', `translate(${ctr.x},${ctr.y})`);
        }
      });
      return;
    }
    if (drag.kind === 'marquee') {
      drag.cur = p;
      layers.preview.innerHTML = '';
      const r = normRect(drag.start, drag.cur);
      layers.preview.appendChild(s('rect', { class: 'marquee', x: r.x, y: r.y, width: r.w, height: r.h }));
      return;
    }
    if (drag.kind === 'tool') {
      drag.cur = toCell(p.x, p.y);
      layers.preview.innerHTML = '';
      if (tool === 'brush') {
        brushAt(drag.cur);
        return;
      }
      if (tool === 'ruler') {
        const a = toPx(drag.start.x, drag.start.y);
        const b = toPx(drag.cur.x, drag.cur.y);
        const cells = Math.hypot(drag.cur.x - drag.start.x, drag.cur.y - drag.start.y);
        layers.preview.appendChild(s('line', { class: 'ruler', x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
        layers.preview.appendChild(s('text', { class: 'ruler-label', x: b.x + 8, y: b.y - 8 }, [`${cells.toFixed(1)} cells`]));
        return;
      }
      const e2 = toolEffect(drag);
      if (e2) {
        const node = effectShape(e2, 'effect preview');
        if (node) layers.preview.appendChild(node);
      }
    }
  });

  svg.addEventListener('pointerup', (e) => {
    if (rightDrag && e.button === 2) {
      rightDragMoved = rightDrag.moved;
      rightDrag = null;
      return;
    }
    if (!drag) return;
    svg.classList.remove('panning');
    if (drag.kind === 'token') {
      if (drag.moved) {
        drag.group.forEach((gm) => {
          gm.token.x = snap(gm.token.x);
          gm.token.y = snap(gm.token.y);
        });
        if (drag.group.length === 1) State.commit('setTokenPosition', [mapId, drag.token.id, drag.token.x, drag.token.y]);   // the op a player may send
        else persist();                                                                                                      // the group as one change, one undo
      } else if (!PLAYER) {
        openTokenMenu(drag.token, drag.at.x, drag.at.y);     // a click: the token's options (a party token's open its sheet from there)
      } else {
        Sys.selectToken(drag.token);
      }
      renderTokens();
    } else if (drag.kind === 'marquee') {
      layers.preview.innerHTML = '';
      const r = normRect(drag.start, drag.cur);
      if (r.w > 4 || r.h > 4) {
        const inside = map.tokens.filter((t) => {
          const c = toPx(t.x + t.size / 2, t.y + t.size / 2);
          return c.x >= r.x && c.x <= r.x + r.w && c.y >= r.y && c.y <= r.y + r.h;
        }).map((t) => t.id);
        select(drag.add ? Array.from(selectedIds).concat(inside) : inside);
      } else {
        select([]);
      }
      renderTokens();
      buildToolbar();
      syncHint();
    } else if (drag.kind === 'tool') {
      layers.preview.innerHTML = '';
      const moved = Math.hypot(drag.cur.x - drag.start.x, drag.cur.y - drag.start.y) > 0.15;
      if (tool === 'ping') {
        Bus.emit('ping', { mapId, x: drag.start.x, y: drag.start.y });
      } else if (tool === 'reveal') {
        if (moved) {
          map.fog.revealed.push(normRect(drag.start, drag.cur));
          persist();
          renderBase();
        }
      } else if (tool === 'brush') {
        persist();              // the circles were painted as the pointer moved
      } else if (tool === 'ruler') {
        /* a measure leaves nothing behind */
      } else if (moved) {
        const fx = toolEffect(drag);
        if (fx) {
          fx.id = State.genId('fx');
          map.effects.push(fx);
          persist();
          renderEffects();
          buildToolbar();
          syncHint();
        }
      }
    }
    drag = null;
  });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });

  function normRect(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }

  function toolEffect(d) {
    const a = d.start;
    const b = d.cur;
    if (tool === 'circle') return { kind: 'circle', x: a.x, y: a.y, r: Math.hypot(b.x - a.x, b.y - a.y) };
    if (tool === 'square') return Object.assign({ kind: 'square' }, normRect(a, b));
    if (tool === 'line') return { kind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, w: 1 };
    return null;
  }

  window.addEventListener('keydown', (e) => {
    if (/^Arrow(Up|Down|Left|Right)$/.test(e.key) && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLSelectElement)) {
      e.preventDefault();
      const step = (e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? view.w : view.h) * (e.shiftKey ? 0.5 : 0.1);
      if (e.key === 'ArrowLeft') view.x -= step;
      if (e.key === 'ArrowRight') view.x += step;
      if (e.key === 'ArrowUp') view.y -= step;
      if (e.key === 'ArrowDown') view.y += step;
      applyView();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      if (e.shiftKey) State.redo(); else State.undo();
      refresh();
      buildToolbar();
      return;
    }
    if (PLAYER) return;
    if (e.key === 'Escape') {
      tool = 'select';
      closeMenu();
      selectedEffect = null;
      select([]);
      renderTokens();
      svg.classList.remove('tool-active');
      renderEffects();
      buildToolbar();
    }
    if (e.key === ' ' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
      spaceHeld = true;
      svg.classList.add('panning');
      e.preventDefault();
    }
    const sel = selectedTokens();      // the keys act on every selected token
    if (sel.length && !(e.target instanceof HTMLInputElement)) {
      const sizes = { 1: 0.5, 2: 1, 3: 2, 4: 3 };
      if (sizes[e.key]) {
        sel.forEach((t) => (t.size = sizes[e.key]));
        persist();
        renderTokens();
        return;
      }
      if (e.key.toLowerCase() === 'h' && !e.ctrlKey && !e.metaKey) {
        const hide = sel.some((t) => !t.hidden);
        sel.forEach((t) => (t.hidden = hide));
        persist();
        renderTokens();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        copySelected();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const copies = sel.map((t) => Object.assign({}, JSON.parse(JSON.stringify(t)), { id: State.genId('tk'), x: t.x + 1, y: t.y }));
        copies.forEach((c) => map.tokens.push(c));
        select(copies.map((c) => c.id));
        persist();
        renderTokens();
        return;
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      pasteTokens();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !(e.target instanceof HTMLInputElement)) {
      if (selectedEffect) {
        removeEffect(selectedEffect);
      } else if (sel.length) {
        removeTokens(sel.map((t) => t.id));
      }
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      spaceHeld = false;
      if (!drag) svg.classList.remove('panning');
    }
  });

  // the fog brush: a circle of reveal under the pointer, one per cell moved
  let brushRadius = 2;
  let lastBrush = null;
  function brushAt(c) {
    const at = { x: Math.round(c.x * 2) / 2, y: Math.round(c.y * 2) / 2 };
    if (lastBrush && Math.hypot(at.x - lastBrush.x, at.y - lastBrush.y) < 0.5) return;
    lastBrush = at;
    map.fog.revealed.push({ x: at.x, y: at.y, r: brushRadius });
    renderBase();
  }

  // clocks over the map: every clock for the GM, the visible ones for players; the GM ticks them here
  let clocksShown = true;
  let clocksEl = null;
  function renderClocks() {
    if (clocksEl) clocksEl.remove();
    clocksEl = null;
    if (!clocksShown) return;
    const all = (State.state.clocks || []).filter((c) => !PLAYER || c.visible !== false);
    if (!all.length) return;
    clocksEl = el('div', { class: 'vtt-clocks' }, all.map((c) => {
      const row = el('div', { class: 'boxes clock' });
      for (let i = 1; i <= c.segments; i++) {
        const b = el('button', { class: 'box' + (i <= c.filled ? ' on' : ''), type: 'button', disabled: PLAYER || null, onclick: () => { if (!PLAYER) State.commit('setClock', [Object.assign({}, c, { filled: i <= c.filled && i === c.filled ? i - 1 : i })]); renderClocks(); } });
        row.appendChild(b);
      }
      return el('div', { class: 'clock-row' }, [el('div', { class: 'track-head' }, [el('span', { class: 'track-name' }, [c.name, c.visible === false ? el('span', { class: 'muted' }, [' · GM']) : null]), el('span', { class: 'muted' }, [`${c.filled} / ${c.segments}`])]), row]);
    }));
    stage.appendChild(clocksEl);
  }

  // the next scene's map, fetched now so the switch is instant
  function preloadNext() {
    const list = scenes();
    const i = list.findIndex((sc) => sc.id === sceneId);
    const next = list[i + 1];
    if (!next) return;
    const d = Sys.mapDef(Sys.defaultMapId(next.id));
    if (d && d.image) {
      const img = new Image();
      img.src = d.image;
      preloaded = d.image;
    }
  }
  let preloaded = null;

  // copy the selected tokens; paste them on whatever map is showing, keeping their spacing, around the
  // centre of the view, with new ids (Ctrl+C / Ctrl+V, or the toolbar)
  let clipboard = [];
  function copySelected() {
    const sel = selectedTokens();
    if (!sel.length) return;
    clipboard = sel.map((t) => JSON.parse(JSON.stringify(t)));
    buildToolbar();
    syncHint();
  }
  function pasteTokens() {
    if (!clipboard.length) return;
    const xs = clipboard.map((t) => t.x);
    const ys = clipboard.map((t) => t.y);
    const cx = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
    const cy = (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2;
    const at = toCell(view.x + view.w / 2, view.y + view.h / 2);
    const made = clipboard.map((t) => Object.assign({}, JSON.parse(JSON.stringify(t)), { id: State.genId('tk'), x: snap(t.x - cx + at.x), y: snap(t.y - cy + at.y) }));
    made.forEach((t) => map.tokens.push(t));
    select(made.map((t) => t.id));
    persist();
    renderTokens();
    buildToolbar();
    syncHint();
  }
  function removeTokens(ids) {
    const gone = new Set(ids);
    map.tokens = map.tokens.filter((x) => !gone.has(x.id));
    select(Array.from(selectedIds).filter((x) => !gone.has(x)));
    persist();
    renderTokens();
    syncHint();
  }
  function removeToken(id) {
    map.tokens = map.tokens.filter((t) => t.id !== id);
    if (selectedId === id) selectedId = null;
    selectedIds.delete(id);
    persist();
    renderTokens();
  }

  // ── right-click menu (GM) ──────────────────────────────────────────
  let menu = null;
  function closeMenu() {
    if (menu) menu.remove();
    menu = null;
  }

  svg.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (rightDragMoved || (rightDrag && rightDrag.moved)) {     // the right button was dragging the map, not asking for a menu
      rightDragMoved = false;
      return;
    }
    if (PLAYER) return;
    closeMenu();
    const t = tokenAt(e.target);
    const fx = e.target.closest && e.target.closest('.effect');
    if (fx) {
      const effect = map.effects.find((x) => x.id === fx.dataset.id);
      if (!effect) return;
      selectedEffect = effect.id;
      selectedId = null;
      renderEffects();
      renderTokens();
      buildToolbar();
      menu = buildEffectMenu(effect);
      const rect = stage.getBoundingClientRect();
      menu.style.left = Math.min(e.clientX - rect.left, rect.width - 260) + 'px';
      menu.style.top = Math.min(e.clientY - rect.top, rect.height - 160) + 'px';
      stage.appendChild(menu);
      return;
    }
    if (!t) return;
    openTokenMenu(t, e.clientX, e.clientY);
  });

  // the token's options, under the pointer; when the token is one of a selection, the options take the selection
  function openTokenMenu(t, clientX, clientY) {
    closeMenu();
    if (!selectedIds.has(t.id)) select([t.id]);
    selectedId = t.id;
    renderTokens();
    menu = buildMenu(t);
    const rect = stage.getBoundingClientRect();
    menu.style.left = Math.max(0, Math.min(clientX - rect.left, rect.width - 300)) + 'px';
    menu.style.top = Math.max(0, Math.min(clientY - rect.top, rect.height - 340)) + 'px';
    stage.appendChild(menu);
  }

  document.addEventListener('pointerdown', (e) => {
    if (menu && !menu.contains(e.target)) closeMenu();
  });

  function removeEffect(id) {
    map.effects = map.effects.filter((x) => x.id !== id);
    if (selectedEffect === id) selectedEffect = null;
    persist();
    renderEffects();
    buildToolbar();
    syncHint();
  }

  function buildEffectMenu(fx) {
    const kind = fx.kind === 'circle' ? 'Circle' : fx.kind === 'line' ? 'Line' : 'Square';
    const label = el('button', { class: 'btn ghost', onclick: () => { const n = prompt('Label (shown on hover)', fx.label || ''); if (n != null) { fx.label = n; persist(); renderEffects(); } closeMenu(); } }, [fx.label ? 'Relabel' : 'Label']);
    const remove = el('button', { class: 'btn danger', onclick: () => { removeEffect(fx.id); closeMenu(); } }, ['Remove ' + kind.toLowerCase()]);
    return el('div', { class: 'vtt-menu' }, [el('h4', {}, [fx.label || kind]), el('div', { class: 'row' }, [label, remove])]);
  }

  function buildMenu(t) {
    // the tokens the options act on: the selection when the token is in it
    const targets = selectedIds.has(t.id) && selectedIds.size > 1 ? selectedTokens() : [t];
    const refreshMenu = () => { const fresh = buildMenu(t); fresh.style.left = menu.style.left; fresh.style.top = menu.style.top; menu.replaceWith(fresh); menu = fresh; };
    const apply = (fn) => { targets.forEach(fn); persist(); renderTokens(); refreshMenu(); };
    const openSheet = targets.length === 1 && (t.kind === 'party' || (t.kind === 'cast' && t.ref)) ? el('button', { class: 'btn', onclick: () => { Sys.selectToken(t); closeMenu(); } }, [t.kind === 'party' ? 'Open sheet' : 'Open entry']) : null;
    const title = targets.length > 1 ? `${targets.length} tokens` : t.label;
    // a harm clock on an NPC: so many segments, filled one at a time, like an injury track
    let clockRow = null;
    if (t.kind !== 'party') {
      const ck = t.clock || { segments: 0, filled: 0 };
      const seg = el('input', { type: 'number', class: 'vtt-num', min: '0', max: '12', step: '1', value: String(ck.segments || 0), title: 'Segments (0 for none)' });
      seg.addEventListener('change', () => { const n = Math.max(0, Math.min(12, parseInt(seg.value, 10) || 0)); apply((x) => { x.clock = n ? { segments: n, filled: Math.min(n, (x.clock && x.clock.filled) || 0) } : null; }); });
      const minus = el('button', { class: 'btn ghost tiny', onclick: () => apply((x) => { if (x.clock) x.clock.filled = Math.max(0, (x.clock.filled || 0) - 1); }) }, ['−']);
      const plus = el('button', { class: 'btn ghost tiny', onclick: () => apply((x) => { if (x.clock) x.clock.filled = Math.min(x.clock.segments, (x.clock.filled || 0) + 1); }) }, ['+']);
      minus.disabled = !ck.segments || !ck.filled;
      plus.disabled = !ck.segments || ck.filled >= ck.segments;
      clockRow = el('div', { class: 'row' }, [el('span', { class: 'muted' }, ['Harm']), seg, el('span', { class: 'muted' }, ['segments']), ck.segments ? el('b', {}, [`${ck.filled || 0} / ${ck.segments}`]) : null, minus, plus, ck.segments && ck.filled >= ck.segments ? el('span', { class: 'muted' }, ['full — down']) : null]);
    }
    const palette = Sys.tokenPalette ? Sys.tokenPalette() : [];
    const current = t.color || Sys.tokenColor(t);
    const swatches = palette.map((c) => el('button', { class: 'swatch' + (c.color.toLowerCase() === current.toLowerCase() ? ' on' : ''), title: c.name, style: 'background:' + c.color, onclick: () => apply((x) => (x.color = c.color)) }));
    const custom = el('input', { type: 'color', class: 'swatch custom', title: 'Any colour', value: /^#[0-9a-f]{6}$/i.test(current) ? current : '#8f1d22' });
    custom.addEventListener('input', () => apply((x) => (x.color = custom.value)));
    const ringRow = el('div', { class: 'row' }, [el('span', { class: 'muted' }, ['Ring']), ...swatches, custom]);
    const icons = Sys.tokenIcons ? Sys.tokenIcons() : [];
    const iconGrid = icons.length ? el('div', { class: 'icon-grid' }, icons.map((ic) => el('button', { class: 'icon' + (t.image === ic.image ? ' on' : ''), title: ic.label, onclick: () => apply((x) => (x.image = ic.image)) }, [el('img', { src: ic.image, alt: ic.label })]))) : null;
    const iconRow = iconGrid ? el('div', { class: 'row' }, [el('span', { class: 'muted' }, ['Face']), iconGrid]) : null;
    const labelRow = el('div', { class: 'row' }, [
      el('span', { class: 'muted' }, ['Name']),
      el('button', { class: 'btn ghost tiny' + (t.labelMode !== 'hover' ? ' active' : ''), onclick: () => apply((x) => (x.labelMode = 'below')) }, ['Below']),
      el('button', { class: 'btn ghost tiny' + (t.labelMode === 'hover' ? ' active' : ''), onclick: () => apply((x) => (x.labelMode = 'hover')) }, ['On hover']),
    ]);
    const sizeIn = el('input', { type: 'number', class: 'vtt-num', min: '0.5', max: '12', step: '0.5', value: String(t.size || 1), title: 'Squares on a side' });
    sizeIn.addEventListener('change', () => { const n = parseFloat(sizeIn.value); if (n >= 0.5) apply((x) => (x.size = n)); });
    const sizeRow = el('div', { class: 'row' }, [el('span', { class: 'muted' }, ['Size']), sizeIn, el('span', { class: 'muted' }, ['squares on a side'])]);
    const hide = el('button', { class: 'btn ghost', onclick: () => { const h = targets.some((x) => !x.hidden); targets.forEach((x) => (x.hidden = h)); persist(); renderTokens(); closeMenu(); } }, [targets.some((x) => !x.hidden) ? 'Hide from players' : 'Reveal to players']);
    const rename = targets.length === 1 ? el('button', { class: 'btn ghost', onclick: () => { const n = prompt('Label', t.label); if (n) { t.label = n; persist(); renderTokens(); } closeMenu(); } }, ['Rename']) : null;
    const remove = el('button', { class: 'btn danger', onclick: () => { removeTokens(targets.map((x) => x.id)); closeMenu(); } }, [targets.length > 1 ? `Remove ${targets.length} tokens` : 'Remove token']);
    const body = el('div', { class: 'vtt-menu token-menu' }, [el('h4', {}, [title]), ringRow, iconRow, labelRow, sizeRow, clockRow, el('div', { class: 'row' }, [openSheet, hide, rename, remove])]);
    const extra = Sys.tokenMenu(t, () => { renderTokens(); refreshMenu(); });   // the system's rows keep the menu open and fresh
    if (extra) body.appendChild(extra);
    return body;
  }

  // ── toolbar (GM) ───────────────────────────────────────────────────
  function toolButton(id, label, title) {
    const b = el('button', { class: 'btn ghost' + (tool === id ? ' active' : ''), title: title || '' }, [label]);
    b.addEventListener('click', () => {
      tool = tool === id ? 'select' : id;
      selectedEffect = null;
      svg.classList.toggle('tool-active', tool !== 'select');
      buildToolbar();
      renderEffects();
    });
    return b;
  }

  function numField(label, get, set, step) {
    const inp = el('input', { type: 'number', class: 'vtt-num', step: step || 1, value: String(get()) });
    inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      if (!isNaN(v)) set(v);
      persist();
      renderAll();
    });
    return el('label', {}, [label, inp]);
  }

  function check(label, get, set) {
    const inp = el('input', { type: 'checkbox', checked: get() || null });
    inp.addEventListener('change', () => {
      set(inp.checked);
      persist();
      renderAll();
      if (label === 'iso') buildToolbar();
    });
    return el('label', {}, [inp, label]);
  }

  function addTokenAt(t) {
    // stage new tokens in a row across the top-centre of the map (in pixels, so it holds on an
    // iso grid too), snapped to cells, so the GM can drag them out
    const taken = map.tokens.length;
    const rowH = cell() * (iso() ? ratio() : 1);
    const at = toCell(map.w / 2 + ((taken % 10) - 4.5) * cell(), rowH * (1 + Math.floor(taken / 10) * 1.2));   // a cell apart, so each snaps to its own
    map.tokens.push(Object.assign({ x: snap(at.x - 0.5), y: snap(at.y - 0.5), size: 1, hidden: false }, t, { id: t.id || State.genId('tk') }));
    persist();
    renderTokens();
    syncHint();
  }

  function buildToolbar() {
    toolbar.innerHTML = '';
    if (PLAYER) {
      const clocksBtn = el('button', { class: 'btn ghost' + (clocksShown ? ' active' : ''), onclick: () => { clocksShown = !clocksShown; renderClocks(); buildToolbar(); } }, ['Clocks']);
      const def = myTokenDef();
      const placeBtn = def && !myToken() ? el('button', { class: 'btn', onclick: placeMyToken, disabled: (State.state.maps || {})[mapId] ? null : true, title: (State.state.maps || {})[mapId] ? 'Put your token on this map' : 'The GM has not opened this map yet' }, ['Place my token']) : null;
      toolbar.appendChild(el('div', { class: 'group' }, [el('b', {}, [mapName()]), el('button', { class: 'btn ghost', onclick: fit }, ['Fit']), toolButton('ping', 'Ping'), clocksBtn, placeBtn]));
      return;
    }
    // one entry per map, in scene order: a scene's floors, or the scene itself when it has no map
    const mapSel = el('select', { class: 'vtt-select' });
    const shipped = Sys.maps();
    scenes().forEach((sc) => {
      const ms = shipped.filter((m) => m.sceneId === sc.id);          // listed once, under the first scene it serves
      if (!ms.length) mapSel.appendChild(el('option', { value: sc.id, selected: sc.id === mapId || null }, [sc.name]));
      ms.forEach((m) => mapSel.appendChild(el('option', { value: m.id, selected: m.id === mapId || null }, [`${sc.name} · ${m.name}`])));
    });
    const followBox = el('input', { type: 'checkbox', checked: follow || null });
    mapSel.addEventListener('change', () => {
      if (follow && mapScene(mapSel.value) !== mapScene(followedMap())) {   // another scene's map: pinned from here
        follow = false;
        followBox.checked = false;
      }
      switchMap(mapSel.value, true);
    });
    followBox.addEventListener('change', () => {
      follow = followBox.checked;
      if (follow) switchMap(followedMap(), true);
    });
    toolbar.appendChild(el('div', { class: 'group' }, [mapSel, el('label', {}, [followBox, 'follow GM'])]));

    const img = el('input', { type: 'text', class: 'vtt-url', placeholder: 'map image (assets/maps/…)', value: map.image || '' });
    const setImg = el('button', { class: 'btn ghost' }, ['Set map']);
    setImg.addEventListener('click', () => {
      const url = img.value.trim();
      if (!url) {
        map.image = null;
        persist();
        renderAll();
        return;
      }
      const probe = new Image();
      probe.onload = () => {
        map.image = url;
        map.w = probe.naturalWidth;
        map.h = probe.naturalHeight;
        persist();
        renderAll();
        fit();
      };
      probe.onerror = () => alert('Could not load that image.');
      probe.src = url;
    });
    const pickMap = el('select', { class: 'vtt-select' }, [el('option', { value: '' }, ['maps in the repo…'])]);
    Sys.mapAssets().forEach((a) => pickMap.appendChild(el('option', { value: a.image }, [a.label])));
    pickMap.addEventListener('change', () => {
      if (!pickMap.value) return;
      img.value = pickMap.value;
      setImg.click();
      pickMap.value = '';
    });
    // the library (engine/library.js): uploaded images, when this deployment has one and this
    // browser holds the key
    const Lib = window.VttLibrary;
    const libGroup = [];
    if (Lib && Lib.enabled() && !PLAYER) {
      const pickLib = el('select', { class: 'vtt-select' }, [el('option', { value: '' }, [Lib.ready() ? 'the library…' : 'the library (key in Settings)'])]);
      pickLib.disabled = !Lib.ready();
      if (Lib.ready()) (Lib.maps || Lib.list)().then((rows) => rows.forEach((r) => pickLib.appendChild(el('option', { value: r.url }, [r.name])))).catch((e) => { pickLib.appendChild(el('option', { value: '' }, [e.message])); });
      pickLib.addEventListener('change', () => {
        if (!pickLib.value) return;
        img.value = pickLib.value;
        setImg.click();
        pickLib.value = '';
      });
      const file = el('input', { type: 'file', accept: 'image/*', hidden: true });
      const up = el('button', { class: 'btn ghost', title: 'Upload an image to the library and put it on the table' }, ['Upload…']);
      up.disabled = !Lib.ready();
      up.addEventListener('click', () => file.click());
      file.addEventListener('change', () => {
        const f = file.files && file.files[0];
        if (!f) return;
        up.disabled = true;
        up.textContent = 'Uploading…';
        Lib.upload(f).then((r) => {
          pickLib.insertBefore(el('option', { value: r.url }, [r.name]), pickLib.options[1] || null);
          img.value = r.url;
          setImg.click();
        }).catch((e) => alert(e.message)).finally(() => { up.disabled = false; up.textContent = 'Upload…'; file.value = ''; });
      });
      libGroup.push(pickLib, up, file);
    }
    toolbar.appendChild(el('div', { class: 'group' }, [pickMap].concat(libGroup, [img, setImg])));

    toolbar.appendChild(el('div', { class: 'group' }, [
      el('span', { class: 'muted' }, ['Grid']),
      check('show', () => map.grid.show !== false, (v) => { map.grid.show = v; }),
      check('snap', () => map.grid.snap !== false, (v) => { map.grid.snap = v; }),
      numField('cell px', () => map.grid.size, (v) => { map.grid.size = Math.max(8, v); }),
      check('iso', () => !!map.grid.iso, (v) => { map.grid.iso = v; if (v && !map.grid.ratio) map.grid.ratio = 0.5; }),
      map.grid.iso ? numField('ratio', () => map.grid.ratio || 0.5, (v) => { map.grid.ratio = Math.min(1, Math.max(0.2, v)); }, 0.01) : null,
      numField('x', () => map.grid.ox, (v) => { map.grid.ox = v; }),
      numField('y', () => map.grid.oy, (v) => { map.grid.oy = v; }),
    ]));

    // tokens: the system lists what can stand on the table
    const addSel = el('select', { class: 'vtt-select' }, [el('option', { value: '' }, ['add token…'])]);
    Sys.tokenSources(sceneId).forEach((group) => {
      addSel.appendChild(el('option', { disabled: true }, ['— ' + group.label]));
      group.items.forEach((it) => addSel.appendChild(el('option', { value: JSON.stringify(it) }, [it.label])));
    });
    addSel.appendChild(el('option', { disabled: true }, ['— other']));
    addSel.appendChild(el('option', { value: '__marker' }, ['a marker (name it)']));
    addSel.addEventListener('change', () => {
      if (!addSel.value) return;
      if (addSel.value === '__marker') {
        const n = prompt('Marker label');
        if (n) addTokenAt({ label: n, kind: 'marker' });
      } else {
        const it = JSON.parse(addSel.value);
        if (it.named) {
          const n = prompt('Who is this?');
          if (!n) { addSel.value = ''; return; }
          it.label = n;
          delete it.named;
        }
        addTokenAt(it);
      }
      addSel.value = '';
    });
    toolbar.appendChild(el('div', { class: 'group' }, [addSel]));

    const copyBtn = el('button', { class: 'btn ghost', title: 'Copy the selected tokens (Ctrl+C); switch maps and Paste', onclick: copySelected }, [selectedIds.size > 1 ? `Copy ${selectedIds.size}` : 'Copy']);
    copyBtn.disabled = !selectedIds.size;
    const pasteBtn = el('button', { class: 'btn ghost', title: 'Paste the copied tokens here, around the centre of the view (Ctrl+V)', onclick: pasteTokens }, [clipboard.length ? `Paste ${clipboard.length}` : 'Paste']);
    pasteBtn.disabled = !clipboard.length;
    const selectedFx = selectedEffect ? map.effects.find((x) => x.id === selectedEffect) : null;
    const removeFx = selectedFx ? el('button', { class: 'btn danger', title: 'Remove the selected shape (Delete does the same)', onclick: () => removeEffect(selectedFx.id) }, ['Remove ' + selectedFx.kind]) : null;
    const clearFx = map.effects.length ? el('button', { class: 'btn ghost', title: 'Remove every circle, line and square on this map', onclick: () => { if (confirm(`Remove all ${map.effects.length} shapes on this map?`)) { map.effects = []; selectedEffect = null; persist(); renderEffects(); buildToolbar(); syncHint(); } } }, ['Clear']) : null;
    toolbar.appendChild(el('div', { class: 'group' }, [
      toolButton('pan', 'Pan', 'Drag the map (or hold Space, or drag with the middle button)'),
      toolButton('ping', 'Ping', 'Click the map to ping it in every window'),
      toolButton('circle', 'Circle', 'Drag from centre'),
      toolButton('line', 'Line', 'Drag start to end'),
      toolButton('square', 'Square', 'Drag corner to corner'),
      toolButton('ruler', 'Ruler', 'Drag to measure, in cells'),
      removeFx,
      clearFx,
      copyBtn,
      pasteBtn,
    ]));

    const resetFog = el('button', { class: 'btn ghost', onclick: () => { map.fog.revealed = []; persist(); renderBase(); } }, ['Reset']);
    toolbar.appendChild(el('div', { class: 'group' }, [
      el('span', { class: 'muted' }, ['Fog']),
      check('on', () => map.fog.enabled, (v) => { map.fog.enabled = v; }),
      toolButton('reveal', 'Reveal', 'Drag a rectangle to reveal'),
      toolButton('brush', 'Brush', 'Paint a circle of reveal as you drag'),
      numField('r', () => brushRadius, (v) => { brushRadius = Math.max(0.5, v); }, 0.5),
      resetFog,
    ]));
    const clocksBtn = el('button', { class: 'btn ghost' + (clocksShown ? ' active' : ''), title: 'The campaign\'s clocks over the map', onclick: () => { clocksShown = !clocksShown; renderClocks(); buildToolbar(); } }, ['Clocks']);
    toolbar.appendChild(el('div', { class: 'group' }, [clocksBtn]));

    const playerBtn = el('button', { class: 'btn', onclick: () => window.open(location.pathname + '?view=player' + (follow ? '' : '&map=' + encodeURIComponent(mapId)), (window.VttConfig.channel || 'vtt') + '-player') }, ['Open player view']);
    // the players stay on their map until the GM brings them to this one
    const here = (State.state.table || {}).map === mapId;
    const bring = el('button', { class: 'btn' + (here ? ' ghost' : ''), title: here ? 'The players are looking at this map' : `The players are on ${playersMapName() || 'no map yet'} — bring them to this one` }, [here ? 'Players are here' : 'Bring players here']);
    bring.disabled = here;
    bring.addEventListener('click', () => { State.commit('setTableMap', [mapId]); buildToolbar(); });
    const legendBtn = el('button', { class: 'btn ghost' + (legendOpen ? ' active' : ''), title: 'The map’s key, from the book — for you, not the players' }, ['Legend']);
    legendBtn.disabled = !Sys.legend(mapId);
    legendBtn.addEventListener('click', () => {
      legendOpen = !legendOpen;
      buildToolbar();
      renderLegend();
    });
    const h = State.history ? State.history() : { undo: 0 };
    const undoBtn = el('button', { class: 'btn ghost', title: 'Undo the last change made in this window (Ctrl+Z)', onclick: () => { State.undo(); refresh(); buildToolbar(); } }, [h.undo ? `Undo (${h.undo})` : 'Undo']);
    undoBtn.disabled = !h.undo;
    toolbar.appendChild(el('div', { class: 'group last' }, [bring, undoBtn, legendBtn, el('button', { class: 'btn ghost', onclick: fit }, ['Fit']), playerBtn]));
  }

  function syncHint() {
    const n = map.tokens.length;
    const note = follow && followNote ? followNote + ' ' : '';
    if (PLAYER) {
      hint.textContent = (myMemberId() ? (myToken() ? 'Drag your own token · ' : 'Place my token puts you on the map · ') : '') + 'wheel zooms · right-drag or the arrow keys pan (a finger pans on touch)';
      return;
    }
    if (selectedEffect) {
      const fx = map.effects.find((x) => x.id === selectedEffect);
      hint.textContent = `${fx && fx.label ? fx.label : (fx ? fx.kind : 'shape')} selected · Delete or the toolbar's Remove takes it away · right-click to label it · click elsewhere to deselect`;
      return;
    }
    const shapes = map.effects.length ? ` · ${map.effects.length} shape${map.effects.length === 1 ? '' : 's'}: click one to select it` : '';
    const k = selectedIds.size;
    const selNote = k > 1 ? `${k} selected · drag one to move them all · ` : '';
    hint.textContent = note + selNote + (n ? `${n} token${n === 1 ? '' : 's'} · click a token for its options (ring, face, name, size, harm clock) · drag to move · drag a box to select · right-drag, arrows, Space or the middle button pan · selected: 1–4 size, H hide, Ctrl+D duplicate, Ctrl+C copy (Ctrl+V pastes on any map), Delete removes · wheel zooms · Esc clears the tool` : 'No tokens yet — add the party and the cast from the toolbar.') + shapes;
  }

  // ── bus ────────────────────────────────────────────────────────────
  Bus.on('state:changed', (p, meta) => {
    if (!(meta && meta.remote)) return;
    refresh();
    if (!PLAYER && p && p.op && p.op.name === 'setTableMap') buildToolbar();   // the players' map changed elsewhere: the Bring button follows
  });
  Bus.on('state:remote', () => refresh());
  Bus.on('scene:changed', (p, meta) => {
    if (!(meta && meta.remote)) return;
    refresh();
    syncHint();
  });
  Bus.on('ping', (p) => {
    if (p && p.mapId === mapId) showPing(p.x, p.y);
  });
  Bus.on('history', () => buildToolbar());     // the Undo button follows this window's stack

  // ── boot ───────────────────────────────────────────────────────────
  buildLayers();
  const pinned = params.get('map') || (params.get('scene') ? Sys.defaultMapId(params.get('scene')) : null);
  switchMap(pinned || followedMap(), true);
  window.addEventListener('resize', applyView);

  window.VttTable = { refresh, fit, map: () => map, mapId: () => mapId, scene: () => sceneId, tool: () => tool, addToken: addTokenAt, legend: () => legendOpen, preloaded: () => preloaded, clocksShown: () => clocksShown };
})();
