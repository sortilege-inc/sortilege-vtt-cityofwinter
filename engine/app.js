// engine/app.js — the GM page's shell: a sidebar of panels and three slots.
//
// Wide (≥ 1100px): three columns, each showing one panel picked from the registry
// (default Module · Scene · Inspector; the choice is a per-browser preference).
// Narrow: one panel at a time, the sidebar as tabs. Panels never know which.
(function () {
  const { el } = window.VttRender;
  const State = window.VttState;
  const Panels = window.VttPanels;
  const CFG = window.VttConfig;

  const WIDE = 1100;
  const DEFAULT_SLOTS = CFG.defaultSlots || ['tracker', 'scene', 'inspector'];   // a system's or an instance's own (VttConfig.defaultSlots)
  // what the regions beyond the first three open on, in a split layout
  const REGION_FALLBACK = DEFAULT_SLOTS.concat(CFG.regionFallback || ['party', 'log', 'clocks', 'cast']);

  // The wide-mode layouts the GM picks from (Settings ▸ Layout — a per-browser preference; ported
  // from sortilege-vtt-daggerheart). A layout is a set of columns; a column holds one region or
  // several stacked. `regions` is how many independent panel regions it has, filled in reading
  // order (each column top to bottom); the numbers in `cols` are region indices.
  const LAYOUTS = [
    { id: '3row',           label: 'Three rows',                 regions: 3, cls: 'ly-3row',    cols: [[0, 1, 2]] },
    { id: '3col',           label: 'Three columns',              regions: 3, cls: 'ly-3col',    cols: [[0], [1], [2]] },
    { id: '4col',           label: 'Four columns',               regions: 4, cls: 'ly-4col',    cols: [[0], [1], [2], [3]] },
    { id: '3col-split1',    label: 'Three columns, first split', regions: 4, cls: 'ly-3col-s1', cols: [[0, 1], [2], [3]] },
    { id: '4col-splitends', label: 'Four columns, ends split',   regions: 6, cls: 'ly-4col-se', cols: [[0, 1], [2], [3], [4, 5]] },
  ];
  const DEFAULT_LAYOUT = '3col';
  const main = document.getElementById('main');
  const nav = document.getElementById('nav');
  const brand = document.getElementById('brand');

  let mode = null;
  let single = DEFAULT_SLOTS[0];
  let ctxs = [];

  function layoutDef() {
    const id = State.ui('layout');
    return LAYOUTS.filter((l) => l.id === id)[0] || LAYOUTS.filter((l) => l.id === DEFAULT_LAYOUT)[0];
  }

  // the panel shown in region i: the saved choice if the page still has it, else a sensible default
  function slotFor(i) {
    const s = State.ui('slots');
    const id = Array.isArray(s) ? s[i] : null;
    if (id && Panels.PANELS[id]) return id;
    const fb = REGION_FALLBACK[i];
    if (fb && Panels.PANELS[fb]) return fb;
    const first = Panels.list()[0];
    return first ? first.id : (fb || 'tracker');
  }
  function setSlot(i, id) {
    const lay = layoutDef();
    const s = [];
    for (let k = 0; k < lay.regions; k++) s[k] = (k === i) ? id : slotFor(k);
    State.ui('slots', s);
  }
  // every region's panel, in reading order
  function slots() {
    const lay = layoutDef();
    const out = [];
    for (let i = 0; i < lay.regions; i++) out.push(slotFor(i));
    return out;
  }
  // the region the GM last clicked into — where a nav choice opens (else the browsing region, the last)
  function focusRegion() {
    const f = State.ui('focus');
    const lay = layoutDef();
    return (typeof f === 'number' && f >= 0 && f < lay.regions) ? f : null;
  }

  function teardown() {
    ctxs.splice(0).forEach((c) => c.teardown());
  }

  function mountSlot(region) {
    const id = region == null ? single : slotFor(region);
    const ctx = Panels.makeCtx(open);
    ctxs.push(ctx);
    const head = el('div', { class: 'slot-head' }, [el('span', {}, [Panels.PANELS[id] ? Panels.PANELS[id].label : id])]);
    if (region != null) {
      const pick = el('select', { class: 'slot-pick', title: 'Show another panel here' });
      Panels.list().forEach((p) => pick.appendChild(el('option', { value: p.id, selected: p.id === id || null }, [p.label])));
      pick.addEventListener('change', () => { setSlot(region, pick.value); render(); });
      head.appendChild(pick);
    }
    const body = el('div', { class: 'slot-body' });
    const focused = region != null && focusRegion() === region;
    const slot = el('section', { class: 'slot slot-' + id + (focused ? ' slot--focus' : ''), 'data-region': region == null ? null : String(region) }, [head, body]);
    // clicking into a region selects it: a nav choice then opens here. The outline moves without a
    // re-render, so the panel keeps its state and scroll. On `click`, not `mousedown` (a mousedown
    // save redrew the panels and swallowed the first click — found in coyotecrow at M3).
    if (region != null) {
      slot.addEventListener('click', () => {
        if (focusRegion() === region) return;
        State.ui('focus', region);
        const prev = main.querySelector('.slot--focus');
        if (prev) prev.classList.remove('slot--focus');
        slot.classList.add('slot--focus');
      });
    }
    Panels.mount(body, id, ctx);
    return slot;
  }

  function render() {
    teardown();
    main.innerHTML = '';
    mode = window.innerWidth >= WIDE ? 'wide' : 'single';
    if (mode === 'wide') {
      const lay = layoutDef();
      main.className = 'main wide ' + lay.cls;
      lay.cols.forEach((colRegions) => main.appendChild(el('div', { class: 'slot-col' }, colRegions.map((r) => mountSlot(r)))));
    } else {
      main.className = 'main single';
      main.appendChild(mountSlot(null));
    }
    buildNav();
  }

  function open(id) {
    if (mode === 'wide') {
      const lay = layoutDef();
      if (slots().indexOf(id) !== -1 && focusRegion() == null) { render(); return; }   // already on screen, nowhere chosen: leave it be
      // open into the region the GM selected; with none selected, the browsing region (the last)
      const target = focusRegion() != null ? focusRegion() : (lay.regions - 1);
      setSlot(target, id);
      State.ui('focus', target);
      render();
      return;
    }
    single = id;
    render();
    window.scrollTo(0, 0);
  }

  function setLayout(id) {
    if (!LAYOUTS.some((l) => l.id === id)) return;
    State.ui('layout', id);
    const f = State.ui('focus');
    const lay = LAYOUTS.filter((l) => l.id === id)[0];
    if (typeof f === 'number' && f >= lay.regions) State.ui('focus', lay.regions - 1);
    render();
  }

  function buildNav() {
    nav.innerHTML = '';
    const shown = mode === 'wide' ? slots() : [single];
    Panels.list().forEach((p) => {
      nav.appendChild(el('li', {}, [el('button', { class: 'navbtn' + (shown.indexOf(p.id) !== -1 ? ' active' : ''), type: 'button', onclick: () => open(p.id) }, [p.label])]));
    });
    const c = State.state.campaign;
    brand.innerHTML = '';
    brand.appendChild(el('div', { class: 'brand-title' }, [CFG.title]));
    brand.appendChild(el('div', { class: 'brand-sub' }, [c.name || 'no campaign']));
  }

  // `/` focuses the search wherever the Rules panel is mounted
  document.addEventListener('keydown', (ev) => {
    if (ev.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      const slot = main.querySelector('.slot-rules .slot-body');
      if (!slot) open('rules');
      const body = main.querySelector('.slot-rules .slot-body');
      if (body && body.focusSearch) {
        ev.preventDefault();
        body.focusSearch();
      }
    }
  });

  let resizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      const next = window.innerWidth >= WIDE ? 'wide' : 'single';
      if (next !== mode) render();
    }, 120);
  });
  window.VttBus.on('state:changed', buildNav);
  // a selection made while no Inspector is on screen brings one into the browsing column
  window.VttBus.on('select', (sel, meta) => {
    if (meta && meta.remote) return;
    if (mode === 'wide' && !main.querySelector('.slot-inspector')) open('inspector');
    else if (mode === 'single' && single !== 'inspector') open('inspector');
  });

  // ── session (players on their own devices) ─────────────────────────
  const Session = window.VttSession;
  const sc = document.getElementById('session-controls');
  function buildSession() {
    if (!sc || !Session) return;
    sc.innerHTML = '';
    const s = Session.current();
    if (!s.active) {
      const start = el('button', { class: 'btn ghost', type: 'button' }, ['Start session']);
      start.disabled = !s.configured;
      start.title = s.configured ? 'Players join by room code' : 'No Worker URL in engine/config.js';
      start.addEventListener('click', async () => {
        start.disabled = true;
        try {
          await Session.start();
        } catch (e) {
          alert(e.message);
          start.disabled = false;
        }
      });
      sc.appendChild(start);
      return;
    }
    const url = Session.joinUrl();
    const copy = el('button', { class: 'btn ghost tiny', type: 'button', onclick: () => navigator.clipboard && navigator.clipboard.writeText(url).then(() => { copy.textContent = 'copied'; setTimeout(() => (copy.textContent = 'copy link'), 1500); }) }, ['copy link']);
    const end = el('button', { class: 'btn ghost tiny', type: 'button', onclick: () => { if (confirm('End the session? Players are disconnected; your campaign stays here.')) Session.leave(); } }, ['end']);
    const reseed = el('button', { class: 'btn ghost tiny', type: 'button', title: 'Replace the room\'s document with this browser\'s campaign (after restoring a pack)', onclick: () => { if (confirm('Overwrite the room with this browser\'s campaign?')) Session.reseed(); } }, ['reseed']);
    sc.appendChild(el('div', { class: 'session-code' }, [el('span', { class: 'chip' + (s.connected ? ' on' : '') }, [s.connected ? 'live' : s.status]), el('b', {}, [s.info.code]), el('span', { class: 'muted' }, [` ${Object.keys(s.claims).length} claimed`])]));
    sc.appendChild(el('div', { class: 'session-url' }, [url]));
    sc.appendChild(el('div', { class: 'chiprow' }, [copy, reseed, end]));
    // how long the evening has run, the last thing rolled, and the room's idleness (rooms expire after 14 idle days)
    const elapsed = el('span', { class: 'muted session-clock', title: 'Since this session started' });
    const tick = () => {
      const ms = Date.now() - (s.info.startedAt || Date.now());
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      elapsed.textContent = `${h ? h + 'h ' : ''}${m}m at the table`;
    };
    tick();
    const timer = setInterval(() => (document.body.contains(elapsed) ? tick() : clearInterval(timer)), 30000);
    const ticker = el('div', { class: 'muted session-last' });
    const syncLast = () => {
      const x = (State.state.log || []).slice(-1)[0];
      ticker.textContent = !x ? 'nothing rolled yet' : x.kind === 'roll' ? `last: ${x.who} · ${x.axis} → ${x.band}` : `last: ${x.text || ''}`;
    };
    syncLast();
    window.VttBus.on('state:changed', syncLast);
    window.VttBus.on('state:remote', syncLast);
    const idle = el('div', { class: 'muted session-idle' });
    const checkIdle = () => Session.roomInfo().then((r) => {
      if (!r || !r.lastActive) return;
      const days = (Date.now() - r.lastActive) / 86400000;
      const limit = (r.idleMs || 14 * 86400000) / 86400000;
      idle.textContent = days >= 1 ? `room idle ${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'} · expires after ${limit}` : '';
      idle.classList.toggle('warn', days >= limit - 2);
    }).catch(() => {});
    checkIdle();
    sc.appendChild(el('div', { class: 'session-meta' }, [elapsed, ticker, idle]));
  }
  if (Session) {
    Session.onChange(buildSession);
    buildSession();
  }

  // the table and the player view are separate windows on the same state
  const wc = document.getElementById('window-controls');
  if (wc) {
    wc.appendChild(el('button', { class: 'btn', type: 'button', onclick: () => window.open(CFG.pages.table, CFG.channel + '-table') }, ['Open table']));
    wc.appendChild(el('button', { class: 'btn ghost', type: 'button', onclick: () => window.open(CFG.pages.table + '?view=player', CFG.channel + '-player') }, ['Open player view']));
    // undo / redo of this page's own changes (Ctrl+Z / Ctrl+Shift+Z)
    const undoBtn = el('button', { class: 'btn ghost tiny', type: 'button', title: 'Undo the last change made on this page (Ctrl+Z)', onclick: () => State.undo() }, ['Undo']);
    const redoBtn = el('button', { class: 'btn ghost tiny', type: 'button', title: 'Redo (Ctrl+Shift+Z)', onclick: () => State.redo() }, ['Redo']);
    const syncHistory = () => {
      const h = State.history();
      undoBtn.disabled = !h.undo;
      redoBtn.disabled = !h.redo;
      undoBtn.textContent = h.undo ? `Undo (${h.undo})` : 'Undo';
    };
    wc.appendChild(el('div', { class: 'chiprow history' }, [undoBtn, redoBtn]));
    // panel presets: what the three slots show (one click each)
    const PRESETS = CFG.presets || { Prep: ['tracker', 'scene', 'inspector'], Running: ['scene', 'party', 'log'] };   // a system's own (VttConfig.presets)
    wc.appendChild(el('div', { class: 'chiprow presets' }, Object.keys(PRESETS).map((name) => el('button', { class: 'btn ghost tiny', type: 'button', title: PRESETS[name].map((id) => Panels.PANELS[id] ? Panels.PANELS[id].label : id).join(' · '), onclick: () => { const s = slots(); PRESETS[name].forEach((id, i) => (s[i] = id)); State.ui('slots', s); single = PRESETS[name][0]; render(); } }, [name]))));
    window.VttBus.on('history', syncHistory);
    syncHistory();
  }
  document.addEventListener('keydown', (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== 'z' || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    ev.preventDefault();
    if (ev.shiftKey) State.redo();
    else State.undo();
  });

  window.VttApp = { open, render, setLayout, layouts: () => LAYOUTS.map((l) => ({ id: l.id, label: l.label, cols: l.cols })), currentLayout: () => layoutDef().id, mode: () => mode };

  // The veil (PLAYBOOK §4b.3): the GM page may stand behind a warning (VttConfig.gmGate = { title,
  // text, enter, leave }) — a courtesy to a player who opens /gm/ on the public site, not access
  // control. Passed once per tab (sessionStorage); "leave" goes back to the site.
  const gate = CFG.gmGate;
  if (CFG.title) document.title = CFG.title + ' — the ' + (CFG.roleName || 'GM') + '’s table';
  const GATE_KEY = (CFG.storagePrefix || 'sortilege-vtt') + ':gm-gate';
  let passed = !gate;
  try { passed = passed || sessionStorage.getItem(GATE_KEY) === '1'; } catch (e) { /* storage off: ask every load */ }
  if (!passed) {
    document.body.classList.add('gated');
    const veil = el('div', { class: 'gm-veil', role: 'dialog', 'aria-modal': 'true' }, [el('div', { class: 'paper gm-veil-box' }, [
      gate.title ? el('div', { class: 'gm-veil-title' }, [gate.title]) : null,
      gate.text ? el('p', {}, [gate.text]) : null,
      el('div', { class: 'chiprow' }, [
        el('button', { class: 'btn', type: 'button', onclick: () => { try { sessionStorage.setItem(GATE_KEY, '1'); } catch (e) { /* this load only */ } veil.remove(); document.body.classList.remove('gated'); start(); } }, [gate.enter || 'Enter']),
        el('a', { class: 'btn ghost', href: (CFG.pages && CFG.pages.site) || '../' }, [gate.leave || 'Leave']),
      ]),
    ])]);
    document.body.appendChild(veil);
  } else start();

  function start() {
    render();
    // a deployment's seed fills what its campaign has never had (engine/state.js seed); redraw if it did
    if (State.seed) State.seed().then((keys) => { if (keys.length) render(); }).catch((e) => window.console && console.warn('[vtt] seed: ' + e.message));
  }
})();
