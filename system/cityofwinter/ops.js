// system/cityofwinter/ops.js — the game as named ops over the shared document.
//
// Every change to the family's state is one of these, applied identically in every browser and in
// the Worker's room (the family's rule: if it isn't registered, it isn't shared). The rules
// themselves are in rules.js; an op is a rule applied to the state plus the line it writes in the
// record. Rolls and new ids arrive in the args, so applying an op is deterministic.
//
// City of Winter has no GM: every seated player may send every game op — the game is a group
// decision at every step — and the ops of First Session Setup may be sent before a seat is
// claimed (a player adds their own family member and then claims it). The facilitator is the
// family's `gm` role: whoever started the room and holds the pack.
//
// Undo: every op's inverse is a restore of the game and the party as they were (snapshot), which
// the family's per-window undo commits like any other op.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('../../engine/ops.js'), require('./rules.js'));
  else root.CowOps = factory(root.VttOps, root.CowRules);
})(typeof self !== 'undefined' ? self : this, function (Ops, R) {
  const F = R.F;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const card = (id) => R.card(id) || { prompt: '?', deck: '?' };
  const locName = (name) => (name === R.BOROUGH && F.locations[name] && F.locations[name].printedTitle) || name;
  const names = (chs) => chs.map((c) => c.name).join(' & ');

  Ops.shared(['game']);

  /** The record: one line per op, in the family's log (shared, capped by the engine). */
  function line(s, p, text, kind) {
    if (!text) return;
    if (!s.log) s.log = [];
    s.log.push({ at: (p && p.at) || Date.now(), kind: kind || 'action', text, memberId: (p && p.who) || null, ch: s.game.family.chapter });
    if (s.log.length > 500) s.log.splice(0, s.log.length - 500);
  }

  const anyone = () => true;                                    // any seated player
  const UNCLAIMED = { unclaimed: true };                         // before claiming a seat (setup)

  // Register a game op: `fn(st, p, s)` works on the rules' view and returns the record line.
  // The inverse restores the game and the party as they were.
  const GAME_OPS = [];
  function op(name, fn, opts) {
    GAME_OPS.push(name);
    Ops.register(name, (s, p) => {
      const st = R.view(s);
      const text = fn(st, p || {}, s);
      line(s, p, text);
    }, anyone, null, opts || null);
    Ops.inverseOf(name, (s) => ['restoreGame', [{ game: clone(s.game || null), party: clone(s.party || []) }]]);
  }

  // the restore: the game and the party as they were; the record keeps the undone line, marked
  Ops.register('restoreGame', (s, p) => {
    const last = (s.log || []).slice(-1)[0];
    if (p.game) s.game = clone(p.game);
    if (p.party) s.party = clone(p.party);
    if (!s.log) s.log = [];
    s.log.push({ at: p.at || Date.now(), kind: 'undo', text: `Undone: ${last ? last.text : 'the last change'}`, memberId: p.who || null, ch: (s.game || { family: {} }).family.chapter });
  }, anyone);

  const find = (st, id) => st.characters.find((c) => c.id === id);

  /* ================================================================= SETUP === */

  op('setupStage', (st, p) => { st.setup.stage = p.stage; return ''; }, UNCLAIMED);

  op('setStart', (st, p) => {
    st.setup.start = p.start;
    if (p.start !== 'city') st.variants['Fleeing the City'] = false;
    resetHome(st);
    return '';
  }, UNCLAIMED);

  function resetHome(st) {
    for (const c of st.characters) c.hand = [];
    st.family.home = null; st.family.tradition = null; st.family.region = st.setup.start === 'city' ? 'City' : 'Riverlands';
    st.inPlay = []; st.decks = {};
    st.borough = { inPlay: false, station: null, isHome: false };
  }

  op('chooseHome', (st, p) => {
    // changing our mind: cards already dealt go back to the old deck
    for (const c of st.characters) {
      for (const id of c.hand) R.discard(st, id);
      c.hand = [];
    }
    st.inPlay = []; st.decks = {};
    st.family.home = p.home;
    st.family.region = p.region;
    st.family.tradition = p.tradition;
    R.bringDeckIntoPlay(st, p.tradition);
    for (const t of (R.loc(p.home) || { traditions: [] }).traditions) if (!t.startsWith('ANY:')) R.bringDeckIntoPlay(st, t);
    st.borough = p.home === R.BOROUGH ? { inPlay: true, station: null, isHome: true } : { inPlay: false, station: null, isHome: false };
    st.setup.stage = Math.max(st.setup.stage, 2);
    return `Our family’s home is ${locName(p.home)}. Our Family Tradition is ${p.tradition}.`;
  }, UNCLAIMED);

  op('setVariant', (st, p) => {
    st.variants[p.name] = !!p.on;
    if (p.name === 'Fleeing the City' && p.on && st.setup.start !== 'city' && !st.setupComplete) { st.setup.start = 'city'; resetHome(st); }
    if (p.name === 'The Umbra Follows' && st.setupComplete && st.family.region === 'City') {
      st.umbraInPlay = !!p.on;
      if (p.on) R.bringDeckIntoPlay(st, 'Umbra'); else st.inPlay = st.inPlay.filter((d) => d !== 'Umbra');
    }
    return `${p.name} is ${p.on ? 'now in play' : 'set aside'}.`;
  }, UNCLAIMED);

  op('addMember', (st, p) => {
    if (find(st, p.id)) return '';
    st.characters.push(R.newCharacter({ id: p.id, name: p.name, pronouns: p.pronouns, marks: 0, token: p.token || R.freeToken(st), templateId: p.templateId || null }));
    st.turn.order = st.characters.map((c) => c.id);
    return `${p.name} joins the family.`;
  }, UNCLAIMED);

  op('removeMember', (st, p) => {
    const c = find(st, p.id);
    if (!c) return '';
    for (const id of c.hand) R.discard(st, id);
    st.characters = st.characters.filter((x) => x.id !== p.id);
    st.turn.order = st.characters.map((x) => x.id);
    return `${c.name} is removed from the family.`;
  }, UNCLAIMED);

  op('moveMember', (st, p) => {
    const i = st.characters.findIndex((c) => c.id === p.id);
    const j = i + p.dir;
    if (i < 0 || j < 0 || j >= st.characters.length) return '';
    const arr = st.characters.slice();
    [arr[i], arr[j]] = [arr[j], arr[i]];
    st.characters = arr;
    st.turn.order = arr.map((c) => c.id);
    return '';
  }, UNCLAIMED);

  op('setMarks', (st, p) => {
    const c = find(st, p.id);
    if (!c) return '';
    c.marks = p.marks;
    while (c.hand.length > p.marks) R.discard(st, c.hand.pop());
    const tier = R.tierForMarks(p.marks);
    return `${c.name} is ${tier === 'Elder' ? 'an' : 'a'} ${tier} — ${p.marks} Mark${p.marks === 1 ? '' : 's'} of Age.`;
  }, UNCLAIMED);

  op('setPronouns', (st, p) => { const c = find(st, p.id); if (c) c.pronouns = p.pronouns || ''; return ''; }, UNCLAIMED);

  op('addBond', (st, p) => {
    const c = find(st, p.id);
    if (!c) return '';
    c.bonds.push({ prompt: p.prompt, joiner: p.joiner || 'of', subject: p.subject, city: p.city || undefined, memory: p.memory || undefined });
    if (!st.sideCharacters.some((x) => x.name === p.subject) && !st.characters.some((x) => x.name === p.subject)) {
      st.sideCharacters.push({ id: 'side-' + p.subject.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: p.subject, marks: 0 });
    }
    return `${c.name} is ${p.prompt} ${p.joiner || 'of'} ${p.subject}.`;
  }, UNCLAIMED);

  op('removeBond', (st, p) => {
    const c = find(st, p.id);
    if (!c || !c.bonds[p.index]) return '';
    const b = c.bonds.splice(p.index, 1)[0];
    return `${c.name} lets go of the Bond “${b.prompt} ${b.joiner || 'of'} ${b.subject}”.`;
  }, UNCLAIMED);

  op('holdCard', (st, p) => {   // setup: take a card from the family deck's spread
    const c = find(st, p.id);
    const deck = st.family.tradition;
    if (!c || !deck || !st.decks[deck] || !st.decks[deck].includes(p.cardId) || c.hand.length >= R.handLimit(c)) return '';
    c.hand.push(p.cardId);
    st.decks[deck] = st.decks[deck].filter((x) => x !== p.cardId);
    return `${c.name} holds “${card(p.cardId).prompt}”.`;
  }, UNCLAIMED);

  op('putBack', (st, p) => {
    const c = find(st, p.id);
    const deck = st.family.tradition;
    if (!c || !c.hand.includes(p.cardId)) return '';
    c.hand = c.hand.filter((x) => x !== p.cardId);
    (st.decks[deck] = st.decks[deck] || []).push(p.cardId);
    return `${c.name} puts back “${card(p.cardId).prompt}”.`;
  }, UNCLAIMED);

  op('setToken', (st, p) => {
    const c = find(st, p.id);
    if (!c) return '';
    c.token = p.token;
    const t = R.TOKENS.find((x) => x.id === p.token);
    return t ? `${c.name} takes the ${t.name} token.` : '';
  }, UNCLAIMED);

  op('beginPlay', (st, p) => {
    st.umbraInPlay = !!p.umbra;
    if (p.umbra) R.bringDeckIntoPlay(st, 'Umbra');
    st.setupComplete = true;
    st.turn.order = st.characters.map((c) => c.id);
    st.turn.current = 0;
    st.family.chapter = 1;
    R.startNewChapter(st, { continuing: true, first: true });
    st.family.chapter = 1;
    return p.umbra
      ? `The Umbra Deck is placed beside the ${st.family.region === 'City' ? 'City Map' : 'River Scroll'}. Chapter 1 begins at ${locName(st.family.home)}.`
      : `Chapter 1 begins at ${locName(st.family.home)}.`;
  }, UNCLAIMED);

  op('addSide', (st, p) => {
    if (st.sideCharacters.some((x) => x.name === p.name)) return '';
    st.sideCharacters.push({ id: p.id, name: p.name, marks: 0 });
    return `${p.name} enters the story.`;
  });
  op('removeSide', (st, p) => { st.sideCharacters = st.sideCharacters.filter((x) => x.id !== p.id); return ''; });

  /* ======================================================= the start of a Chapter */

  op('rollDeath', (st, p) => {
    const c = find(st, p.id);
    if (!c) return '';
    const r = R.deathResult(c, p.roll);
    st.chapterStart = st.chapterStart || { rolled: {} };
    st.chapterStart.rolled[c.id] = { roll: r.roll, died: r.died };
    if (r.died) R.becomeMemory(st, c);
    return `${c.name} rolls ${r.roll} against ${c.crossed} crossed-off Mark${c.crossed === 1 ? '' : 's'} — ${r.died ? 'and dies of old age, passing into memory.' : 'and lives on.'}`;
  });

  op('boroughRoll', (st, p) => {
    const w = R.boroughLine(p.roll);
    st.chapterStart = st.chapterStart || { rolled: {} };
    st.chapterStart.borough = { roll: w.roll, line: w.line, stations: w.stations };
    return `The Die shows ${w.roll}: the Borough wanders along ${w.line || 'no line'}.`;
  });

  op('boroughSettle', (st, p) => {
    R.boroughArrives(st, p.station);
    if (st.chapterStart && st.chapterStart.borough) st.chapterStart.borough.station = p.station;
    return `The Wandering Borough settles at ${p.station}.`;
  });

  op('birth', (st, p) => {
    const ch = R.birth(st, p);
    const giver = find(st, p.giverId);
    return `${ch.name} is born into the family${giver ? ` — ${p.bondPrompt} ${p.joiner || 'of'} ${giver.name}` : ''}.`;
  }, UNCLAIMED);

  op('firstTurn', (st, p) => {
    const c = find(st, p.id);
    if (!c) return '';
    R.giveTurnTo(st, c.id);
    st.chapterStart = null;
    return `${c.name} takes the first turn${st.family.chapter ? ` of Chapter ${st.family.chapter}` : ''}.`;
  });

  /* ===================================================================== turns */

  op('chooseScene', (st, p) => {
    const c = find(st, p.id);
    if (!c) return '';
    R.chooseScene(st, c, p.scene);
    return `${c.name} places their token on “${p.scene}”${c.visiting ? ` at ${locName(c.visiting)}` : ''}.`;
  });

  op('unchooseScene', (st, p) => {
    const c = find(st, p.id);
    if (c) c.scene = null;
    st.turn.scene = null;
    st.turn.phase = 'choose-scene';
    return '';
  });

  op('travel', (st, p) => {
    const c = find(st, p.id);
    if (!c) return '';
    c.visiting = p.to && p.to !== R.homeOf(st, c) ? p.to : null;
    c.scene = null;
    return c.visiting ? `${c.name} travels to ${locName(c.visiting)}.` : `${c.name} returns home.`;
  });

  op('share', (st, p) => {
    const c = find(st, p.id);
    if (!c || !c.hand.includes(p.cardId)) return '';
    R.shareTradition(st, c, p.cardId);
    return `${c.name} plays a card face down.`;
  });

  op('witness', (st, p) => {
    const c = find(st, p.id);
    if (!c) return '';
    const drawn = R.witnessTradition(st, c, p.to, p.picks || []);
    const to = p.to ? find(st, p.to) : null;
    return `${c.name} draws from ${(p.picks || []).join(', ')}${to ? ` and gives ${drawn.length === 1 ? 'it' : 'them'} to ${to.name}` : ''}.`;
  });

  op('reveal', (st, p) => {
    const t = st.table.find((x) => x.cardId === p.cardId);
    if (!t) return '';
    t.revealed = p.on === undefined ? !t.revealed : !!p.on;
    const holder = t.to ? find(st, t.to) : null;
    return t.revealed && t.kind === 'witness' ? `${holder ? holder.name : 'The holder'} plays “${card(p.cardId).prompt}”.` : '';
  });

  op('setRecipient', (st, p) => { R.setShareRecipient(st, p.cardId, p.to); return ''; });

  op('passOn', (st, p) => {
    const cur = R.currentCharacter(st);
    const entries = st.table.slice();
    const holder = entries[0] && entries[0].to ? find(st, entries[0].to) : null;
    const kind = st.turn.sceneKind;
    const passed = R.passOnTradition(st, p.cardId || null);
    if (!passed) return 'The witnessed cards go to the bottom of their decks.';
    const c = card(passed.cardId);
    const to = find(st, passed.to);
    if (kind === 'share') return `${cur ? cur.name : 'Someone'} shares “${c.prompt}” with ${to ? to.name : '?'}.`;
    return `${holder ? holder.name : 'The locals'} pass${holder ? 'es' : ''} “${c.prompt}” to ${to ? to.name : '?'}.`;
  });

  op('passTurn', (st, p) => {
    const cur = R.currentCharacter(st);
    R.passTurn(st);
    return p.text !== undefined ? p.text : (cur ? `${cur.name} ends the scene.` : '');
  });

  op('giveTurn', (st, p) => {
    const c = find(st, p.id);
    if (!c) return '';
    R.giveTurnTo(st, c.id);
    return p.text || `${c.name} takes the turn.`;
  });

  op('migrationScene', (st, p) => {
    const c = find(st, p.id);
    if (!c) return '';
    const before = c.hand.length;
    R.layDownExcess(st, c, p.keep || c.hand.slice());
    const laid = before - c.hand.length;
    R.finishMigrationScene(st, c);
    R.passTurn(st);
    return `${c.name} plays a Migration Scene${laid ? ` and lays down ${laid} card${laid === 1 ? '' : 's'}` : ''}.`;
  });

  op('migrateApart', (st, p) => {
    const leader = find(st, p.id);
    if (!leader) return '';
    const group = [leader, ...(p.joiners || []).map((id) => find(st, id)).filter(Boolean)];
    R.migrateApart(st, p.id, p.joiners || []);
    return `${names(group)} choose${group.length === 1 ? 's' : ''} to Migrate Apart.`;
  });

  op('setDestination', (st, p) => { if (st.migration) { st.migration.destination = p.to; st.migration.entrance = null; } return ''; });
  op('setEntrance', (st, p) => { if (st.migration) st.migration.entrance = p.target; return ''; });

  op('saveCard', (st, p) => {
    const c = find(st, p.id);
    if (!c || !R.saveTradition(st, c, p.cardId)) return '';
    return `${c.name} ${p.verb || 'saves'} “${card(p.cardId).prompt}”.`;
  });

  op('leaveCard', (st, p) => { R.leaveBehind(st, p.cardId); return `“${card(p.cardId).prompt}” is left behind.`; });

  op('migrate', (st, p) => {
    const m = st.migration || {};
    const group = (m.group || []).map((id) => find(st, id)).filter(Boolean);
    const whole = !m.apart && (!m.group || R.households(st).length <= 1);
    const arrival = p.arrival || null;   // the arrival page's entrance text, when entering the City
    const r = R.migrateFamily(st, p.target);
    if (r.apart) R.passTurn(st);
    else st.turn.phase = r.entering ? 'city-arrival' : 'who-first';
    if (arrival) return `At last we reach the City of Winter ${arrival.replace(/^\.\.\./, '…')}`;
    if (r.apart) return `${names(group)} migrate${group.length === 1 ? 's' : ''} apart, to ${locName(p.target)}.`;
    if (whole) return `The family migrates to ${locName(p.target)}.`;
    return `${names(group)} migrate${group.length === 1 ? 's' : ''} to ${locName(p.target)}.`;
  });

  op('openCityMap', (st) => { st.turn.phase = 'who-first'; return ''; });

  op('memoryMove', (st, p) => {
    const mem = find(st, p.memId);
    const t = find(st, p.targetId);
    if (!mem || !t) return '';
    R.memoryMoveToken(st, t, p.scene);
    return `${mem.name}, as a Memory, places ${t.name}’s token on “${p.scene}”.`;
  });

  op('memoryPlay', (st, p) => {
    const c = find(st, p.id);
    const t = find(st, st.turn.memoryTarget);
    if (!c || !c.hand.includes(p.cardId)) return '';
    R.memoryPlay(st, c, p.cardId);
    return `${c.name}’s memory plays a card face down for ${t ? t.name : '?'}.`;
  });

  op('memoryGive', (st) => {
    const r = R.memoryGive(st);
    if (!r) return '';
    const from = find(st, r.from), to = find(st, r.to);
    st.turn.sceneKind = 'memory';
    let text = `${from ? from.name : '?'}’s memory shares “${card(r.cardId).prompt}” with ${to ? to.name : '?'}.`;
    if (r.forgotten && from) text += ` ${from.name} has shared their last Tradition and is forgotten.`;
    return text;
  });

  /* ============================================================ end of a Chapter */

  op('beginEndChapter', (st) => { R.beginEndingChapter(st); return `We bring Chapter ${st.family.chapter} to a close.`; });

  op('markAge', (st, p) => {
    const c = find(st, p.id);
    if (!c) return '';
    const r = R.markAge(st, c, { crossCityMark: !!p.crossCity });
    if (!st.chapterEnd) st.chapterEnd = { marked: {} };
    st.chapterEnd.marked[c.id] = r.kind;
    return r.gained ? `${c.name} gains a ${r.kind === 'city' ? 'City ' : ''}Mark.` : `${c.name} crosses off a ${r.kind === 'cross-city' ? 'City ' : ''}Mark.`;
  });

  op('unmarkAge', (st, p) => {
    const c = find(st, p.id);
    const kind = st.chapterEnd && st.chapterEnd.marked[p.id];
    if (!c || !kind) return '';
    R.unmarkAge(c, kind);
    delete st.chapterEnd.marked[p.id];
    return '';
  });

  op('holdTraditions', (st, p) => {
    const c = find(st, p.id);
    if (!c) return '';
    const before = c.hand.length;
    R.holdTraditions(st, c, p.keep || []);
    const laid = before - c.hand.length;
    return `${c.name} places ${laid} card${laid === 1 ? '' : 's'} face-up.`;
  });

  op('discardPool', (st) => {
    const left = R.discardPool(st);
    return `The remaining ${left.length} card${left.length === 1 ? ' is' : 's are'} discarded.`;
  });

  op('newChapter', (st) => {
    R.closeChapter(st);
    const was = st.family.chapter;
    R.startNewChapter(st);
    return `Chapter ${was} closes. Chapter ${st.family.chapter} begins.`;
  });

  op('endSession', (st, p) => {
    if (st.chapterEnd) { R.closeChapter(st); R.closeSession(st); return `Chapter ${st.family.chapter} closes, and the session ends.`; }
    R.closeSession(st);
    return 'The session ends mid-Chapter.';
  });

  op('cancelEndChapter', (st) => { st.chapterEnd = null; st.turn.phase = 'choose-scene'; return 'The Chapter goes on.'; });

  op('newSession', (st) => { R.newSession(st); return `Session ${st.family.session} begins at ${locName(st.family.home)}.`; });

  /* ================================================================= any time */

  op('becomeMemory', (st, p) => {
    const c = find(st, p.id);
    if (!c) return '';
    R.becomeMemory(st, c);
    return `${c.name} dies and becomes a Memory.`;
  });

  op('setLeaving', (st, p) => {
    const c = find(st, p.id);
    if (!c) return '';
    c.leaving = !!p.on;
    return p.on ? `${c.name}’s player must leave; ${c.name} will become a side-character.` : `${c.name} stays with the family.`;
  });

  op('boroughArrives', (st, p) => {
    R.boroughArrives(st, p.station);
    return p.text || `The Wandering Borough arrives near ${p.station}.`;
  });
  op('boroughLeaves', (st) => { R.boroughLeaves(st); return 'The Wandering Borough departs.'; });

  op('askFate', (st, p) => {
    const r = R.fateOutcome(p.roll);
    const o = r.outcome ? r.outcome.outcome.toLowerCase() : `${p.roll}`;
    return `Fate is asked${p.question ? ` “${p.question}”` : ''} and answers ${p.roll}: ${o}${p.answer ? ` — ${p.answer}` : ''}.`;
  });

  op('note', (st, p) => p.text || '');

  op('resetTable', (st, p, s) => {
    s.game = R.blankGame();
    s.party = [];
    return 'The table is cleared: everything goes back in the box.';
  });

  return { GAME_OPS, line };
});
