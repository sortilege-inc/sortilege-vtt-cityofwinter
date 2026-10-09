// engine/state.js — one campaign's state in this browser: one localStorage key per
// campaign, every shared change committed as an op (engine/ops.js), and the
// campaign pack (export / import) that makes the campaign an instance outside the
// repo (PLAN.md, goal 3).
//
// State shape (everything under SHARED_KEYS travels to players in a session):
//   campaign  { id, name, system, modules:[bookIds], books:[bookIds] }   what is in play
//   current   { [moduleId]: sceneId }                                   the GM's scene
//   progress  { [moduleId]: { [sceneId]: { done, notes } } }             notes are GM-only
//   clues     { [moduleId]: { "sceneId::clueName": revealed } }
//   party     [ { id, templateId, name, live:{…}, notes, playerNotes } ]
//   maps      { [mapId]: { image, w, h, grid, fog, tokens, effects } }   a shipped map's id, or a scene id
//   table     { map: mapId }                                             what the table is showing
//   order     { scenes: { [moduleId]: [{ name, scenes }] }, cast: { [moduleId]: [ids] } }   the GM's arrangement
//   clocks    [ { id, name, segments, filled, sceneId, visible } ]
//   log       [ { at, kind, text, memberId } ]
//   ui        { … }   per-browser only, never shared, never exported
window.VttState = (function () {
  const Ops = window.VttOps;
  const Bus = window.VttBus;
  const CFG = window.VttConfig || {};
  const PREFIX = (CFG.storagePrefix || 'sortilege-vtt') + ':';
  const LIST_KEY = PREFIX + 'campaigns';
  const PACK_KIND = 'sortilege-vtt-campaign';
  const PACK_VERSION = 1;

  function defaults(id, name) {
    const d = (id === 'default' && CFG.defaultCampaign) || {};
    return {
      campaign: { id, name: name || d.name || id, system: CFG.system || 'teeth', modules: (d.modules || []).slice(), books: (d.books || []).slice() },
      current: {},
      progress: {},
      clues: {},
      party: [],
      maps: {},
      table: {},
      order: {},
      clocks: [],
      log: [],
      ui: {},
    };
  }

  // ── which campaign this browser is on ──────────────────────────────
  function listCampaigns() {
    try {
      return JSON.parse(localStorage.getItem(LIST_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function saveList(list) {
    try {
      localStorage.setItem(LIST_KEY, JSON.stringify(list));
    } catch (e) {
      /* no storage */
    }
  }

  function activeId() {
    const q = new URLSearchParams(location.search).get('campaign');
    if (q) return q;
    const list = listCampaigns();
    const active = list.find((c) => c.active);
    return active ? active.id : list.length ? list[0].id : 'default';
  }

  function genId(prefix) {
    return (prefix || 'id') + '-' + Math.random().toString(36).slice(2, 10);
  }

  let id = activeId();
  let state = load(id);

  function key(cid) {
    return PREFIX + 'campaign:' + cid;
  }

  function load(cid) {
    try {
      const raw = localStorage.getItem(key(cid));
      if (raw) {
        const parsed = JSON.parse(raw);
        return Object.assign(defaults(cid), parsed);
      }
    } catch (e) {
      /* fall through */
    }
    return defaults(cid);
  }

  // Every save tells the other windows what changed — the op itself, or the whole
  // document — never just "re-read storage": a BroadcastChannel message can reach a
  // sibling window before the localStorage write is visible there, and a stale
  // re-read would be written back over the change on that window's next save.
  function save(change) {
    try {
      localStorage.setItem(key(id), JSON.stringify(state));
    } catch (e) {
      /* private window */
    }
    register(state.campaign);
    if (Bus) Bus.emit('state:changed', Object.assign({ at: Date.now(), campaign: id }, change || { doc: snapshot() }));
    autosave(false);
  }

  // Rolling autosaves: a minute apart while anything changes, the last three per campaign,
  // in IndexedDB (localStorage holds only the live copy). Restorable from the Campaign panel.
  const AUTO_EVERY = 60000;
  const AUTO_KEEP = 3;
  let lastAuto = 0;
  function openDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('no IndexedDB'));
      const req = indexedDB.open(PREFIX + 'autosaves', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('packs', { keyPath: 'key' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function autosave(force) {
    if (!force && Date.now() - lastAuto < AUTO_EVERY) return Promise.resolve(false);
    lastAuto = Date.now();
    const at = Date.now();
    const row = { key: id + ':' + at, campaign: id, at, pack: exportPack() };
    return openDb().then((db) => new Promise((resolve) => {
      const tx = db.transaction('packs', 'readwrite');
      const store = tx.objectStore('packs');
      store.put(row);
      const all = store.getAll();
      all.onsuccess = () => {
        const mine = all.result.filter((r) => r.campaign === id).sort((a, b) => b.at - a.at);
        mine.slice(AUTO_KEEP).forEach((r) => store.delete(r.key));
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    })).catch(() => false);
  }
  function listAutosaves() {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const req = db.transaction('packs').objectStore('packs').getAll();
      req.onsuccess = () => resolve(req.result.filter((r) => r.campaign === id).sort((a, b) => b.at - a.at));
      req.onerror = () => reject(req.error);
    }));
  }
  function restoreAutosave(key) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const req = db.transaction('packs').objectStore('packs').get(key);
      req.onsuccess = () => {
        if (!req.result) return reject(new Error('no such autosave'));
        importPack(req.result.pack);
        resolve(true);
      };
      req.onerror = () => reject(req.error);
    }));
  }

  function snapshot() {
    const out = {};
    Object.keys(state).forEach((k) => {
      if (k !== 'ui') out[k] = state[k];
    });
    return out;
  }

  function register(campaign) {
    const list = listCampaigns();
    let row = list.find((c) => c.id === campaign.id);
    if (!row) {
      row = { id: campaign.id };
      list.push(row);
    }
    row.name = campaign.name;
    row.modules = campaign.modules;
    list.forEach((c) => (c.active = c.id === id));
    saveList(list);
  }

  function reload() {
    const fresh = load(id);
    Object.keys(state).forEach((k) => delete state[k]);
    Object.assign(state, fresh);
  }

  if (Bus) {
    Bus.on('state:changed', (payload, meta) => {
      if (!(meta && meta.remote) || !payload || payload.campaign !== id) return;
      if (payload.op) {
        try {
          Ops.apply(state, payload.op.name, payload.op.args);   // deterministic: same op, same result
        } catch (e) {
          reload();
        }
      } else if (payload.doc) {
        Object.keys(state).forEach((k) => {
          if (k !== 'ui') delete state[k];
        });
        Object.assign(state, payload.doc);
      } else reload();
    });
  }

  // ── ops ────────────────────────────────────────────────────────────
  // Undo is per window and covers this window's own commits (what came in from elsewhere is
  // someone else's to undo): the inverse op is computed before the op is applied and kept on
  // a stack; undoing commits the inverse like any other op, so every window and the room follow.
  const undoStack = [];
  const redoStack = [];
  const HISTORY = 30;

  function commit(name, args, opts) {
    const inv = Ops.inverse ? Ops.inverse(state, name, args) : null;
    Ops.apply(state, name, args);
    save({ op: { name, args } });
    if (Bus) Bus.emit('op', { name, args, at: Date.now() });
    if (inv && !(opts && opts.noHistory)) {
      undoStack.push({ name, args: JSON.parse(JSON.stringify(args || [])), inv });
      if (undoStack.length > HISTORY) undoStack.shift();
      redoStack.length = 0;
      if (Bus) Bus.emit('history', { undo: undoStack.length, redo: redoStack.length }, { local: true });
    }
  }

  function undo() {
    const e = undoStack.pop();
    if (!e) return false;
    commit(e.inv.name, e.inv.args, { noHistory: true });
    redoStack.push({ name: e.name, args: e.args });
    if (Bus) Bus.emit('history', { undo: undoStack.length, redo: redoStack.length }, { local: true });
    return true;
  }

  function redo() {
    const r = redoStack.pop();
    if (!r) return false;
    const inv = Ops.inverse ? Ops.inverse(state, r.name, r.args) : null;
    commit(r.name, r.args, { noHistory: true });
    if (inv) undoStack.push({ name: r.name, args: r.args, inv });
    if (Bus) Bus.emit('history', { undo: undoStack.length, redo: redoStack.length }, { local: true });
    return true;
  }

  function history() {
    return { undo: undoStack.length, redo: redoStack.length, last: undoStack.length ? undoStack[undoStack.length - 1].name : null };
  }

  function applyRemote(name, args) {
    Ops.apply(state, name, args);
    save({ op: { name, args } });
    if (Bus) Bus.emit('state:remote', { name, args }, { local: true });
  }

  function replaceShared(doc) {
    Ops.SHARED_KEYS.forEach((k) => {
      if (doc[k] != null) state[k] = doc[k];
    });
    save();
  }

  // ── per-browser ui prefs (never shared) ────────────────────────────
  function ui(k, v) {
    if (v === undefined) return (state.ui || {})[k];
    if (!state.ui) state.ui = {};
    state.ui[k] = v;
    save();
    return v;
  }

  // ── campaigns ──────────────────────────────────────────────────────
  function switchTo(cid) {
    id = cid;
    reload();
    register(state.campaign);
    save();
  }

  function create(name, patch) {
    const cid = genId('c');
    id = cid;
    state = Object.assign(defaults(cid, name), patch || {});
    state.campaign.id = cid;
    state.campaign.name = name;
    save();
    return cid;
  }

  function remove(cid) {
    try {
      localStorage.removeItem(key(cid));
    } catch (e) {
      /* ignore */
    }
    saveList(listCampaigns().filter((c) => c.id !== cid));
    if (cid === id) {
      const list = listCampaigns();
      switchTo(list.length ? list[0].id : 'default');
    }
  }

  // ── the campaign pack ──────────────────────────────────────────────
  function exportPack() {
    const out = { kind: PACK_KIND, version: PACK_VERSION, exportedAt: new Date().toISOString() };
    Object.keys(state).forEach((k) => {
      if (k !== 'ui') out[k] = state[k];
    });
    return out;
  }

  function importPack(pack, opts) {
    if (!pack || pack.kind !== PACK_KIND) throw new Error('Not a campaign pack (kind ' + (pack && pack.kind) + ').');
    if (pack.version > PACK_VERSION) throw new Error('This pack was saved by a newer build (version ' + pack.version + ').');
    const cid = (opts && opts.asNew) ? genId('c') : pack.campaign && pack.campaign.id ? pack.campaign.id : genId('c');
    id = cid;
    state = defaults(cid, pack.campaign && pack.campaign.name);
    Object.keys(pack).forEach((k) => {
      if (['kind', 'version', 'exportedAt', 'ui'].indexOf(k) === -1) state[k] = pack[k];
    });
    state.campaign = Object.assign(state.campaign, pack.campaign || {}, { id: cid });
    save();
    return cid;
  }

  function downloadPack(filename) {
    const pack = exportPack();
    const blob = new Blob([JSON.stringify(pack, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const stamp = pack.exportedAt.slice(0, 19).replace(/[:T]/g, '-');
    a.download = filename || `${(state.campaign.name || 'campaign').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 0);
  }

  // ── the instance's seed ────────────────────────────────────────────
  // VttConfig.defaultCampaign.seed names a pack file. What the deployment's own campaign (the default
  // one, or one under its name) has never had is filled from it: a whole key; an entry of a list
  // (matched by id), placed after the entry it follows in the pack; a field of an entry or object.
  // Nothing the GM has set — even to nothing — is touched, and an entry the GM removed stays
  // removed: every id the seed has offered is remembered in `seeded`. Resolves to the keys it changed.
  // (Ported from sortilege-vtt-l5r5e, I19.)
  function seed() {
    const d = (window.VttConfig || {}).defaultCampaign || {};
    if (!d.seed || !(id === 'default' || state.campaign.name === d.name)) return Promise.resolve([]);
    return fetch(d.seed, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(d.seed + ': ' + r.status))))
      .then((pack) => {
        if (!pack || pack.kind !== PACK_KIND) throw new Error(d.seed + ' is not a campaign pack');
        if (typeof renameIds === 'function') renameIds(pack);
        const offered = new Set(state.seeded || []);
        const had = offered.size;
        const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
        const keyed = (l) => Array.isArray(l) && l.length && l.every((x) => isObj(x) && x.id);
        const remember = (v) => {
          if (Array.isArray(v)) v.forEach(remember);
          else if (isObj(v)) { if (v.id) offered.add(v.id); Object.keys(v).forEach((k) => remember(v[k])); }
        };
        const fill = (cur, src) => {
          let changed = false;
          if (keyed(src) && Array.isArray(cur)) {
            src.forEach((x, i) => {
              const at = cur.findIndex((y) => y && y.id === x.id);
              if (at !== -1) { changed = fill(cur[at], x) || changed; return; }
              if (offered.has(x.id)) return;
              const prev = i ? cur.findIndex((y) => y && y.id === src[i - 1].id) : -1;
              cur.splice(prev === -1 ? cur.length : prev + 1, 0, JSON.parse(JSON.stringify(x)));
              changed = true;
            });
          } else if (isObj(src) && isObj(cur)) {
            Object.keys(src).forEach((k) => {
              if (cur[k] === undefined) { cur[k] = JSON.parse(JSON.stringify(src[k])); changed = true; }
              else changed = fill(cur[k], src[k]) || changed;
            });
          }
          return changed;
        };
        const keys = Object.keys(pack).filter((k) => ['kind', 'version', 'exportedAt', 'ui', 'campaign', 'seeded'].indexOf(k) === -1).filter((k) => {
          if (state[k] === undefined) { state[k] = pack[k]; return true; }
          return fill(state[k], pack[k]);
        });
        remember(Object.keys(pack).filter((k) => ['ui', 'campaign'].indexOf(k) === -1).map((k) => pack[k]));
        if (keys.length || offered.size !== had) { state.seeded = Array.from(offered); save(); }
        return keys;
      });
  }

  return {
    get state() { return state; },
    get id() { return id; },
    commit, seed, applyRemote, replaceShared, save, reload, ui, genId,
    listCampaigns, switchTo, create, remove,
    exportPack, importPack, downloadPack, PACK_KIND, PACK_VERSION,
    undo, redo, history, autosave, listAutosaves, restoreAutosave,
  };
})();
