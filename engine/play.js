// engine/play.js — the player's page: join a room by code, claim a character, play
// from its sheet. Everything it shows arrives over the session socket into the same
// State the GM's page uses; the sheet itself is the system's (VttSystem.liveSheet).
(function () {
  const { el, button } = window.VttRender;
  const State = window.VttState;
  const Bus = window.VttBus;
  const Session = window.VttSession;
  const Sys = window.VttSystem;
  const CFG = window.VttConfig;

  const main = document.getElementById('play-main');
  const statusEl = document.getElementById('play-status');
  const params = new URLSearchParams(location.search);

  // ── views ──────────────────────────────────────────────────────────
  // Seated, the page is one of three: the sheet full-page (where it starts), the table
  // full-page, or the table with a compact sheet beside it. The table is this site's table
  // page in a frame (the player's view: no controls, fog opaque, their own token theirs to
  // move); the frame is made once and kept, so the view the player set survives switching.
  const MODE_KEY = (CFG.storagePrefix || 'sortilege-vtt') + ':play:mode';
  const MODES = [['sheet', 'Sheet'], ['map', 'Map'], ['split', 'Map + sheet']];
  let mode = (() => {
    try {
      return sessionStorage.getItem(MODE_KEY) || 'sheet';
    } catch (e) {
      return 'sheet';
    }
  })();
  const FEED_KEY = (CFG.storagePrefix || 'sortilege-vtt') + ':play:feed';
  let feedOpen = (() => {
    try {
      return sessionStorage.getItem(FEED_KEY) !== '0';
    } catch (e) {
      return true;
    }
  })();
  const frame = el('iframe', { class: 'play-table', title: 'The table' });
  const tableWrap = el('div', { class: 'play-table-wrap' }, [frame]);
  const bannerEl = el('div', { class: 'play-banner' });
  main.parentNode.insertBefore(bannerEl, main);
  main.parentNode.insertBefore(tableWrap, main.nextSibling);
  function setMode(m) {
    mode = m;
    try {
      sessionStorage.setItem(MODE_KEY, m);
    } catch (e) {
      /* no storage */
    }
    render();
  }
  function applyMode(seated) {
    const m = seated ? mode : 'sheet';
    const was = MODES.find(([k]) => document.body.classList.contains('mode-' + k));
    MODES.forEach(([k]) => document.body.classList.toggle('mode-' + k, m === k));
    if (m !== 'sheet' && !frame.getAttribute('src')) frame.setAttribute('src', CFG.pages.table + '?view=player');
    // the frame's size changed with the view: fit the map to it once the layout has settled
    else if (m !== 'sheet' && (!was || was[0] !== m)) fitFrame();
  }
  function fitFrame() {
    setTimeout(() => {              // a timer, not an animation frame: it fires in a background tab too
      try {
        const t = frame.contentWindow && frame.contentWindow.VttTable;
        if (t) t.fit();
      } catch (e) {
        /* not ours to reach */
      }
    }, 50);
  }
  function modeBar(cls) {
    return el('div', { class: 'mode-bar ' + (cls || '') }, MODES.map(([k, label]) => {
      const b = button(label, () => setMode(k), 'tiny' + (mode === k ? ' active' : ' ghost'));
      b.title = { sheet: 'The character sheet, full page', map: 'The table, full page', split: 'The table, with a compact sheet beside it' }[k];
      return b;
    }));
  }

  function status(s) {
    statusEl.innerHTML = '';
    if (!s.active) {
      statusEl.appendChild(el('span', { class: 'muted' }, ['not in a session']));
      return;
    }
    if (s.info.memberId) statusEl.appendChild(modeBar('in-head'));
    statusEl.appendChild(el('span', { class: 'chip' + (s.connected ? ' on' : '') }, [s.connected ? 'connected' : s.status]));
    statusEl.appendChild(el('span', { class: 'muted' }, [' room ', el('b', {}, [s.info.code])]));
    statusEl.appendChild(button('Leave', () => { Session.leave(); render(); }, 'ghost tiny'));
  }

  // ── bring your own character ───────────────────────────────────────
  // A character file (the site's creator writes one) can be loaded before joining or on the
  // claim screen. It waits here until the room is online, then joins the party and is
  // claimed in one go — and it waits out a reload, in this tab.
  const PENDING_KEY = (CFG.storagePrefix || 'sortilege-vtt') + ':play:pending';
  let pending = (() => {
    try {
      return JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
    } catch (e) {
      return null;
    }
  })();
  function setPending(m) {
    pending = m;
    try {
      if (m) sessionStorage.setItem(PENDING_KEY, JSON.stringify(m));
      else sessionStorage.removeItem(PENDING_KEY);
    } catch (e) {
      /* no storage */
    }
  }
  function seatPending() {
    const s = Session.current();
    if (!pending || !s.active || !s.connected || s.info.memberId) return false;
    const m = pending;
    setPending(null);
    State.commit('addPartyMember', [m]);
    Session.claim(m.id);
    return true;
  }
  function characterLoader(note) {
    const file = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
    const msg = el('div', { class: 'muted' }, [pending ? `${pending.name} is ready — they take their seat when you join.` : '']);
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      f.text().then((text) => {
        const m = Sys.readCharacter(JSON.parse(text), f.name);
        setPending(m);
        if (!seatPending()) msg.textContent = `${m.name} is ready — they take their seat when you join.`;
        else msg.textContent = `${m.name} is at the table.`;
      }).catch((e) => (msg.textContent = e.message)).finally(() => (file.value = ''));
    });
    return el('div', {}, [
      el('div', { class: 'chiprow' }, [button(pending ? 'Load a different character file…' : 'Load my character file…', () => file.click(), 'ghost'), el('span', { class: 'muted' }, [note]), file]),
      msg,
    ]);
  }

  function joinScreen() {
    const code = el('input', { type: 'text', class: 'text code-input', placeholder: 'Room code', maxlength: '8', autocapitalize: 'characters', value: (params.get('s') || '').toUpperCase() });
    const msg = el('div', { class: 'muted' });
    const go = button('Join', () => {
      const c = code.value.trim().toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(c)) {
        msg.textContent = 'That doesn’t look like a room code.';
        return;
      }
      Session.join(c);
      render();
    });
    return el('div', { class: 'play-card' }, [
      el('h1', {}, ['Join the table']),
      el('p', {}, ['Your ' + (CFG.roleName || 'GM') + ' gave you a room code. Enter it to claim your character — or bring the one you made.']),
      el('div', { class: 'chiprow' }, [code, go]),
      msg,
      Sys.joinForm ? null : characterLoader('made on the site’s character creator; it joins the party when you do'),
      Session.configured() ? null : el('div', { class: 'muted' }, ['Sessions aren’t configured on this deployment yet.']),
    ]);
  }

  function claimScreen(s) {
    const party = State.state.party || [];
    const cards = party.map((m) => {
      const claimed = s.claims[m.id];
      const b = button(claimed ? `Claimed by ${claimed.name}` : 'Claim', () => Session.claim(m.id), claimed ? 'ghost' : '');
      b.disabled = !!claimed;
      return el('div', { class: 'card static' }, [el('div', { class: 'card-name' }, [m.name]), el('div', { class: 'card-sub' }, [Sys.memberSubtitle(m)]), b]);
    });
    return el('div', { class: 'play-card' }, [
      el('h1', {}, ['Who are you?']),
      party.length ? el('div', { class: 'cards' }, cards) : el('p', { class: 'muted' }, [s.connected ? 'The ' + (CFG.roleName || 'GM') + ' hasn’t added any characters yet.' : 'Connecting…']),
      Sys.joinForm ? Sys.joinForm(s) : null,   // a system that lets you add yourself to the party (City of Winter: the family)
      Sys.joinForm ? null : characterLoader('made on the site’s character creator'),
    ]);
  }

  function sheetScreen(s) {
    const m = (State.state.party || []).find((x) => x.id === s.info.memberId);
    if (!m) return el('div', { class: 'play-card' }, [el('p', { class: 'muted' }, ['Your character isn’t in the party any more.'])]);
    const split = mode === 'split';
    const bar = split
      ? el('div', { class: 'chiprow play-bar' }, [
        button('Expand the sheet', () => setMode('sheet'), 'ghost tiny'),
        button('Map only', () => setMode('map'), 'ghost tiny'),
      ])
      : el('div', { class: 'chiprow play-bar' }, [
        button('Map', () => setMode('map'), ''),
        button('Map + sheet', () => setMode('split'), ''),
        el('a', { class: 'btn ghost', href: CFG.pages.table + '?view=player', target: (CFG.channel || 'vtt') + '-player' }, ['Table in its own tab']),
        button('Download my character', () => Sys.downloadCharacter(m), 'ghost'),   // as played, right now — the file the join screen takes back
        button('Release character', () => Session.unclaim(m.id), 'ghost'),
      ]);
    // everyone's rolls and named actions, newest first — the GM's log as the room shares it
    const feedItems = (State.state.log || []).slice(split ? -30 : -10).reverse();
    const feed = el('section', { class: 'table-feed' }, [
      el('h4', {}, ['At the table', el('span', { class: 'muted' }, [feedItems.length ? '' : ' · nothing rolled yet'])]),
      el('div', { class: 'roll-log' }, feedItems.map((x) => x.kind === 'roll' && Sys.rollLine ? Sys.rollLine(x) : el('div', { class: 'roll-line' + (x.kind === 'roll' ? '' : ' action') }, [x.text || `${x.who || ''} · ${x.axis || ''} ${x.band || ''}`.trim()]))),
    ]);
    const clocks = (State.state.clocks || []).filter((c) => c.visible !== false);
    const strip = clocks.length ? el('div', { class: 'clock-strip' }, clocks.map((c) => el('div', { class: 'clock-row' }, [el('div', { class: 'track-head' }, [el('span', { class: 'track-name' }, [c.name]), el('span', { class: 'muted' }, [`${c.filled} / ${c.segments}`])]), el('div', { class: 'boxes clock' }, Array.from({ length: c.segments }, (_, i) => el('span', { class: 'box' + (i < c.filled ? ' on' : '') })))]))) : null;
    // full page: the feed in its own column on the right; beside the map: the sheet above, the
    // rolls in a pane of their own below (the bottom third), each with its own scroll
    if (split) {
      const toggle = button(feedOpen ? 'hide' : 'show', () => { feedOpen = !feedOpen; try { sessionStorage.setItem(FEED_KEY, feedOpen ? '1' : '0'); } catch (e) { /* no storage */ } render(); }, 'ghost tiny');
      const pane = el('section', { class: 'feed-pane' + (feedOpen ? '' : ' closed') }, [
        el('div', { class: 'feed-pane-head' }, [el('h4', {}, ['At the table', el('span', { class: 'muted' }, [feedItems.length ? ` · ${feedItems.length}` : ' · nothing rolled yet'])]), toggle]),
        feedOpen ? el('div', { class: 'feed-pane-body' }, [el('div', { class: 'roll-log' }, feedItems.map((x) => x.kind === 'roll' && Sys.rollLine ? Sys.rollLine(x) : el('div', { class: 'roll-line' + (x.kind === 'roll' ? '' : ' action') }, [x.text || `${x.who || ''} · ${x.axis || ''} ${x.band || ''}`.trim()])))]) : null,
      ]);
      return el('div', { class: 'play-card wide compact split-panes' }, [el('div', { class: 'sheet-pane' }, [bar, Sys.liveSheet(m, { player: true, compact: true })]), pane]);   // the clocks are on the map beside it
    }
    return el('div', { class: 'play-card wide with-feed' }, [el('div', { class: 'sheet-col' }, [bar, strip, Sys.liveSheet(m, { player: true })]), el('aside', { class: 'feed-col' }, [feed])]);
  }

  function render() {
    const s = Session.current();
    status(s);
    applyMode(s.active && !!s.info.memberId);
    bannerEl.innerHTML = '';
    if (s.active && !s.connected) {
      bannerEl.appendChild(el('div', { class: 'banner warn' }, [
        el('b', {}, [s.status === 'connecting' ? 'Connecting to the table…' : 'Lost the table — reconnecting…']),
        ' What you change now reaches the ' + (CFG.roleName || 'GM') + ' when the connection is back. ',
        button('Retry now', () => Session.reconnect(), 'ghost tiny'),
      ]));
    }
    if (document.activeElement && /TEXTAREA|INPUT/.test(document.activeElement.tagName) && main.contains(document.activeElement)) return;
    main.innerHTML = '';
    if (!s.active) main.appendChild(joinScreen());
    else if (!s.info.memberId) main.appendChild(claimScreen(s));
    else main.appendChild(sheetScreen(s));
  }

  Session.onChange(() => {
    seatPending();     // a character loaded before joining takes its seat once the room is online
    render();
  });
  // the safety cards sit at the bottom right while the player is seated
  function syncCards() {
    const s = Session.current();
    const me = s.active && s.info.memberId ? (State.state.party || []).find((x) => x.id === s.info.memberId) : null;
    if (me && window.VttCards) window.VttCards.dock(() => ({ memberId: me.id, name: me.name }));
    else if (window.VttCards) window.VttCards.undock();
  }
  Session.onChange(syncCards);
  Bus.on('state:changed', syncCards);
  Bus.on('state:remote', syncCards);
  syncCards();
  Bus.on('state:remote', () => render());
  Bus.on('state:changed', () => render());
  Bus.on('session:error', (p) => {
    const note = el('div', { class: 'muted session-error' }, [p.message]);
    main.prepend(note);
    setTimeout(() => note.remove(), 4000);
  });

  document.addEventListener('keydown', (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== 'z' || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    ev.preventDefault();
    if (ev.shiftKey) State.redo();
    else State.undo();
  });

  render();
  // a join link joins its room — also when this tab is still seated in another room from last time
  const linked = (params.get('s') || '').toUpperCase();
  const cur = Session.current();
  if (linked && (!cur.active || (cur.info && cur.info.code !== linked))) {
    if (cur.active) Session.leave();
    Session.join(linked);
    render();
  }
})();
