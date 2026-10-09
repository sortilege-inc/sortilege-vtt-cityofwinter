// system/cityofwinter/system.js — what City of Winter tells the family's engine: the player's
// page (the whole table, with their seat), a member's subtitle, the character file, and the
// table adapter the map page asks (no shipped maps; the party as tokens).
window.VttSystem = (function () {
  const D = window.CowData;
  const R = window.CowRules;
  const State = window.VttState;
  const S = () => State.state;

  // ── the player's page ────────────────────────────────────────────
  // A seat is a family member. The player's "sheet" is the whole table: the stage, the
  // location, every notecard (theirs marked), the turn order, the decks and the record —
  // City of Winter is played by everyone at once (PLAN.md).
  function liveSheet(m, opts) {
    const P = window.CowPanels;
    const st = P.S();
    P.namesList(st);
    return P.wholeTable(st, opts || {});
  }

  // The claim screen's "add yourself": a player who isn't in the family yet names their
  // character and takes the seat (addMember is a setup op anyone may send before claiming).
  function joinForm(s) {
    const { el, button } = window.VttRender;
    const Session = window.VttSession;
    if (!s || !s.connected) return null;
    const name = el('input', { type: 'text', class: 'text', placeholder: 'your character’s name', autocomplete: 'off' });
    const pron = el('input', { type: 'text', class: 'text', placeholder: 'pronouns (optional)', autocomplete: 'off' });
    const msg = el('div', { class: 'muted' });
    const go = button('Join the family', () => {
      const n = name.value.trim();
      if (!n) { name.focus(); return; }
      if ((S().party || []).some((m) => m.name === n)) { msg.textContent = 'Someone in the family already has that name — claim them above, or choose another.'; return; }
      const id = State.genId('ch');
      State.commit('addMember', [{ id, name: n, pronouns: pron.value.trim(), templateId: (D.named('Main Character') || {}).id, at: Date.now(), who: null }]);
      Session.claim(id);
    }, '');
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
    return el('div', { class: 'join-form' }, [
      el('h2', {}, ['Or add yourself']),
      el('p', { class: 'muted' }, ['Not in the family yet? Name your character; the rest of the notecard — Marks, Bonds, Traditions — is filled in at the table during First Session Setup.']),
      el('div', { class: 'chiprow' }, [name, pron, go]),
      msg,
    ]);
  }

  function memberSubtitle(m) {
    const bits = [];
    if (m.marks !== undefined) bits.push(`${D.tierForMarks(m.marks)} · ${m.marks} Mark${m.marks === 1 ? '' : 's'}`);
    if (m.isMemory) bits.push('a Memory');
    return bits.join(' · ');
  }

  // A notecard as a file (kind sortilege-vtt-character) — a player keeps their own.
  const CHARACTER_KIND = 'sortilege-vtt-character';
  function readCharacter(obj, fileName) {
    if (!obj || obj.kind !== CHARACTER_KIND || !obj.member) throw new Error('Not a character file.');
    const m = Object.assign({}, obj.member, { id: State.genId('ch'), source: { kind: 'file', name: fileName || '', loadedAt: Date.now() } });
    return m;
  }
  function downloadCharacter(m) {
    const out = { kind: CHARACTER_KIND, version: 1, system: 'cityofwinter', exportedAt: new Date().toISOString(), member: Object.assign({}, m, { source: undefined }) };
    const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(m.name || 'character').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.cityofwinter-character.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  // the record line, as the player's page draws it
  function rollLine(entry) {
    const { el } = window.VttRender;
    return el('div', { class: 'roll-line' + (entry.kind === 'roll' ? '' : ' action') }, [entry.text || '']);
  }

  // ── the map table (engine/vtt.js) ────────────────────────────────
  // No maps ship with this VTT (D4): the facilitator may put any image on the table — the
  // library (M4) — and the party stand on it as tokens, each player's their own to move.
  // One scene, "The table": the engine keys a map by its scene, and without one it would never
  // commit the map to the shared state (found at M4: the image showed but never reached a player).
  const TABLE = { id: 'table', name: 'The table', moduleId: null };
  const modules = () => [];
  const scenes = () => [TABLE];
  const pages = () => [];
  const cast = () => [];
  const booksFor = () => ['rules', 'atlas', 'cards'];
  const playBooks = () => ['rules', 'atlas', 'cards'];
  const currentSceneId = () => TABLE.id;
  const maps = () => [];
  const mapDef = () => null;
  const defaultMapId = (sceneId) => sceneId || TABLE.id;
  const legend = () => null;
  const mapAssets = () => [];
  const sceneFigures = () => [];
  const placeTokens = () => ({ mapId: 'table', added: 0 });
  const portrait = () => null;
  function tokenSources() {
    const party = (S().party || []).map((m) => ({ id: 'tk-' + m.id, label: m.name, kind: 'party', owner: m.id, ref: m.id, color: (R.TOKENS.find((t) => t.id === m.token) || {}).color, image: ((window.VttConfig || {}).tokenArt || {})[m.token] || null }));
    const groups = [];
    if (party.length) groups.push({ label: 'The family', items: party });
    groups.push({ label: 'Anyone else', items: [{ label: 'Someone (name them)', kind: 'cast', image: 'assets/tokens/npc.svg', named: true }] });
    return groups;
  }
  const COLORS = { party: '#7fa9c2', cast: '#c1703c', foe: '#2a2a2e', marker: '#6a6862' };
  const tokenColor = (t) => t.color || COLORS[t.kind] || COLORS.marker;
  const tokenPalette = () => R.TOKENS.map((t) => ({ name: t.name, color: t.color }));
  const ICONS = ['person', 'hood', 'helm', 'crown', 'mitre', 'hat', 'skull', 'wolf', 'crow', 'boar', 'hound', 'purse'];
  const tokenIcons = () => ICONS.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1), image: 'assets/tokens/npc/' + id + '.svg' }));
  function tokenStatus(t) {
    if (t.kind !== 'party') return null;
    const m = (S().party || []).find((x) => x.id === t.owner);
    if (!m) return null;
    return { text: `${D.tierForMarks(m.marks)}${m.scene ? ' · ' + m.scene : ''}`, pips: [], cls: '' };
  }
  function selectToken(t) {
    if (t.kind === 'party') window.VttBus.emit('select', { kind: 'party', id: t.owner });
  }
  const tokenMenu = () => null;
  const byId = (id) => D.entity(id);

  return { liveSheet, joinForm, memberSubtitle, readCharacter, downloadCharacter, rollLine, modules, scenes, pages, cast, booksFor, playBooks, currentSceneId, maps, mapDef, defaultMapId, legend, mapAssets, sceneFigures, placeTokens, portrait, tokenSources, tokenColor, tokenPalette, tokenIcons, tokenStatus, selectToken, tokenMenu, byId, MODULE_MAPS: {} };
})();
