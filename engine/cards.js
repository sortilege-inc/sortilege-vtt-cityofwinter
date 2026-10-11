// engine/cards.js — safety cards. A player keeps three small cards (green, yellow, red) tucked at the
// bottom right of their page; one click raises that card in the middle of everyone's screen — every
// player's and the GM's — and a click on the raised card puts it away for that person. Players see
// no name on it. The GM's copy says which character raised it (the Worker adds the sender's seat
// for the GM's socket only, so the other players' pages never receive it).
//
//   Bus 'card'  { color, memberId?, name? }   local from the dock (with the seat), or from the room
//   VttCards.dock(seat)   mount the three cards; seat() → { memberId, name } for the one raising
//   VttCards.undock()     take them away (the player left or released)
//   VttCards.show(payload) / VttCards.hide()
window.VttCards = (function () {
  const Bus = window.VttBus;
  const COLORS = [
    { id: 'green', label: 'Green', meaning: 'All good — carry on' },
    { id: 'yellow', label: 'Yellow', meaning: 'Ease off — slow down or steer away' },
    { id: 'red', label: 'Red', meaning: 'Stop — leave this entirely' },
  ];
  let dock = null;
  let overlay = null;
  let seatFn = null;

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => {
      if (k === 'onclick') n.addEventListener('click', attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach((c) => c != null && n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return n;
  }

  function colorOf(id) {
    return COLORS.find((c) => c.id === id) || COLORS[0];
  }

  // the raised card, in the middle of this screen; a click puts it away here
  function show(p) {
    hide();
    const c = colorOf(p && p.color);
    const who = p && p.name ? el('div', { class: 'safety-who' }, [`raised by ${p.name}`]) : null;   // the GM's copy only
    overlay = el('div', { class: 'safety-overlay', role: 'alertdialog', 'aria-label': c.label + ' card', onclick: hide }, [
      el('div', { class: 'safety-card safety-' + c.id }, [el('div', { class: 'safety-card-label' }, [c.label]), el('div', { class: 'safety-card-meaning' }, [c.meaning]), who, el('div', { class: 'safety-card-hint' }, ['click to put it away'])]),
    ]);
    document.body.appendChild(overlay);
  }
  function hide() {
    if (overlay) overlay.remove();
    overlay = null;
  }

  // the three cards, tucked bottom right; a click raises one everywhere
  function mountDock(seat) {
    seatFn = seat;
    if (dock) return dock;
    dock = el('div', { class: 'safety-dock', 'aria-label': 'Safety cards' }, COLORS.map((c) => el('button', {
      class: 'safety-tab safety-' + c.id, type: 'button', title: `${c.label} card — ${c.meaning}. Raises it on every screen; no one is told who.`,
      onclick: () => raise(c.id),
    }, [c.label])));
    document.body.appendChild(dock);
    return dock;
  }
  function undock() {
    if (dock) dock.remove();
    dock = null;
    seatFn = null;
  }
  function raise(color) {
    const seat = (seatFn && seatFn()) || {};
    Bus.emit('card', { color, memberId: seat.memberId || null, name: seat.name || null });
  }

  // from the dock here, from another window on this machine, or from the room. Only the GM's pages
  // show the name; a player's own window shows the bare card like everyone else's (the name rides
  // the event for the Worker to pass to the GM alone).
  function isGm() {
    const S = window.VttSession;
    return !!(S && S.role && S.role() === 'gm');
  }
  if (Bus) Bus.on('card', (p) => { if (p && p.color) show(isGm() ? p : { color: p.color }); });

  return { COLORS, dock: mountDock, undock, show, hide, raise };
})();
