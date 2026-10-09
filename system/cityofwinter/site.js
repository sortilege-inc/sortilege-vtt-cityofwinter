// system/cityofwinter/site.js — what City of Winter puts on the site (engine/site.js): the rules
// as a reader, the atlas, the traditions — the same panels the table shows, since there is
// nothing in this game a player may not read (PLAN.md, D3). Every word is the book's.
window.VttSiteTabs = (function () {
  const Panels = window.VttPanels;
  const { el } = window.VttRender;
  const Sess = () => window.VttSession;
  const paneTab = (id, label, books) => ({
    id, label, books,
    render(main) {
      const ctx = Panels.makeCtx(() => {});
      const body = el('div', { class: 'site-pane site-pane-' + id });
      main.appendChild(body);
      Panels.mount(body, id, ctx);
    },
  });
  const rulesTab = {
    id: 'rules', label: 'Rules', books: true,
    render(main, path, ctx) {
      const host = el('div', { class: 'site-pane site-pane-rules' });
      main.appendChild(host);
      window.CowReader.mount(host, {
        mode: 'site', section: path && path[0],
        href: (s) => ctx.href('rules', [s.slug]),
        onNavigate: (s) => history.replaceState(null, '', ctx.href('rules', [s.slug])),   // the URL follows; no re-render
      });
    },
  };
  return [
    rulesTab,
    paneTab('atlas', 'Atlas', true),
    paneTab('traditions', 'Traditions', true),
  ];
})();
