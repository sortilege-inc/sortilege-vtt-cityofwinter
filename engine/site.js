// engine/site.js — the public face of a deployment: the tabs the system declares
// (window.VttSiteTabs), one hash route per tab (#rules/<book>/<entity>,
// #characters/<adventure>/<template>), and nothing else. This page reads the corpus
// and writes nothing: no campaign, no session — those live under gm/.
(function () {
  const { el } = window.VttRender;
  const CFG = window.VttConfig || {};
  // A tab marked `books` shows the books' own text. On a deployment those tabs are off unless it
  // turns them on (VttConfig.siteBooks) or this browser does (the GM page's Settings pane writes
  // BOOKS_KEY, engine/gm-panes.js) — per browser, never for everyone (PLAYBOOK §4b.4).
  const BOOKS_KEY = (CFG.storagePrefix || 'sortilege-vtt') + ':site-books';
  let booksOn = !!CFG.siteBooks;
  try { const v = localStorage.getItem(BOOKS_KEY); if (v !== null) booksOn = v === '1'; } catch (e) { /* storage off: the deployment's default */ }
  const tabs = (window.VttSiteTabs || []).filter((t) => !t.books || booksOn);
  // With the books off, a link to one entry in them (#book/<book>/#<id>, from a clan, a card, a stat
  // block) still opens that entry: the books' tabs are the shelf, their chapters and search, and
  // only those are closed — never what the other tabs show (owner, 2026-09-25).
  const closedBooks = (window.VttSiteTabs || []).filter((t) => t.books && !booksOn);
  const isEntry = (p) => /^#/.test(p || '');
  // with every tab closed, the site is a page that says so
  if (!tabs.length) tabs.push({ id: 'home', label: CFG.title || 'Home', render: (main) => main.appendChild(el('div', { class: 'site-closed' }, [
    el('h1', {}, [CFG.title || '']),
    el('p', { class: 'muted' }, ['The books are closed on this site. The GM opens them in the GM page’s Settings.']),
  ])) });
  const bar = document.getElementById('site-tabs');
  const main = document.getElementById('site-main');

  function route() {
    const parts = location.hash.replace(/^#/, '').split('/').map((p) => decodeURIComponent(p));
    if (closedBooks.some((t) => t.id === parts[0]) && parts.length > 1 && isEntry(parts[parts.length - 1])) return { id: parts[0], path: parts.slice(1), entry: true };
    const id = tabs.some((t) => t.id === parts[0]) ? parts[0] : (tabs[0] || {}).id;
    return { id, path: parts[0] === id ? parts.slice(1) : [] };
  }

  function go(id, path) {
    location.hash = [id].concat((path || []).map((p) => encodeURIComponent(p))).join('/');
  }

  function href(id, path) {
    return '#' + [id].concat((path || []).map((p) => encodeURIComponent(p))).join('/');
  }

  // whether a tab is open here (a page links to a tab only when it is — the books may be closed)
  const isOpen = (id) => tabs.some((t) => t.id === id);
  const ctx = { go, href, route, isOpen };

  function render() {
    const r = route();
    bar.innerHTML = '';
    tabs.forEach((t) => bar.appendChild(el('a', { class: 'site-tab' + (t.id === r.id ? ' active' : '') + (t.disabled ? ' disabled' : ''), href: href(t.id), title: t.note || null }, [t.label])));
    main.innerHTML = '';
    const t = tabs.find((x) => x.id === r.id) || (r.entry && closedBooks.find((x) => x.id === r.id));
    if (t) t.render(main, r.path, ctx);
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', render);
  window.VttSite = { go, href, route, render };
  render();
})();
