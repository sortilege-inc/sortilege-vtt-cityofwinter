// engine/gm-panes.js — the GM's own panes (the family standard, PLAYBOOK §4b.2): the campaign's
// Overview (its standing facts, its rulings, a search across all of it, the free notes), Scenes (the
// arc: sessions, scenes with their beats, the questions for the table), Threads, Places and People
// (the campaign's people and the GM's notes on the characters). Everything is the GM's own pack
// state (engine/gm-text.js: gm, gmNotes, arc, threads) — saved with the pack, never shared, never
// sent to a session's room. A pane the system already registers under the same id is left alone.
// Ported from sortilege-vtt-l5r5e (system/l5r5e/gm-panes.js, I19), without the L5R-only parts
// (encounters, a scene's cast, the campaign as its own adventure).
(function () {
  const { el, button, debounce } = window.VttRender;
  const G = window.VttGmText;
  const State = window.VttState;
  const Panels = window.VttPanels;
  const S = () => State.state;
  const CFG = window.VttConfig || {};
  const newId = (p) => State.genId(p);
  const editing = (c) => document.activeElement && /TEXTAREA|INPUT|SELECT/.test(document.activeElement.tagName) && c.contains(document.activeElement);
  const redrawOn = (ctx, container, draw) => {
    ctx.on('state:changed', () => { if (!editing(container)) draw(); });
    ctx.on('state:remote', () => { if (!editing(container)) draw(); });
    ctx.on('gm:reveal', draw);
  };
  const register = (id, panel) => { if (!Panels.PANELS[id]) Panels.register(id, panel); };

  // ── Overview ────────────────────────────────────────────────────────
  let searchQ = '';
  function renderOverview(container, ctx) {
    const draw = () => {
      container.innerHTML = '';
      const q = el('input', { type: 'search', class: 'search', placeholder: 'Search the GM’s material — scenes, threads, places, people…', value: searchQ });
      const hits = el('div', { class: 'gm-hits' });
      const drawHits = () => {
        hits.innerHTML = '';
        const r = G.search(searchQ);
        if (searchQ.trim().length >= 2) hits.appendChild(el('div', { class: 'muted small' }, [r.length + ' found']));
        r.slice(0, 40).forEach((x) => hits.appendChild(el('div', { class: 'gm-hit' }, [
          el('button', { class: 'ref', type: 'button', onclick: () => G.goTo(x) }, [x.title]),
          el('span', { class: 'muted small' }, [' · ' + ((Panels.PANELS[x.pane] || {}).label || x.pane)]),
          el('div', { class: 'small' }, [x.snip]),
        ])));
      };
      q.addEventListener('input', debounce(() => { searchQ = q.value; drawHits(); }, 150));
      container.appendChild(q);
      container.appendChild(hits);
      drawHits();
      const items = G.list('overview');
      if (!items.length) container.appendChild(el('div', { class: 'empty' }, ['The campaign’s premise and standing facts go here — add a section below.']));
      G.sections(container, items, { redraw: draw, save: (l) => G.setList('overview', l), addLabel: 'Add a section…' });
      container.appendChild(el('h4', { 'data-gm-id': 'rules' }, ['Rulings', el('span', { class: 'muted small' }, [' · practice at this table'])]));
      G.sections(container, G.list('rules'), { redraw: draw, save: (l) => G.setList('rules', l), addLabel: 'Add a ruling…' });
      container.appendChild(el('h4', { 'data-gm-id': 'free-notes' }, ['Free notes', el('span', { class: 'muted small' }, [' · saved with the pack, never sent to players'])]));
      container.appendChild(el('textarea', { class: 'text notes-free', rows: 8, placeholder: 'Jot as you play…', oninput: debounce((ev) => State.commit('setGmNotes', [ev.target.value]), 400) }, [S().gmNotes || '']));
      G.reveal(container);
    };
    redrawOn(ctx, container, draw);
    draw();
  }

  // ── Scenes: the campaign's arc ─────────────────────────────────────
  // arc = [{ id, title, session, summary, text, sections: [beat], played }]; sessions are its groups,
  // and a session whose scenes are all played folds to one line
  const arc = () => JSON.parse(JSON.stringify(S().arc || []));
  const setArc = (list) => State.commit('setArc', [list]);
  const sessionOpen = {};
  function renderScenes(container, ctx) {
    const draw = () => {
      container.innerHTML = '';
      const list = arc();
      const played = list.filter((x) => x.played).length;
      container.appendChild(el('h4', {}, ['The arc', el('span', { class: 'muted small' }, [' · ' + list.length + ' scenes, ' + played + ' played'])]));
      if (!list.length) container.appendChild(el('div', { class: 'empty' }, ['No scenes yet — add the first below.']));
      const groups = [];
      list.forEach((x, i) => {
        const g = groups[groups.length - 1];
        if (g && g.name === (x.session || null)) g.items.push([x, i]);
        else groups.push({ name: x.session || null, items: [[x, i]] });
      });
      const opts = {
        redraw: draw, save: setArc, subLabel: 'Beat',
        cls: (x) => 'arc-card' + (x.played ? ' played' : ''),
        badges: (x) => (x.played ? el('span', { class: 'chip' }, ['Played']) : null),
        before: (x) => (x.summary ? el('p', { class: 'arc-summary' }, [x.summary]) : el('span')),
        actions: (x) => button(x.played ? 'Not played' : 'Mark played', () => { const l = arc(); const at = l.findIndex((y) => y.id === x.id); l[at].played = !x.played; setArc(l); }, 'ghost tiny'),
        fields: (d) => el('div', { class: 'chiprow tight' }, [
          el('input', { class: 'text', type: 'text', value: d.session || '', placeholder: 'Session (groups the scenes)', oninput: (ev) => (d.session = ev.target.value.trim() || undefined) }),
          el('input', { class: 'text wide', type: 'text', value: d.summary || '', placeholder: 'One line: what the scene is', oninput: (ev) => (d.summary = ev.target.value.trim() || undefined) }),
        ]),
      };
      const next = list.find((x) => !x.played);
      groups.forEach((g) => {
        const key = g.name || '';
        const allPlayed = g.items.every(([x]) => x.played);
        const isOpen = sessionOpen[key] != null ? sessionOpen[key] : !allPlayed;
        container.appendChild(el('button', { class: 'arc-session' + (allPlayed ? ' played' : ''), type: 'button', 'aria-expanded': isOpen ? 'true' : 'false', onclick: () => { sessionOpen[key] = !isOpen; draw(); } }, [
          el('span', { class: 'gm-caret', 'aria-hidden': 'true' }, [isOpen ? '▾' : '▸']), ' ', g.name || 'Scenes',
          el('span', { class: 'muted small' }, [' · ' + g.items.length + (g.items.length === 1 ? ' scene' : ' scenes') + (allPlayed ? ', played' : '')]),
        ]));
        if (!isOpen) return;
        g.items.forEach(([x, i]) => {
          if (G.open[x.id] == null) G.open[x.id] = !!next && next.id === x.id;
          container.appendChild(G.editingId[x.id] ? G.sectionEditor(x, i, list, opts) : G.sectionView(x, opts));
        });
      });
      const last = list.length ? list[list.length - 1].session : undefined;
      const t = el('input', { class: 'text', type: 'text', placeholder: 'Add a scene…' });
      container.appendChild(el('div', { class: 'chiprow tight gm-add' }, [t, button('Add', () => {
        if (!t.value.trim()) return;
        const x = { id: newId('arc'), title: t.value.trim(), session: last, text: '', played: false };
        G.editingId[x.id] = true; G.open[x.id] = true;
        setArc(arc().concat([x]));
      }, 'tiny')]));
      // the questions to put to the players, asked or not
      const qs = Object.assign({ note: '', items: [] }, (S().gm || {}).questions || {});
      const setQs = (patch) => State.commit('setGm', ['questions', Object.assign({}, qs, patch)]);
      container.appendChild(el('h4', { 'data-gm-id': 'questions' }, ['Questions for the table', el('span', { class: 'muted small' }, [' · ' + qs.items.filter((x) => !x.asked).length + ' not yet asked'])]));
      container.appendChild(G.note(() => qs.note, (v) => setQs({ note: v }), 'Add a note on the questions', draw));
      container.appendChild(el('ul', { class: 'gm-questions' }, qs.items.map((x, i) => el('li', { class: x.asked ? 'asked' : '', 'data-gm-id': x.id }, [
        el('input', { type: 'checkbox', checked: x.asked || null, title: 'Asked', onchange: (ev) => { const l = qs.items.slice(); l[i] = Object.assign({}, x, { asked: ev.target.checked }); setQs({ items: l }); } }),
        el('span', { class: 'gm-q', html: G.inline(x.text || '') }),
        button('×', () => { if (confirm('Remove this question?')) setQs({ items: qs.items.filter((_, j) => j !== i) }); }, 'ghost tiny'),
      ]))));
      const nq = el('input', { class: 'text', type: 'text', placeholder: 'Add a question…' });
      container.appendChild(el('div', { class: 'chiprow tight gm-add' }, [nq, button('Add', () => { if (nq.value.trim()) setQs({ items: qs.items.concat([{ id: newId('q'), text: nq.value.trim(), asked: false }]) }); }, 'tiny')]));
      G.reveal(container);
    };
    redrawOn(ctx, container, draw);
    draw();
  }

  // ── Threads ─────────────────────────────────────────────────────────
  const threads = () => JSON.parse(JSON.stringify(S().threads || []));
  const setThreads = (l) => State.commit('setThreads', [l]);
  function renderThreads(container, ctx) {
    const draw = () => {
      container.innerHTML = '';
      const ts = threads();
      container.appendChild(el('h4', { 'data-gm-id': 'threads-note' }, ['Threads', el('span', { class: 'muted small' }, [' · ' + ts.filter((x) => x.open !== false).length + ' open, ' + ts.filter((x) => x.open === false).length + ' closed'])]));
      container.appendChild(G.note(() => (S().gm || {}).threadsNote, (v) => State.commit('setGm', ['threadsNote', v]), 'Add a note on the threads', draw));
      const upd = (x, patch) => { const l = threads(); const at = l.findIndex((y) => y.id === x.id); l[at] = Object.assign({}, l[at], patch); setThreads(l); };
      G.sections(container, ts, {
        redraw: draw, save: setThreads, addLabel: 'Open a thread…', fresh: () => ({ open: true }),
        cls: (x) => 'thread' + (x.open === false ? ' closed' : ''),
        badges: (x) => (x.open === false ? el('span', { class: 'chip' }, ['Closed']) : null),
        after: (x) => el('div', { class: 'thread-notes' }, [
          el('div', { class: 'prop-k' }, ['In play']),
          el('textarea', { class: 'text', rows: 2, placeholder: 'What has happened to it at the table…', oninput: debounce((ev) => upd(x, { notes: ev.target.value }), 400) }, [x.notes || '']),
        ]),
        actions: (x) => button(x.open === false ? 'Reopen' : 'Close', () => upd(x, { open: x.open === false }), 'ghost tiny'),
      });
      G.reveal(container);
    };
    redrawOn(ctx, container, draw);
    draw();
  }

  // ── Places ──────────────────────────────────────────────────────────
  function renderPlaces(container, ctx) {
    G.listPane(container, ctx, 'places', { addLabel: 'Add a place…', empty: 'No places yet.' });
  }

  // ── People: the campaign's people, and the GM's notes on the characters ─
  function renderPeople(container, ctx) {
    const draw = () => {
      container.innerHTML = '';
      container.appendChild(el('h4', { 'data-gm-id': 'people' }, ['The campaign’s people']));
      G.sections(container, G.list('people'), { redraw: draw, save: (l) => G.setList('people', l), addLabel: 'Add someone…' });
      container.appendChild(el('h4', { 'data-gm-id': 'pc' }, ['Behind the characters', el('span', { class: 'muted small' }, [' · never sent to players'])]));
      G.sections(container, G.list('pc'), { redraw: draw, save: (l) => G.setList('pc', l), addLabel: 'Add a note on a character…' });
      G.reveal(container);
    };
    redrawOn(ctx, container, draw);
    draw();
  }

  // ── Settings: this browser's own configuration ──────────────────────
  // The public site's book tabs (engine/site.js) are off on a deployment unless VttConfig.siteBooks
  // turns them on; the GM may turn them on here, for this browser only (PLAYBOOK §4b.4).
  const BOOKS_KEY = (CFG.storagePrefix || 'sortilege-vtt') + ':site-books';
  // a little schematic of a layout (its columns, each split into its stacked regions), for the picker
  function layoutIcon(cols) {
    const NS = 'http://www.w3.org/2000/svg';
    const W = 46;
    const H = 32;
    const gap = 2;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('class', 'layout-ico');
    const cw = (W - gap * (cols.length + 1)) / cols.length;
    cols.forEach((cells, ci) => {
      const x = gap + ci * (cw + gap);
      const ch = (H - gap * (cells.length + 1)) / cells.length;
      cells.forEach((_r, ri) => {
        const rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('x', x);
        rect.setAttribute('y', gap + ri * (ch + gap));
        rect.setAttribute('width', cw);
        rect.setAttribute('height', ch);
        rect.setAttribute('rx', 1.5);
        svg.appendChild(rect);
      });
    });
    return svg;
  }

  function renderSettings(container) {
    const draw = () => {
      container.innerHTML = '';
      container.appendChild(el('h4', {}, ['Settings']));
      container.appendChild(el('p', { class: 'muted small' }, ['Saved in this browser only — not in the pack, not shared with the table.']));
      // Layout (wide screens): how the GM page arranges its regions; each region has its own picker
      if (window.VttApp && window.VttApp.layouts) {
        const cur = window.VttApp.currentLayout();
        const row = el('div', { class: 'layout-picker' }, window.VttApp.layouts().map((L) => el('button', {
          class: 'layout-opt' + (L.id === cur ? ' on' : ''), type: 'button', title: L.label,
          onclick: () => { window.VttApp.setLayout(L.id); draw(); },
        }, [layoutIcon(L.cols), el('span', { class: 'layout-opt-label' }, [L.label])])));
        container.appendChild(el('div', { class: 'paper settings-section' }, [
          el('div', { class: 'guidance-k' }, ['Layout']),
          el('p', { class: 'muted small' }, ['How the GM page arranges its panels on a wide screen. Each region has its own picker in its heading, so one can hold the Scene while the others change. Click a region to select it; a nav choice then opens there.']),
          row,
        ]));
      }
      // the map library's key (engine/library.js): this browser only
      if (window.VttLibrary && window.VttLibrary.enabled()) {
        const Lib = window.VttLibrary;
        const keyIn = el('input', { type: 'password', class: 'text', placeholder: 'the library key', value: Lib.key(), autocomplete: 'off' });
        const note = el('span', { class: 'muted small' }, [Lib.ready() ? 'Set — the table page can upload and pick maps.' : 'Not set — the table page cannot upload yet.']);
        container.appendChild(el('div', { class: 'paper settings-section' }, [
          el('div', { class: 'guidance-k' }, ['The map library']),
          el('p', { class: 'muted small' }, ['Maps are uploaded to this deployment’s Worker, not kept in the repo. The upload key is the Worker’s LIBRARY_KEY secret; enter it here once. It stays in this browser — not in the pack, not shared with the table.']),
          el('div', { class: 'chiprow' }, [keyIn, button('Save', () => { Lib.setKey(keyIn.value.trim()); draw(); }, ''), button('Forget', () => { Lib.setKey(''); draw(); }, 'ghost'), note]),
        ]));
      }
      let on = !!CFG.siteBooks;
      try { const v = localStorage.getItem(BOOKS_KEY); if (v !== null) on = v === '1'; } catch (e) { /* the default */ }
      container.appendChild(el('div', { class: 'paper settings-section' }, [
        el('div', { class: 'guidance-k' }, ['The books on the site']),
        el('p', { class: 'muted small' }, ['Whether the public site shows the books’ tabs. This setting is for this browser only; other visitors see the site’s default (' + (CFG.siteBooks ? 'on' : 'off') + ').']),
        el('label', { class: 'set-row' }, [
          el('input', { type: 'checkbox', checked: on || null, onchange: (ev) => { try { localStorage.setItem(BOOKS_KEY, ev.target.checked ? '1' : '0'); } catch (e) { /* private mode */ } draw(); } }),
          ' Show the books on the site, in this browser',
        ]),
      ]));
    };
    draw();
  }

  register('overview', { label: 'Overview', render: renderOverview });
  register('scenes', { label: 'Scenes', render: renderScenes });
  register('threads', { label: 'Threads', render: renderThreads });
  register('places', { label: 'Places', render: renderPlaces });
  register('people', { label: 'People', render: renderPeople });
  register('settings', { label: 'Settings', render: renderSettings });
})();
