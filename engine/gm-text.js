// engine/gm-text.js — the GM's own material, kept in the pack and edited in the GM tabs (the family
// standard, PLAYBOOK §4b.2: a campaign's "behind the veil" document lives in the tabs, not in a file).
// Ported from sortilege-vtt-l5r5e (system/l5r5e/gm-text.js, I19), made system-free: an entity is
// looked up through VttSystem.byId when the system has one.
//
// Text is a small Markdown: paragraphs, `- ` lists, `> ` quotes, **bold**, *italic*, `code`,
// [links](href), and the prep tags — [SET], [SET 23 Sep], [AGREED], [SOURCE], [YOURS], [OPEN],
// [MINE], [NOTE] — drawn as labels. A section is { id, title, text, sections: [subsection],
// about: [entity ids or party names] }; a subsection is { id, title, text }.
//
// Where it lives (the ops below): `gm` — { overview, places, people, pc, rules: [section],
// threadsNote, questions: { note, items: [{ id, text, asked }] } } — plus `threads` and `arc`. None
// of it is a shared key: it never leaves the GM's browser, not even to the session's room.
window.VttGmText = (function () {
  const { el, button, debounce } = window.VttRender;
  const State = window.VttState;
  const Ops = window.VttOps;
  const S = () => State.state;

  // the GM's own keys: never shared, and their ops never sent to a session's room (opts.local)
  const gmOnly = () => null;
  const LOCAL = { local: true };
  const reg = (name, fn) => { if (!Ops.OPS[name]) Ops.register(name, fn, null, gmOnly, LOCAL); };
  reg('setGm', (s, where, value) => { if (!s.gm) s.gm = {}; s.gm[String(where)] = JSON.parse(JSON.stringify(value == null ? null : value)); });
  reg('setGmNotes', (s, text) => { s.gmNotes = String(text || ''); });
  reg('setArc', (s, list) => { s.arc = JSON.parse(JSON.stringify(list || [])); });
  reg('setThreads', (s, list) => { s.threads = JSON.parse(JSON.stringify(list || [])); });

  const TAGS = {
    SET: 'decided at the table or by the GM', AGREED: 'decided together', SOURCE: 'verified in the books',
    YOURS: 'the GM’s invention, where the books are silent', OPEN: 'not decided yet', MINE: 'a suggestion, not yet adopted', NOTE: 'context',
  };

  // ── the Markdown ────────────────────────────────────────────────────
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function inline(t) {
    const code = [];
    let h = esc(t).replace(/`([^`]+)`/g, (m, c) => { code.push(c); return '\u0000' + (code.length - 1) + '\u0000'; });
    h = h.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, href) => '<a href="' + href + '" target="_blank" rel="noopener">' + txt + '</a>');
    h = h.replace(/\[(SET|AGREED|SOURCE|YOURS|OPEN|MINE|NOTE)((?: [^\]]*)?)\]/g, (m, tag, rest) => '<span class="gm-tag gm-tag-' + tag.toLowerCase() + '" title="' + tag + ' — ' + TAGS[tag] + '">' + tag + rest + '</span>');
    h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
    return h.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + code[+i] + '</code>');
  }
  function html(text) {
    return String(text || '').replace(/\r/g, '').split(/\n\s*\n/).map((b) => b.replace(/^\n+|\n+$/g, '')).filter(Boolean).map((b) => {
      const lines = b.split('\n');
      if (lines.every((l) => /^- /.test(l))) return '<ul>' + lines.map((l) => '<li>' + inline(l.slice(2)) + '</li>').join('') + '</ul>';
      if (lines.every((l) => /^>/.test(l))) return '<blockquote>' + html(lines.map((l) => l.replace(/^> ?/, '')).join('\n')) + '</blockquote>';
      return '<p>' + lines.map(inline).join('<br>') + '</p>';
    }).join('');
  }
  function render(text, cls) {
    const d = el('div', { class: 'gm-text' + (cls ? ' ' + cls : '') });
    d.innerHTML = html(text);
    return d;
  }
  // plain words, for search and for the absorption check
  const plain = (text) => String(text || '').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*+/g, '').replace(/^[->] ?/gm, '');

  // ── the store ───────────────────────────────────────────────────────
  const gm = () => S().gm || {};
  const list = (where) => JSON.parse(JSON.stringify(gm()[where] || []));
  const setList = (where, l) => State.commit('setGm', [where, l]);
  const editing = (c) => document.activeElement && /TEXTAREA|INPUT|SELECT/.test(document.activeElement.tagName) && c.contains(document.activeElement);
  const open = {};          // which sections are unfolded, per page load
  const editingId = {};     // which section is in its editor

  // the people a section is about, as links
  function aboutRow(ids) {
    if (!ids || !ids.length) return null;
    const Sys = window.VttSystem;
    return el('div', { class: 'gm-about muted small' }, ['About: '].concat([].concat(...ids.map((id, i) => {
      const r = Sys && Sys.byId ? Sys.byId(id) : null;
      const m = !r && (S().party || []).find((p) => p.name === id);
      const b = r ? el('button', { class: 'ref', type: 'button', onclick: () => window.VttPanels.select({ kind: 'entity', id: r.id }) }, [r.name])
        : m ? el('button', { class: 'ref', type: 'button', onclick: () => window.VttPanels.select({ kind: 'party', id: m.id }) }, [m.name]) : el('span', {}, [id]);
      return i ? [', ', b] : [b];
    }))));
  }

  // one section, read: title (folds), text, subsections folded; the editor behind Edit
  function sectionView(x, opts) {
    const box = el('div', { class: 'gm-sec' + (opts.cls ? ' ' + opts.cls(x) : ''), 'data-gm-id': x.id });
    const isOpen = open[x.id] != null ? open[x.id] : !!opts.openAll;
    const head = el('div', { class: 'gm-sec-h' }, [
      el('button', { class: 'gm-fold', type: 'button', 'aria-expanded': isOpen ? 'true' : 'false', onclick: () => { open[x.id] = !isOpen; opts.redraw(); } }, [el('span', { class: 'gm-caret', 'aria-hidden': 'true' }, [isOpen ? '▾' : '▸']), ' ', x.title || 'Untitled']),
      opts.badges ? opts.badges(x) : null,
    ]);
    box.appendChild(head);
    if (!isOpen) return box;
    if (opts.before) box.appendChild(opts.before(x));
    if (x.text) box.appendChild(render(x.text));
    (x.sections || []).forEach((y) => {
      const d = el('details', { class: 'gm-sub', 'data-gm-id': y.id, open: open[y.id] || null, ontoggle: (ev) => { open[y.id] = ev.target.open; } }, [el('summary', {}, [y.title || 'Untitled'])]);
      if (y.text) d.appendChild(render(y.text));
      box.appendChild(d);
    });
    const about = aboutRow(x.about);
    if (about) box.appendChild(about);
    if (opts.after) box.appendChild(opts.after(x));
    if (opts.save) box.appendChild(el('div', { class: 'chiprow tight gm-sec-actions' }, [
      opts.actions ? opts.actions(x) : null,
      button('Edit', () => { editingId[x.id] = true; opts.redraw(); }, 'ghost tiny'),
    ]));
    return box;
  }

  // the editor: title, text, each subsection's title and text; order and removal
  function sectionEditor(x, i, all, opts) {
    const d = JSON.parse(JSON.stringify(x));
    d.sections = d.sections || [];
    const box = el('div', { class: 'gm-sec editing', 'data-gm-id': x.id });
    const title = el('input', { class: 'text wide', type: 'text', value: d.title || '', placeholder: 'Title' });
    const text = el('textarea', { class: 'text gm-edit', rows: Math.min(18, 3 + Math.ceil((d.text || '').length / 90)) }, [d.text || '']);
    box.appendChild(title);
    if (opts.fields) box.appendChild(opts.fields(d));
    box.appendChild(text);
    const subs = el('div', { class: 'gm-subs-edit' });
    const drawSubs = () => {
      subs.innerHTML = '';
      d.sections.forEach((y, j) => subs.appendChild(el('div', { class: 'gm-sub-edit' }, [
        el('div', { class: 'chiprow tight' }, [
          el('input', { class: 'text', type: 'text', value: y.title || '', placeholder: opts.subLabel || 'Subsection', oninput: (ev) => (y.title = ev.target.value) }),
          button('↑', () => { if (j) { d.sections.splice(j - 1, 0, d.sections.splice(j, 1)[0]); drawSubs(); } }, 'ghost tiny'),
          button('×', () => { if (confirm('Remove “' + (y.title || 'this part') + '”?')) { d.sections.splice(j, 1); drawSubs(); } }, 'ghost tiny'),
        ]),
        el('textarea', { class: 'text gm-edit', rows: Math.min(14, 3 + Math.ceil((y.text || '').length / 90)), oninput: (ev) => (y.text = ev.target.value) }, [y.text || '']),
      ])));
      subs.appendChild(button('+ ' + (opts.subLabel || 'Subsection'), () => { d.sections.push({ id: State.genId('gs'), title: '', text: '' }); drawSubs(); }, 'ghost tiny'));
    };
    drawSubs();
    box.appendChild(subs);
    const close = () => { delete editingId[x.id]; opts.redraw(); };
    box.appendChild(el('div', { class: 'chiprow tight' }, [
      button('Save', () => {
        d.title = title.value.trim(); d.text = text.value.replace(/\s+$/, '');
        if (!d.sections.length) delete d.sections;
        const l = all.slice(); l[i] = d; delete editingId[x.id]; opts.save(l);
      }, 'tiny'),
      button('Cancel', close, 'ghost tiny'),
      button('Move up', () => { if (!i) return; const l = all.slice(); l.splice(i - 1, 0, l.splice(i, 1)[0]); opts.save(l); }, 'ghost tiny'),
      button('Move down', () => { if (i >= all.length - 1) return; const l = all.slice(); l.splice(i + 1, 0, l.splice(i, 1)[0]); opts.save(l); }, 'ghost tiny'),
      button('Remove', () => { if (confirm('Remove “' + (x.title || 'this') + '”?')) { delete editingId[x.id]; opts.save(all.filter((_, j) => j !== i)); } }, 'ghost tiny'),
    ]));
    return box;
  }

  // a list of sections, read or edited; `opts.save(list)` stores it
  function sections(container, items, opts) {
    const box = el('div', { class: 'gm-secs' });
    items.forEach((x, i) => box.appendChild(editingId[x.id] && opts.save ? sectionEditor(x, i, items, opts) : sectionView(x, opts)));
    if (opts.save && opts.add !== false) {
      const t = el('input', { class: 'text', type: 'text', placeholder: opts.addLabel || 'Add a section…' });
      box.appendChild(el('div', { class: 'chiprow tight gm-add' }, [t, button('Add', () => {
        if (!t.value.trim()) return;
        const x = Object.assign({ id: State.genId('gs'), title: t.value.trim(), text: '' }, opts.fresh ? opts.fresh() : {});
        editingId[x.id] = true; open[x.id] = true;
        opts.save(items.concat([x]));
      }, 'tiny')]));
    }
    container.appendChild(box);
    return box;
  }

  // a stored list (gm[where]) as a pane body
  function listPane(container, ctx, where, o) {
    const draw = () => {
      container.innerHTML = '';
      if (o && o.head) container.appendChild(o.head());
      const items = list(where);
      if (!items.length && o && o.empty) container.appendChild(el('div', { class: 'empty' }, [o.empty]));
      sections(container, items, Object.assign({ redraw: draw, save: (l) => setList(where, l) }, o || {}));
      if (o && o.tail) container.appendChild(o.tail());
      reveal(container);
    };
    ctx.on('state:changed', () => { if (!editing(container)) draw(); });
    ctx.on('state:remote', () => { if (!editing(container)) draw(); });
    ctx.on('gm:reveal', draw);
    draw();
  }
  // the sections of one list that are about someone (an entity id, a party member's name)
  function aboutSections(where, key, redraw) {
    const items = list(where).filter((x) => (x.about || []).indexOf(key) !== -1);
    if (!items.length) return null;
    const box = el('div', { class: 'gm-about-block' }, [el('div', { class: 'prop-k' }, ['GM notes', el('span', { class: 'muted' }, [' · never sent to players'])])]);
    items.forEach((x) => box.appendChild(sectionView(x, { redraw })));
    return box;
  }

  // ── search across all of it ─────────────────────────────────────────
  const WHERE = { overview: 'overview', places: 'places', people: 'people', pc: 'people', rules: 'overview' };
  function search(q) {
    q = String(q || '').trim().toLowerCase();
    if (q.length < 2) return [];
    const out = [];
    const hit = (pane, pid, id, title, text) => {
      const t = plain(text);
      const at = (title + '\n' + t).toLowerCase().indexOf(q);
      if (at === -1) return;
      const i = Math.max(0, t.toLowerCase().indexOf(q));
      out.push({ pane, id: pid, sub: id !== pid ? id : null, title, snip: (i > 40 ? '…' : '') + t.slice(Math.max(0, i - 40), i + 120).replace(/\s+/g, ' ') });
    };
    const walk = (pane, x) => { hit(pane, x.id, x.id, x.title || '', x.text || ''); (x.sections || []).forEach((y) => hit(pane, x.id, y.id, (x.title || '') + ' › ' + (y.title || ''), y.text || '')); };
    Object.keys(WHERE).forEach((w) => (gm()[w] || []).forEach((x) => walk(WHERE[w], x)));
    (S().threads || []).forEach((x) => { walk('threads', x); if (x.notes) hit('threads', x.id, x.id, (x.title || '') + ' › play notes', x.notes); });
    (S().arc || []).forEach((x) => { hit('scenes', x.id, x.id, x.title || '', [x.summary, x.text].filter(Boolean).join('\n\n')); (x.sections || []).forEach((y) => hit('scenes', x.id, y.id, (x.title || '') + ' › ' + (y.title || ''), y.text || '')); });
    if (gm().threadsNote) hit('threads', 'threads-note', 'threads-note', 'Threads', gm().threadsNote);
    ((gm().questions || {}).items || []).forEach((x) => hit('scenes', 'questions', x.id, 'Questions for the table', x.text));
    if (S().gmNotes) hit('overview', 'free-notes', 'free-notes', 'Free notes', S().gmNotes);
    return out;
  }
  // open the pane holding a hit, unfold it, and bring it into view
  let pending = null;
  function goTo(r) {
    open[r.id] = true;
    if (r.sub) open[r.sub] = true;
    pending = r.sub || r.id;
    if (window.VttApp) window.VttApp.open(r.pane);
    window.VttBus.emit('gm:reveal', r, { local: true });
  }
  function reveal(container) {
    if (!pending) return;
    const n = container.querySelector('[data-gm-id="' + pending.replace(/"/g, '') + '"]');
    if (!n) return;
    pending = null;
    setTimeout(() => { n.scrollIntoView({ block: 'start' }); n.classList.add('gm-flash'); setTimeout(() => n.classList.remove('gm-flash'), 1600); }, 30);
  }

  // a note (one block of text) with its own Edit: gm[key], or any getter/setter pair
  function note(get, set, placeholder, redraw) {
    const box = el('div', { class: 'gm-note' });
    if (editingId['note:' + placeholder]) {
      const t = el('textarea', { class: 'text gm-edit', rows: 4, placeholder }, [get() || '']);
      box.appendChild(t);
      box.appendChild(el('div', { class: 'chiprow tight' }, [button('Save', () => { delete editingId['note:' + placeholder]; set(t.value.replace(/\s+$/, '')); redraw(); }, 'tiny'), button('Cancel', () => { delete editingId['note:' + placeholder]; redraw(); }, 'ghost tiny')]));
    } else {
      if (get()) box.appendChild(render(get()));
      box.appendChild(button(get() ? 'Edit' : placeholder, () => { editingId['note:' + placeholder] = true; redraw(); }, 'ghost tiny'));
    }
    return box;
  }

  return { render, html, inline, plain, list, setList, sections, sectionView, sectionEditor, note, editingId, listPane, aboutSections, search, goTo, reveal, open, editing, TAGS };
})();
