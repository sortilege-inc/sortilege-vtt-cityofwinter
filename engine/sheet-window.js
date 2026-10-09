// engine/sheet-window.js — one party member's sheet in its own window (gm/sheet.html?member=<id>),
// for a second screen. The GM's view of the sheet on the same state as the GM page; changes
// travel over the bus like any other window's. Right-click a party card to open one.
(function () {
  const { el } = window.VttRender;
  const State = window.VttState;
  const Bus = window.VttBus;
  const Sys = window.VttSystem;
  const CFG = window.VttConfig || {};
  const brand = CFG.title || 'Sheet';
  document.querySelectorAll('.brand-title').forEach((n) => (n.textContent = brand));
  const main = document.getElementById('sheet-main');
  const status = document.getElementById('sheet-status');
  const id = new URLSearchParams(location.search).get('member');

  function render() {
    if (document.activeElement && /TEXTAREA|INPUT/.test(document.activeElement.tagName) && main.contains(document.activeElement)) return;
    const m = (State.state.party || []).find((x) => x.id === id);
    main.innerHTML = '';
    status.textContent = m ? State.state.campaign.name || '' : '';
    if (!m) {
      main.appendChild(el('div', { class: 'play-card' }, [el('p', { class: 'muted' }, ['No such character in the party.'])]));
      document.title = brand + ' — Sheet';
      return;
    }
    document.title = brand + ' — ' + m.name;
    main.appendChild(el('div', { class: 'play-card wide' }, [Sys.liveSheet(m, {})]));
  }
  Bus.on('state:changed', (p, meta) => { if (meta && meta.remote) render(); });
  Bus.on('state:remote', render);
  document.addEventListener('keydown', (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== 'z' || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    ev.preventDefault();
    if (ev.shiftKey) State.redo(); else State.undo();
    render();
  });
  render();
})();
