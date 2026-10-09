// engine/session.js — the session socket, for the GM's page and the player's.
//
// One window per browser holds the socket (the one that called start() or join());
// the other windows on that machine (the table, a player's map view) ride the bus.
//   local op committed here ........ send to the room
//   op from another window (bus) .. forward to the room
//   op from the room .............. State.applyRemote (saves → every window redraws)
//   events (roll, ping, select, scene:changed) go both ways the same way
// The room's document is authoritative once it exists: on connect the client takes
// the snapshot, and only seeds it when the room is empty. The room outlives the
// evening: it is the campaign's live document until the GM ends it or it idles out
// (14 days); the campaign pack is the durable record (PLAN.md).
window.VttSession = (function () {
  const CFG = window.VttConfig || {};
  const KEY = (CFG.storagePrefix || 'sortilege-vtt') + ':session';
  const State = window.VttState;
  const Bus = window.VttBus;
  const Ops = window.VttOps;
  const EVENTS = ['roll', 'ping', 'select', 'scene:changed', 'arm'];   // arm: a modifier for other sheets' next roll (an ability for every player)

  let info = load();       // { role, code, token, memberId, base, campaign }
  let ws = null;
  let status = 'offline';  // offline | connecting | online
  let receiving = false;
  let retry = null;
  let failures = 0;
  let claims = {};         // memberId -> { name }
  const listeners = [];

  function load() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  function persist() {
    try {
      if (info) localStorage.setItem(KEY, JSON.stringify(info));
      else localStorage.removeItem(KEY);
    } catch (e) {
      /* no storage */
    }
  }

  function configured() {
    return !!CFG.workerUrl;
  }

  function setStatus(s) {
    status = s;
    notify();
  }

  function notify() {
    listeners.forEach((fn) => {
      try {
        fn(current());
      } catch (e) {
        console.error(e);
      }
    });
  }

  function onChange(fn) {
    listeners.push(fn);
    return () => listeners.splice(listeners.indexOf(fn), 1);
  }

  function current() {
    return { status, info: info ? Object.assign({}, info) : null, claims: Object.assign({}, claims), active: !!info, connected: status === 'online', configured: configured() };
  }

  function memberId() {
    return info && info.role === 'player' ? info.memberId || null : null;
  }

  function role() {
    return info ? info.role : null;
  }

  function base() {
    return (info && info.base) || CFG.workerUrl;
  }

  function joinUrl() {
    if (!info) return null;
    const u = new URL((CFG.pages && CFG.pages.play) || 'play.html', document.baseURI);
    u.searchParams.set('s', info.code);
    return u.toString();
  }

  // ── lifecycle ──────────────────────────────────────────────────────
  async function start() {
    if (!configured()) throw new Error('No Worker URL configured (engine/config.js).');
    const res = await fetch(CFG.workerUrl + '/session', { method: 'POST' });
    if (!res.ok) throw new Error('Could not create a session (HTTP ' + res.status + ').');
    const body = await res.json();
    info = { role: 'gm', code: body.code, token: body.gmToken, base: CFG.workerUrl, campaign: State.id, startedAt: Date.now() };
    persist();
    connect();
    return current();
  }

  function join(code, token) {
    info = { role: 'player', code: String(code).toUpperCase(), token: token || null, memberId: null, base: CFG.workerUrl, startedAt: Date.now() };
    persist();
    connect();
  }

  function leave() {
    if (retry) clearTimeout(retry);
    retry = null;
    if (ws) {
      const w = ws;
      ws = null;
      w.close();
    }
    info = null;
    claims = {};
    persist();
    setStatus('offline');
  }

  function connect() {
    if (!info) return;
    if (ws) {
      const w = ws;
      ws = null;
      w.close();
    }
    setStatus('connecting');
    const url = new URL(base().replace(/^http/, 'ws') + '/session/' + encodeURIComponent(info.code) + '/ws');
    if (info.token) url.searchParams.set('token', info.token);
    const sock = new WebSocket(url.toString());
    ws = sock;
    sock.onopen = () => send({ type: 'hello' });
    sock.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      handle(msg);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      setStatus('offline');
      failures += 1;
      const delay = Math.min(60000, 2500 * Math.pow(2, Math.min(failures - 1, 5)));
      if (info) retry = setTimeout(connect, delay);
    };
    sock.onerror = () => {};
  }

  // what the room says about itself: { exists, createdAt, lastActive } (the Worker's GET)
  async function roomInfo() {
    if (!info) return null;
    const res = await fetch(base() + '/session/' + encodeURIComponent(info.code));
    if (!res.ok) return null;
    return res.json();
  }

  // the player's "Retry now": drop the backoff and connect again
  function reconnect() {
    if (!info) return;
    if (retry) clearTimeout(retry);
    retry = null;
    failures = 0;
    connect();
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  // ── incoming ───────────────────────────────────────────────────────
  function handle(msg) {
    switch (msg.type) {
      case 'snapshot': {
        if (msg.role) info.role = msg.role;
        if (msg.memberId !== undefined) info.memberId = msg.memberId;
        if (msg.token && !info.token) info.token = msg.token;
        claims = msg.claims || {};
        persist();
        if (msg.doc) {
          receiving = true;
          State.replaceShared(msg.doc);
          receiving = false;
          Bus.emit('state:remote', { snapshot: true }, { local: true });
        } else if (info.role === 'gm') {
          send({ type: 'init', doc: Ops.sharedSlice(State.state) });
        }
        failures = 0;
        setStatus('online');
        break;
      }
      case 'op':
        receiving = true;
        try {
          State.applyRemote(msg.name, msg.args);
        } finally {
          receiving = false;
        }
        break;
      case 'event':
        receiving = true;
        try {
          Bus.emit(msg.name, msg.payload);
        } finally {
          receiving = false;
        }
        break;
      case 'claims':
        claims = msg.claims || {};
        notify();
        break;
      case 'claimed':
        info.memberId = msg.memberId;
        if (msg.token) info.token = msg.token;
        persist();
        notify();
        break;
      case 'error':
        console.warn('session:', msg.message);
        if (msg.fatal) leave();
        Bus.emit('session:error', { message: msg.message }, { local: true });
        break;
      default:
        break;
    }
  }

  // ── outgoing ───────────────────────────────────────────────────────
  Bus.on('op', (p) => {
    if (!ws || receiving || !p || !Ops.OPS[p.name] || (Ops.LOCAL && Ops.LOCAL[p.name])) return;   // the GM's own keys stay here
    send({ type: 'op', name: p.name, args: p.args });
  });

  EVENTS.forEach((name) => {
    Bus.on(name, (payload) => {
      if (!ws || receiving) return;
      send({ type: 'event', name, payload });
    });
  });

  function claim(id) {
    send({ type: 'claim', memberId: id });
  }

  function unclaim(id) {
    send({ type: 'unclaim', memberId: id });
  }

  // Seed the room from this browser's state (GM, explicit — e.g. after restoring a pack).
  function reseed() {
    if (!info || info.role !== 'gm') return;
    send({ type: 'init', doc: Ops.sharedSlice(State.state), force: true });
  }

  if (info) connect();

  return { start, join, leave, reconnect, roomInfo, claim, unclaim, reseed, current, onChange, joinUrl, memberId, role, configured };
})();
