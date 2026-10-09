// system/cityofwinter/reader.js — the rules as the book lays them out.
//
// One section at a time, in the book's order, with its page number: the contents on the left
// (the site) or behind a Contents button (a panel), search that lists where a phrase occurs and
// marks it on the page, and ← prev · next → at the foot. The same reader serves the facilitator's
// Rules & Books panel, the player's page and the site; the stage cites into it ("Tradition
// Scene · p. 21"). Every word shown is the corpus's — CowData.outline() places it, this file only
// draws it.
window.CowReader = (function () {
  const UI = window.CowUI;
  const { el, add, clear, ruleText, details, miniMarkdown } = UI;
  const D = window.CowData;
  const Bus = window.VttBus;

  let pending = null;                      // { section, term } waiting for a reader to draw
  const views = new Set();                 // mounted readers, to retarget

  /* ------------------------------------------------------------------ items */

  const pageTag = (p) => (p ? el('span', { class: 'pg', text: `p. ${p}` }) : null);

  function stepBody(st, depth) {
    const box = el('div', { class: `rstep d${depth || 0}` });
    add(box, el('h4', {}, st.n != null ? el('span', { class: 'n', text: st.n }) : null, st.name));
    if (st.instruction) add(box, ruleText(st.instruction, { cls: 'instr' }));
    if (st.teaching) add(box, ruleText(st.teaching, { cls: 'teach aloud' }));
    if (st.followUp) add(box, ruleText(st.followUp, { cls: 'instr' }));
    if (st.teachingTwo) add(box, ruleText(st.teachingTwo, { cls: 'teach aloud' }));
    if (st.options) add(box, el('div', { class: 'roptions' }, st.options.map((o) => el('div', { class: 'roption' }, el('h5', { text: o.name }), ruleText(o.instruction, { cls: 'instr' })))));
    if (st.substeps) add(box, st.substeps.map((s) => stepBody(s, (depth || 0) + 1)));
    return box;
  }

  function itemEl(it, section) {
    const box = el('section', { class: `ritem ritem-${it.kind}`, id: 'r-' + D.slug(it.name) });
    // an item that carries the section's own title (Tradition Scene, Birth…) is the section: no second heading
    const same = section && it.name === section.title;
    const head = (label) => (same ? (label ? el('div', { class: 'kind', text: label }) : null) : el('h3', {}, el('span', { class: 'nm', text: it.name }), label ? el('span', { class: 'kind', text: label }) : null, pageTag(it.page)));
    switch (it.kind) {
      case 'procedure': {
        const p = it.data;
        add(box, head('Procedure'));
        if (p.instruction) add(box, ruleText(p.instruction, { cls: 'instr' }));
        add(box, p.steps.map((s) => stepBody(s, 0)));
        break;
      }
      case 'step':
        add(box, el('div', { class: 'small muted', text: `Step ${it.data.n} of ${it.proc.name}` }), stepBody(it.data, 0));
        break;
      case 'rule':
      case 'concept':
        add(box, head(it.kind === 'concept' ? 'Term' : null), ruleText(it.data.text, { cls: 'instr' }));
        break;
      case 'optional':
        add(box, head('Optional rule'), it.data.optionalText ? ruleText(it.data.optionalText, { cls: 'teach' }) : null, ruleText(it.data.text, { cls: 'instr' }));
        break;
      case 'solo':
        add(box, head('Solo Play'), ruleText(it.data.text, { cls: 'instr' }));
        break;
      case 'lore':
        add(box, el('div', { class: 'lore', html: miniMarkdown(it.data.markdown.replace(/^# .*\n/, '')) }));
        break;
      case 'sidebar':
        add(box, el('div', { class: 'eyebrow', text: 'Sidebar' }), it.data.concerns.length ? el('div', { class: 'small muted', text: 'On ' + it.data.concerns.join(', ') }) : null, ruleText(it.data.text, { cls: 'instr' }));
        break;
      default:
        break;
    }
    return box;
  }

  /* ------------------------------------------------------------------ search */

  function textOf(it) {
    const d = it.data || {};
    const steps = (ss) => (ss || []).map((s) => [s.name, s.instruction, s.teaching, s.followUp, s.teachingTwo, (s.options || []).map((o) => o.name + '\n' + o.instruction).join('\n'), steps(s.substeps)].filter(Boolean).join('\n')).join('\n');
    return [it.name, d.instruction, d.text, d.optionalText, d.markdown, steps(d.steps), it.kind === 'step' ? steps([d]) : null].filter(Boolean).join('\n');
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function search(q) {
    const t = q.trim().toLowerCase();
    if (t.length < 2) return [];
    const out = [];
    D.outline().forEach((s) => s.items.forEach((it) => {
      const txt = textOf(it);
      const i = txt.toLowerCase().indexOf(t);
      if (i === -1) return;
      const a = Math.max(0, i - 70), b = Math.min(txt.length, i + t.length + 90);
      out.push({ section: s, item: it, snippet: (a ? '…' : '') + txt.slice(a, b).replace(/\s+/g, ' ') + (b < txt.length ? '…' : '') });
    }));
    return out;
  }
  // wrap every match of `term` in the article's text nodes
  function mark(root, term) {
    if (!term || term.trim().length < 2) return;
    const re = new RegExp(esc(term.trim()), 'gi');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((n) => {
      if (!re.test(n.nodeValue)) return;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0, m;
      while ((m = re.exec(n.nodeValue))) {
        frag.append(n.nodeValue.slice(last, m.index), el('mark', { text: m[0] }));
        last = m.index + m[0].length;
      }
      frag.append(n.nodeValue.slice(last));
      n.replaceWith(frag);
    });
  }

  /* ------------------------------------------------------------------ the view */

  // opts: { mode: 'panel' | 'site', section?, term?, onNavigate(section) }
  function mount(container, opts) {
    opts = opts || {};
    const secs = D.outline();
    const view = { container, opts, cur: null, term: '', q: '' };
    views.add(view);
    const first = secs.find((s) => s.items.length) || secs[0];
    view.cur = (opts.section && secs.find((s) => s.slug === opts.section || s.title === opts.section)) || (pending && secs.find((s) => s.slug === pending.section || s.title === pending.section)) || first;
    if (pending) { view.term = pending.term || ''; pending = null; }

    const search_ = el('input', { type: 'search', class: 'search', placeholder: 'Search the rules…', 'aria-label': 'Search the rules' });
    const tocBtn = el('button', { class: 'tiny ghost tocbtn', text: 'Contents', 'aria-expanded': 'false' });
    const top = el('div', { class: 'reader-top' }, tocBtn, search_);
    const toc = el('nav', { class: 'reader-toc', 'aria-label': 'Contents' });
    const article = el('article', { class: 'reader-page' });
    const body = el('div', { class: 'reader-body' }, toc, article);
    const root = el('div', { class: `reader reader-${opts.mode || 'panel'}` }, top, body);
    clear(container);
    add(container, root);

    const go = (s, term) => {
      view.cur = s;
      view.term = term || '';
      search_.value = '';
      view.q = '';
      draw();
      if (opts.onNavigate) opts.onNavigate(s);
      const sc = container.closest('.slot-body') || container.closest('.site-main') || window;
      if (sc.scrollTo) sc.scrollTo({ top: 0 });
      root.classList.remove('toc-open');
      tocBtn.setAttribute('aria-expanded', 'false');
    };

    function drawToc() {
      clear(toc);
      add(toc, el('ol', {}, secs.map((s) => el('li', { class: `${s.chapter ? 'chapter' : ''} ${s.numbered ? 'numbered' : ''} ${s === view.cur ? 'on' : ''}`.trim() },
        el('a', { href: opts.href ? opts.href(s) : '#', 'aria-current': s === view.cur ? 'page' : null, onclick: (e) => { e.preventDefault(); go(s); } }, el('span', { class: 'nm', text: s.title }), pageTag(s.page))))));
    }

    function drawPage() {
      clear(article);
      const s = view.cur;
      const i = secs.indexOf(s);
      const crumbs = s.parent ? [s.parent.title] : [];
      add(article, el('header', { class: 'reader-head' }, crumbs.length ? el('div', { class: 'eyebrow', text: crumbs.join(' · ') }) : el('div', { class: 'eyebrow', text: s.chapter ? 'Chapter' : (secs.slice(0, i).reverse().find((x) => x.chapter) || {}).title || '' }),
        el('h2', {}, s.title, pageTag(s.page))));
      if (!s.items.length) {
        // a heading with nothing of its own: the sections under it, as the book's contents do
        const under = secs.filter((x, k) => k > i && !x.chapter && x.page != null && x.page < (secs.slice(i + 1).find((y) => y.chapter) || {}).page);
        add(article, under.length ? el('ol', { class: 'reader-sub' }, under.map((x) => el('li', {}, el('a', { href: '#', onclick: (e) => { e.preventDefault(); go(x); } }, x.title), pageTag(x.page))))
          : el('p', { class: 'muted', text: 'This heading has no text of its own in the corpus.' }));
      } else add(article, s.items.map((it) => itemEl(it, s)));
      const prev = secs[i - 1], next = secs[i + 1];
      add(article, el('footer', { class: 'reader-foot' },
        prev ? el('button', { class: 'ghost tiny', onclick: () => go(prev) }, `← ${prev.title}`) : el('span'),
        el('span', { class: 'grow' }),
        next ? el('button', { class: 'ghost tiny', onclick: () => go(next) }, `${next.title} →`) : null));
      if (view.term) mark(article, view.term);
    }

    function drawResults() {
      clear(article);
      const hits = search(view.q);
      add(article, el('header', { class: 'reader-head' }, el('div', { class: 'eyebrow', text: 'Search' }), el('h2', {}, `“${view.q.trim()}”`, el('span', { class: 'pg', text: `${hits.length} ${hits.length === 1 ? 'place' : 'places'}` }))));
      if (!hits.length) add(article, el('p', { class: 'muted', text: 'Nothing in the rules says that.' }));
      add(article, el('ol', { class: 'reader-hits' }, hits.map((h) => el('li', {},
        el('button', { type: 'button', class: 'hit', onclick: () => go(h.section, view.q) },
          el('span', { class: 'where' }, el('b', { text: h.item.name }), el('span', { class: 'muted', text: ` · ${h.section.title}` }), pageTag(h.item.page || h.section.page)),
          el('span', { class: 'snip', text: h.snippet }))))));
      mark(article, view.q);
    }

    function draw() {
      drawToc();
      if (view.q.trim().length >= 2) drawResults();
      else drawPage();
    }
    search_.addEventListener('input', () => { view.q = search_.value; draw(); });
    tocBtn.addEventListener('click', () => { const on = root.classList.toggle('toc-open'); tocBtn.setAttribute('aria-expanded', String(on)); });
    view.go = go;
    view.draw = draw;
    draw();
    return { go, destroy() { views.delete(view); } };
  }

  // Open the reader at a section (by title or slug), optionally marking a term. On the
  // facilitator's page this opens the Rules & Books panel; on the site it routes.
  function open(target, term) {
    const loc = D.locate(target);
    const section = loc ? loc.section.slug : target;
    if (window.VttSite) { window.VttSite.go('rules', [section]); return; }
    let hit = false;
    views.forEach((v) => { if (document.body.contains(v.container)) { const s = D.outline().find((x) => x.slug === section); if (s) { v.go(s, term); hit = true; } } });
    if (hit) return;
    pending = { section, term };
    if (window.VttApp) window.VttApp.open('rules');
    else Bus.emit('cow:reader', pending, { local: true });
  }

  // a chip that cites the book: "Tradition Scene · p. 21", opening the reader there
  function cite(name, label) {
    const loc = D.locate(name);
    if (!loc) return null;
    return el('button', { type: 'button', class: 'cite', title: `Open the rules at ${loc.section.title}`, onclick: () => open(name) },
      el('span', { class: 'nm', text: label || name }), loc.page ? el('span', { class: 'pg', text: `p. ${loc.page}` }) : null);
  }

  return { mount, open, cite, search };
})();
