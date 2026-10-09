// system/cityofwinter/rules.js — the rules of play, as pure functions over the shared state.
//
// Every function corresponds to a named procedure or rule in the corpus; the page numbers in the
// comments are the rulebook's. Nothing here touches the DOM, rolls a die or makes an id: a roll
// and a new id arrive as arguments, so an op applies identically in every browser and in the
// Worker's room. The facts it reads (which cards a deck holds, what a Location connects to) come
// from facts.js, generated from data/.
//
// The state it works on is the family document's view: `st.characters` is the shared `party`,
// everything else lives under the shared `game` key (view() below).
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./facts.js'));
  else root.CowRules = factory(root.CowFacts);
})(typeof self !== 'undefined' ? self : this, function (F) {
  const BOROUGH = F.wanderingBorough;
  const loc = (name) => F.locations[name] || null;
  const card = (id) => F.cards[id] || null;

  /* ------------------------------------------------------------ the state -- */

  function blankGame() {
    return {
      setupComplete: false,
      setup: { stage: 0, start: 'riverlands' },   // stage = book step − 1 (0..7)
      family: { region: 'Riverlands', home: null, tradition: null, chapter: 1, session: 1, chapterClosed: false },
      sideCharacters: [],
      decks: {},          // deckName -> [cardId] (top of deck first)
      inPlay: [],         // deck names brought into play
      pool: [],           // face-up cards left on the table
      poolBy: {},         // cardId -> { by, home }: who laid it and where
      table: [],          // { cardId, from, to, kind:'share'|'witness'|'memory', revealed }
      turn: { order: [], current: 0, phase: 'idle', scene: null, sceneKind: null, memoryTarget: null, offer: null },
      migration: null,    // { from, group, apart, destination, entrance } while a group is migrating
      chapterEnd: null,   // { marked:{id:kind} } while a Chapter is closing
      chapterStart: null, // { rolled:{id:{roll,died}}, borough, continuing, first, fromSession } at the start of a Chapter
      borough: { inPlay: false, station: null, isHome: false },
      umbraInPlay: true,
      variants: {},       // optional-rule name -> boolean
    };
  }

  // The rules' view of the document: `characters` is the shared party, the rest the game key.
  function view(s) {
    if (!s.game) s.game = blankGame();
    if (!s.party) s.party = [];
    return new Proxy(s.game, {
      get(g, k) { return k === 'characters' ? s.party : g[k]; },
      set(g, k, v) { if (k === 'characters') s.party = v; else g[k] = v; return true; },
      has(g, k) { return k === 'characters' || k in g; },
    });
  }

  /* ------------------------------------------------------- decks and drawing -- */

  /** Bring a Tradition Deck into play (Migrate the Family, step 4, p.25). */
  function bringDeckIntoPlay(st, deckName) {
    if (!deckName || !F.decks[deckName] || st.inPlay.includes(deckName)) return;
    st.inPlay.push(deckName);
    if (!st.decks[deckName]) {
      // "It is not necessary to shuffle cards in City of Winter. Instead, let the
      // order of cards naturally shift from session to session." (p.16) A fresh
      // deck therefore starts in its printed order.
      st.decks[deckName] = F.decks[deckName].cards.slice();
    }
  }

  /** Draw the top card of a deck. Discards go to the bottom, so a deck never empties. */
  function drawFrom(st, deckName) {
    bringDeckIntoPlay(st, deckName);
    const deck = st.decks[deckName];
    if (!deck || !deck.length) return null;
    return deck.shift();
  }

  /** "Discarded Tradition Cards go to the bottom of their respective Tradition Decks." (p.25) */
  function discard(st, cardId) {
    const c = card(cardId);
    if (!c) return;
    bringDeckIntoPlay(st, c.deck);
    st.decks[c.deck] = (st.decks[c.deck] || []).filter((id) => id !== cardId);
    st.decks[c.deck].push(cardId);
  }

  /** Remove a card from wherever it currently sits (a hand, the pool, the table). */
  function detach(st, cardId) {
    for (const ch of st.characters) ch.hand = ch.hand.filter((id) => id !== cardId);
    st.pool = st.pool.filter((id) => id !== cardId);
    st.table = st.table.filter((t) => t.cardId !== cardId);
  }

  /* ------------------------------------------------------------- characters -- */

  // Tokens. The boxed game's Tokens are double-sided picture discs; the app's stand-ins are
  // colours, each worn with the character's initial.
  // The ten boxed Tokens: picture discs — brass crowns, copper fires and bells, silver lights
  // and pouches. The colour is the disc's metal (the ring, and the fallback when there is no art).
  const TOKENS = [
    { id: 'crown-a', name: 'Crown · garland', color: '#c9a85a' },
    { id: 'crown-b', name: 'Crown · diadem', color: '#c9a85a' },
    { id: 'fire-a', name: 'Fire · cauldron', color: '#b8744a' },
    { id: 'fire-b', name: 'Fire · anvil', color: '#b8744a' },
    { id: 'bell-a', name: 'Bell · hung', color: '#b8744a' },
    { id: 'bell-b', name: 'Bell · on a cord', color: '#b8744a' },
    { id: 'light-a', name: 'Light · moon', color: '#b9b7b4' },
    { id: 'light-b', name: 'Light · lantern', color: '#b9b7b4' },
    { id: 'pouch-a', name: 'Pouch · harvest', color: '#b9b7b4' },
    { id: 'pouch-b', name: 'Pouch · coins', color: '#b9b7b4' },
  ];

  function newCharacter({ id, name, pronouns, marks = 0, token = '', templateId = null }) {
    return {
      id, templateId, name, pronouns: pronouns || '', token,
      marks, crossed: 0, cityMarks: 0, cityCrossed: 0,
      bonds: [], hand: [],
      isMemory: false, forgotten: false, leaving: false,
      scene: null, visiting: null, home: null, hadMigrationScene: false, deathRolled: false,
      live: {},
    };
  }

  /** The first token nobody is using yet. */
  function freeToken(st) {
    const used = new Set(st.characters.map((c) => c.token));
    return (TOKENS.find((t) => !used.has(t.id)) || TOKENS[st.characters.length % TOKENS.length]).id;
  }

  function tierForMarks(marks) {
    return (F.ageTiers.find((t) => t.marks.includes(marks)) || {}).name || (marks > 6 ? 'Elder' : 'Child');
  }
  function isElder(ch) { return ch.marks >= 6; }

  /** Hand size a character may hold: their Marks of Age (p.16). */
  function handLimit(ch) { return ch.marks; }

  /** Characters still at the table: not forgotten, not gone to be side-characters. */
  function activeCharacters(st) {
    return st.characters.filter((c) => !c.forgotten && !c.leaving);
  }

  /** Main characters who are alive (not Memories) and at the table. */
  function livingCharacters(st) {
    return activeCharacters(st).filter((c) => !c.isMemory);
  }

  /**
   * Banners a character may name a new Bond from: "names from our Family Tradition Banners, or
   * any other Banner matching a Tradition Card that you hold." (p.27)
   */
  function bondBanners(st, ch) {
    const decks = [st.family.tradition, ...ch.hand.map((id) => (card(id) || {}).deck)];
    return [...new Set(decks.filter(Boolean))].map((d) => F.decks[d]).filter((k) => k && k.names && k.names.length);
  }

  /* ---------------------------------------------------- homes and households -- */

  /** Where a character lives: empty means "with the family"; a character who has Migrated Apart (p.43) carries a Home of their own. */
  function homeOf(st, ch) { return (ch && ch.home) || st.family.home; }

  /** The region of a character's Home — the City rules follow where you live. */
  function regionOf(st, ch) {
    return (loc(homeOf(st, ch)) || {}).region || st.family.region;
  }

  /** Living characters grouped by Home, the family's own Home first. */
  function households(st) {
    const map = new Map();
    for (const c of livingCharacters(st)) {
      const h = homeOf(st, c);
      if (!map.has(h)) map.set(h, []);
      map.get(h).push(c);
    }
    return [...map.entries()].map(([home, members]) => ({ home, members }))
      .sort((a, b) => (a.home === st.family.home ? -1 : b.home === st.family.home ? 1 : 0));
  }

  /** "While living apart, Migration mechanics affect each group separately." A household whose every member has had their Migration Scene migrates now. */
  function completeHousehold(st) {
    return households(st).find((h) => h.members.length && h.members.every((c) => c.hadMigrationScene)) || null;
  }

  /* ------------------------------------------------------- the turn sequence -- */

  function liveOrder(st) {
    return st.turn.order.filter((id) => activeCharacters(st).some((c) => c.id === id));
  }

  function currentCharacter(st) {
    const order = liveOrder(st);
    if (!order.length) return null;
    return st.characters.find((c) => c.id === order[st.turn.current % order.length]) || null;
  }

  /**
   * What passing the turn will do (p.24, p.43):
   *   { kind: 'migrate', household }  — a household has all had their Migration Scene;
   *   { kind: 'offer', idx, c }       — the turn reaches someone who has had theirs: in the City
   *                                     they "may choose to Migrate Apart instead of skipping a future turn";
   *   { kind: 'turn', idx, c }        — the next player takes their turn.
   * Elsewhere, characters who have had a Migration Scene are simply skipped.
   */
  function peekPass(st) {
    const household = completeHousehold(st);
    if (household) return { kind: 'migrate', household };
    const order = liveOrder(st);
    for (let i = 1; i <= order.length; i++) {
      const idx = (st.turn.current + i) % order.length;
      const c = st.characters.find((x) => x.id === order[idx]);
      if (!c) continue;
      if (!c.hadMigrationScene) return { kind: 'turn', idx, c };
      if (!c.isMemory && regionOf(st, c) === 'City') return { kind: 'offer', idx, c };
    }
    return null;
  }

  /** Who would take the next turn — for "Pass the turn to …" labels. */
  function nextCharacter(st) {
    const p = peekPass(st);
    return p && p.kind === 'turn' ? { idx: p.idx, c: p.c } : null;
  }

  function passTurn(st) {
    const p = peekPass(st);
    st.turn.scene = null;
    st.turn.sceneKind = null;
    st.turn.memoryTarget = null;
    st.turn.offer = null;
    if (p && p.kind === 'migrate') { beginMigration(st, p.household.home, p.household.members, false); return; }
    if (p) st.turn.current = p.idx;
    st.turn.phase = p && p.kind === 'offer' ? 'apart-offer' : 'choose-scene';
    if (p && p.kind === 'offer') st.turn.offer = p.c.id;
  }

  /** Start the Migrate the Family procedure for a household, or a group Migrating Apart. */
  function beginMigration(st, from, members, apart) {
    st.turn.phase = 'migrate-family';
    st.migration = { from, group: members.map((c) => c.id), apart, destination: null, entrance: null };
    st.turn.offer = null;
    retireLeavers(st);   // their cards join the face-up pool, to be saved or left
  }

  /** Migrate Apart (p.43): instead of skipping this turn, the character — and any who "have also had their Migration Scene" and wish to join — follow the rest of Migrate the Family on their own. */
  function migrateApart(st, leaderId, joinerIds) {
    const leader = st.characters.find((c) => c.id === leaderId);
    if (!leader) return;
    const from = homeOf(st, leader);
    const group = [leader, ...st.characters.filter((c) => (joinerIds || []).includes(c.id) && c.id !== leaderId)];
    beginMigration(st, from, group, true);
  }

  /** Who may join a character Migrating Apart: those at the same Home who have also had their Migration Scene. */
  function apartCompanions(st, leader) {
    return livingCharacters(st).filter((c) => c.id !== leader.id && c.hadMigrationScene && homeOf(st, c) === homeOf(st, leader));
  }

  /** "Any player may take the first turn" — choose who begins. */
  function giveTurnTo(st, chId) {
    const order = liveOrder(st);
    const i = order.indexOf(chId);
    if (i >= 0) st.turn.current = i;
    st.turn.phase = 'choose-scene';
    st.turn.scene = null;
    st.turn.sceneKind = null;
    st.turn.memoryTarget = null;
    st.turn.offer = null;
  }

  /** The Migration Scene procedure is under way: it must finish before a Chapter can end (p.26). */
  function migrationUnderway(st) {
    return st.turn.phase === 'migrate-family' || livingCharacters(st).some((c) => c.hadMigrationScene);
  }

  /** "At the start of your turn, if your token is already on a Scene, you may choose to play a Migration Scene." (p.24) A Memory does not participate. */
  function canPlayMigrationScene(ch) {
    return !!ch && !ch.isMemory && !ch.hadMigrationScene && !!ch.scene;
  }

  /* ---------------------------------------------------------- Tradition Scene */

  /** Step 1: move your token to a scene at the family's current location (p.21). */
  function chooseScene(st, ch, sceneName) {
    ch.scene = sceneName;
    st.turn.scene = sceneName;
    st.turn.phase = 'share-or-witness';
  }

  /** Share a Tradition: play a card from your hand face down (p.22). */
  function shareTradition(st, ch, cardId) {
    detach(st, cardId);
    st.table.push({ cardId, from: ch.id, to: null, kind: 'share', revealed: false });
    st.turn.sceneKind = 'share';
    st.turn.phase = 'lead';
  }

  /**
   * Witness a Tradition (p.22, and in the City p.38). Draws one card per Local Tradition icon at
   * the location; a blank icon lets the drawing player choose any deck of the matching shape.
   * The cards go to another player, who reads them privately.
   */
  function witnessTradition(st, ch, recipientId, deckChoices) {
    const drawn = [];
    for (const deckName of deckChoices) {
      const id = drawFrom(st, deckName);
      if (id) drawn.push(id);
    }
    for (const cardId of drawn) {
      st.table.push({ cardId, from: ch.id, to: recipientId || null, kind: 'witness', revealed: false });
    }
    st.turn.sceneKind = 'witness';
    st.turn.phase = 'lead';
    return drawn;
  }

  /** Which decks a location's icons draw from, resolving blank shape icons. */
  function localDecks(locName) {
    const l = loc(locName);
    if (!l) return [];
    return l.traditions.map((t) => (t.startsWith('ANY:')
      ? { blank: true, shape: t.slice(4), decks: (F.shapeFamilies[t.slice(4)] || []).slice() }
      : { blank: false, shape: (F.decks[t] || {}).shape, decks: [t] }));
  }

  /** Which decks a Witness at this location may draw from, icon by icon. */
  function witnessOptions(st, locationName) {
    const opts = localDecks(locationName).map((icon) => ({ blank: icon.blank, shape: icon.shape, decks: icon.decks.filter((d) => d !== 'Umbra') }));
    // In the Riverlands you may draw from the Umbra Deck instead of the Local Tradition (p.22).
    // In the City the Umbra Deck is out of play unless the group is using "The Umbra Follows" (p.53).
    if (st.umbraInPlay) for (const o of opts) o.decks = [...o.decks, 'Umbra'];
    return opts;
  }

  /** Share a Tradition names its recipient before the card is passed. */
  function setShareRecipient(st, cardId, recipientId) {
    const t = st.table.find((x) => x.cardId === cardId);
    if (t) t.to = recipientId;
  }

  /**
   * Pass on the Tradition (p.23). One card reaches its hand — the named recipient's for a Share,
   * the turn player's for a Witness; in a City Witness Scene the rest are discarded to the bottom
   * of their decks (p.39). "The Borough Wanders" is never passed: at the end of the scene it is
   * discarded to the bottom of its deck (p.44).
   */
  function passOnTradition(st, keptCardId) {
    const turnCh = currentCharacter(st);
    let passed = null;
    for (const t of st.table.slice()) {
      st.table = st.table.filter((x) => x.cardId !== t.cardId);
      const c = card(t.cardId);
      if (t.cardId === keptCardId && !(c && c.borough)) {
        const receiver = t.kind === 'witness' ? turnCh : st.characters.find((x) => x.id === t.to);
        if (receiver) { receiver.hand.push(t.cardId); passed = { cardId: t.cardId, to: receiver.id }; }
        else discard(st, t.cardId);
      } else {
        discard(st, t.cardId);
      }
    }
    st.turn.phase = 'end-scene';
    return passed;
  }

  /* --------------------------------------------------------- Migration Scene -- */

  /** Face-up cards remember who laid them and where: a migrating group may only draw on what its own members left, and "Characters who are staying may Save Traditions left by characters who are leaving" (p.43). */
  function toPool(st, ids, ch) {
    st.pool.push(...ids);
    st.poolBy = st.poolBy || {};
    for (const id of ids) st.poolBy[id] = { by: ch.id, home: homeOf(st, ch) };
  }

  function fromPool(st, cardId) {
    st.pool = st.pool.filter((id) => id !== cardId);
    if (st.poolBy) delete st.poolBy[cardId];
  }

  /** Migration Scene step 2: cards above your Marks of Age go face-up (p.24). */
  function layDownExcess(st, ch, keepIds) {
    const keep = new Set(keepIds);
    const laid = ch.hand.filter((id) => !keep.has(id));
    ch.hand = ch.hand.filter((id) => keep.has(id));
    toPool(st, laid, ch);
    return laid;
  }

  /** The face-up cards this migration deals with (steps 2 and 3). */
  function migrationCards(st) {
    const m = st.migration;
    if (!m || !m.group) return st.pool.slice();
    const by = st.poolBy || {};
    return st.pool.filter((id) => {
      const o = by[id];
      if (m.apart) return !!o && m.group.includes(o.by);
      return !o || o.home === m.from;
    });
  }

  /** Who may save those cards: short-handed members of the group — and, when Migrating Apart, those staying behind. */
  function migrationSavers(st) {
    const m = st.migration;
    const short = (c) => c.hand.length < handLimit(c);
    if (!m || !m.group) return livingCharacters(st).filter(short);
    return livingCharacters(st).filter((c) => short(c) && (m.group.includes(c.id) || (m.apart && homeOf(st, c) === m.from)));
  }

  function finishMigrationScene(st, ch) {
    ch.hadMigrationScene = true;
    ch.scene = null;
    ch.visiting = null;
  }

  /** Migrate the Family step 2: fill short hands from the face-up pool (p.25). */
  function saveTradition(st, ch, cardId) {
    if (ch.hand.length >= handLimit(ch)) return false;
    if (!st.pool.includes(cardId)) return false;
    fromPool(st, cardId);
    ch.hand.push(cardId);
    return true;
  }

  /** Migrate the Family step 3: whatever is unclaimed is left behind (p.25). */
  function leaveBehind(st, cardId) {
    fromPool(st, cardId);
    discard(st, cardId);
  }

  /** The River Scroll's arrival pages, which lead through an Entrance into the City. */
  function isArrival(locName) { return !!(loc(locName) || {}).isArrival; }

  /**
   * Migrate the Family step 4 (p.25). Also handles arriving in the City (p.37) and, under "Fleeing
   * the City" (p.53), leaving it. Moves the migrating group only: the whole household at the
   * family's Home moves the family's Home; a group Migrating Apart takes a Home of its own (p.43).
   */
  function migrateFamily(st, destination) {
    const m = st.migration || {};
    const from = m.from || st.family.home;
    const group = m.group
      ? st.characters.filter((c) => m.group.includes(c.id))
      : livingCharacters(st).filter((c) => homeOf(st, c) === from);
    const dest = loc(destination);
    const fromRegion = (loc(from) || {}).region || st.family.region;
    const entering = !!dest && dest.region === 'City' && fromRegion !== 'City';
    const leaving = !!dest && dest.region === 'Riverlands' && fromRegion === 'City';
    const wholeFamily = !m.apart && from === st.family.home;

    if (wholeFamily) {
      st.family.home = destination;
      if (dest) st.family.region = dest.region;
    }
    for (const c of group) {
      c.home = wholeFamily ? null : destination;
      c.hadMigrationScene = false;
      c.scene = null;
      c.visiting = null;
    }
    settleHomes(st);

    if (entering) {
      // Migrating to the City: the River Scroll and the Umbra Deck go back in the box; a player
      // already holding an Umbra Tradition keeps it (p.37).
      st.umbraInPlay = !!st.variants['The Umbra Follows'];
      st.inPlay = st.inPlay.filter((d) => d !== 'Umbra' || st.umbraInPlay);
    }
    // Fleeing the City: "Remove the Umbra Deck from play when we reach Temple Island or Cloud Citadel." (p.53)
    if (st.variants['Fleeing the City'] && ['Temple Island', 'Cloud Citadel'].includes(destination)) {
      st.umbraInPlay = false;
      st.inPlay = st.inPlay.filter((d) => d !== 'Umbra');
    }

    for (const t of dest ? dest.traditions : []) {
      if (!t.startsWith('ANY:')) bringDeckIntoPlay(st, t);
    }
    retireLeavers(st);
    st.migration = null;
    st.turn.phase = 'choose-scene';
    st.turn.scene = null;
    return { entering, leaving, apart: !!m.apart, wholeFamily };
  }

  /**
   * Keep Homes tidy after a migration: a character whose Home is the family's is simply "with
   * the family" again; if nobody living is left at the family's Home, the largest household
   * becomes the family's Home; and the Borough is a Home while anyone lives there (p.45).
   */
  function settleHomes(st) {
    const living = livingCharacters(st);
    if (living.length && !living.some((c) => homeOf(st, c) === st.family.home)) {
      const counts = new Map();
      for (const c of living) counts.set(homeOf(st, c), (counts.get(homeOf(st, c)) || 0) + 1);
      const home = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      st.family.home = home;
      st.family.region = (loc(home) || {}).region || st.family.region;
    }
    for (const c of st.characters) if (c.home === st.family.home) c.home = null;
    st.borough.isHome = st.characters.some((c) => !c.forgotten && homeOf(st, c) === BOROUGH);
  }

  /* ----------------------------------------------------------------- transit -- */

  /** Transit distance exactly as printed ("7+", "-"); Wintermount's derived row as a fallback, flagged. */
  const DIST = F.transitDistance;
  function distance(from, to) {
    const i = DIST.order.indexOf(to);
    if (from === to) return '-';
    if (DIST.rows[from] && i >= 0) return DIST.rows[from][i];
    const der = DIST.derived && DIST.derived.rows;
    if (der && der[from] && i >= 0) return der[from][i];
    if (der && der[to]) {
      const j = DIST.order.indexOf(from);
      if (j >= 0) return der[to][j];
    }
    return null;
  }
  function isDerivedDistance(from, to) {
    const der = (DIST.derived && DIST.derived.rows) || {};
    return !!(der[from] || der[to]);
  }
  function distanceLocations() {
    return [...DIST.order, ...Object.keys((DIST.derived && DIST.derived.rows) || {})];
  }
  /** Every City location a character could Travel to from Home with n City Marks. */
  function travelReach(home, cityMarks) {
    const out = [];
    for (const to of distanceLocations()) {
      if (to === home) continue;
      const v = distance(home, to);
      if (v && v !== '-' && v !== '7+' && Number(v) <= cityMarks) out.push({ to, cost: Number(v), derived: isDerivedDistance(home, to) });
    }
    return out.sort((a, b) => a.cost - b.cost || a.to.localeCompare(b.to));
  }

  /** Destinations available to the migrating group right now. */
  function migrationDestinations(st) {
    const m = st.migration || {};
    const home = m.from || st.family.home;
    if (!home) return [];
    const group = m.group ? livingCharacters(st).filter((c) => m.group.includes(c.id)) : livingCharacters(st);
    if (((loc(home) || {}).region || st.family.region) !== 'City') {
      return ((loc(home) || {}).connects || []).map((to) => ({
        to, why: isArrival(to) ? 'the road into the City' : 'connected by a river or other path',
        route: (loc(to) || {}).route || null,
      }));
    }
    // In the City: any adjacent Location, plus anywhere a migrating family member could reach through Travel with their City Marks (p.43).
    const out = new Map();
    const at = home === BOROUGH ? st.borough.station : home;
    for (const line of F.transitLines) {
      const i = line.stations.indexOf(at);
      if (i < 0) continue;
      for (const j of [i - 1, i + 1]) {
        const to = line.stations[j];
        if (to && to !== home) out.set(to, { to, why: `adjacent on ${line.name}` });
      }
    }
    for (const c of group) {
      for (const r of travelReach(at, c.cityMarks)) {
        if (r.to !== home && !out.has(r.to)) out.set(r.to, { to: r.to, why: `${c.name} can Travel ${r.cost}`, derived: r.derived });
      }
    }
    if (st.borough.inPlay && home !== BOROUGH) out.set(BOROUGH, { to: BOROUGH, why: `the Borough is at ${st.borough.station}` });
    // Fleeing the City: "We can Migrate from the City Map to the River Scroll through any of the points of entry listed on the Riverscroll." (p.53)
    if (st.variants['Fleeing the City']) {
      for (const name of F.locationOrder) {
        const l = loc(name);
        if (!l.isArrival || !l.entrances.some((e) => e.target === home)) continue;
        for (const to of l.connects) out.set(to, { to, why: `out of the City by ${l.route}`, route: l.route });
      }
    }
    return [...out.values()].sort((a, b) => a.to.localeCompare(b.to));
  }

  /** Travel to another Location on your turn (p.42). Distance is measured from Home. */
  function travelTargets(st, ch) {
    const myHome = homeOf(st, ch);
    if (regionOf(st, ch) !== 'City' || !myHome) return [];
    const home = myHome === BOROUGH ? st.borough.station : myHome;
    if (!home) return [];
    const reach = travelReach(home, ch.cityMarks);
    if (st.borough.inPlay && st.borough.station && myHome !== BOROUGH) {
      // "The Borough occupies the same Station in the Transit Line as the Location where it appeared. Any character who could interact with that Location may interact in the same way with the Wandering Borough" (p.45).
      const at = st.borough.station;
      if (at === home || reach.some((r) => r.to === at)) reach.push({ to: BOROUGH, cost: (reach.find((r) => r.to === at) || { cost: 0 }).cost });
    }
    if (myHome === BOROUGH && st.borough.station) reach.unshift({ to: st.borough.station, cost: 0 });
    return reach;
  }

  /* ----------------------------------------------------------- Ending a Chapter */

  function beginEndingChapter(st) {
    st.turn.phase = 'end-chapter';
    st.chapterEnd = { marked: {} };
    st.table = [];
    retireLeavers(st);     // their cards join the face-up pool for Hold Traditions
  }

  /** Step 1: Mark Age. An Elder crosses a Mark off instead of adding one (p.26). In the City we mark age with City Marks (p.40), and an Elder with both kinds may cross off either. */
  function markAge(st, ch, opts) {
    opts = opts || {};
    const inCity = regionOf(st, ch) === 'City';
    if (isElder(ch)) {
      if (opts.crossCityMark && ch.cityMarks > ch.cityCrossed) { ch.cityCrossed += 1; return { gained: false, kind: 'cross-city' }; }
      ch.crossed = Math.min(ch.marks, ch.crossed + 1);
      return { gained: false, kind: 'cross' };
    }
    if (inCity) { ch.cityMarks += 1; return { gained: true, kind: 'city' }; }
    ch.marks = Math.min(6, ch.marks + 1);
    return { gained: true, kind: 'age' };
  }

  /** Undo a Mark Age made by mistake during the same Chapter's end. */
  function unmarkAge(ch, kind) {
    if (kind === 'city') ch.cityMarks = Math.max(0, ch.cityMarks - 1);
    else if (kind === 'age') ch.marks = Math.max(0, ch.marks - 1);
    else if (kind === 'cross') ch.crossed = Math.max(0, ch.crossed - 1);
    else if (kind === 'cross-city') ch.cityCrossed = Math.max(0, ch.cityCrossed - 1);
  }

  /** Step 3: Hold Traditions — trim to hand size, or fill up from the pool (p.27). */
  function holdTraditions(st, ch, keepIds) {
    const keep = new Set(keepIds);
    const laid = ch.hand.filter((id) => !keep.has(id));
    ch.hand = ch.hand.filter((id) => keep.has(id));
    toPool(st, laid, ch);
  }

  /** Step 3, second half: "Remaining cards are discarded." (p.27) */
  function discardPool(st) {
    const left = st.pool.slice();
    st.pool = [];
    st.poolBy = {};
    for (const id of left) discard(st, id);
    return left;
  }

  /** Close the Chapter: remove the Wandering Borough unless it is Home (p.44), and let anyone leaving the game go (p.35). */
  function closeChapter(st) {
    retireLeavers(st);
    discardPool(st);
    if (st.borough.inPlay && !st.borough.isHome) {
      st.borough.inPlay = false;
      st.borough.station = null;
    }
    for (const c of st.characters) { c.scene = null; c.visiting = null; }
    st.family.chapterClosed = true;
    st.chapterEnd = null;
  }

  /** Start of a Chapter: "everyone places their Token on our Home" (p.27). */
  function startNewChapter(st, opts) {
    opts = opts || {};
    if (!opts.continuing) st.family.chapter += 1;
    st.family.chapterClosed = false;
    for (const c of st.characters) {
      c.scene = null;
      c.visiting = null;
      c.hadMigrationScene = false;
      c.deathRolled = false;
    }
    st.table = [];
    st.turn.phase = 'chapter-start';
    st.turn.scene = null;
    st.turn.sceneKind = null;
    st.chapterStart = { rolled: {}, borough: null, continuing: !!opts.continuing, first: !!opts.first, fromSession: !!opts.fromSession };
  }

  /** End the session with a Closing Reflection (p.27). */
  function closeSession(st) { st.turn.phase = 'session-closed'; }

  /** New Session Setup (p.31): a new Chapter, unless the last one is still open. */
  function newSession(st) {
    st.family.session += 1;
    startNewChapter(st, { continuing: !st.family.chapterClosed, fromSession: true });
  }

  /* ------------------------------------------------------------ Death & Memory */

  /** An Elder rolls the Die at the start of each new Chapter; a roll equal to or less than their crossed-off Marks means they have died of old age (p.32). The roll itself is the caller's. */
  function deathResult(ch, roll) {
    ch.deathRolled = true;
    return { roll, died: roll <= ch.crossed };
  }

  /** When You Die, step 1: "Remove your token and return it to the box." (p.32) */
  function becomeMemory(st, ch) {
    ch.isMemory = true;
    ch.scene = null;
    ch.visiting = null;
    ch.hadMigrationScene = false;
  }

  /** "When you have shared your last Tradition Card, remove your Notecard from play." (p.33) */
  function checkForgotten(ch) {
    if (ch.isMemory && ch.hand.length === 0) { ch.forgotten = true; return true; }
    return false;
  }

  /** Memory Scene step 1: move another character's Token to a scene (p.32). */
  function memoryMoveToken(st, targetCh, sceneName) {
    targetCh.scene = sceneName;
    st.turn.scene = sceneName;
    st.turn.memoryTarget = targetCh.id;
    st.turn.phase = 'memory-share';
  }

  /** Memory Scene step 2: play a Tradition Card face down for that character. */
  function memoryPlay(st, memCh, cardId) {
    detach(st, cardId);
    st.table.push({ cardId, from: memCh.id, to: st.turn.memoryTarget, kind: 'memory', revealed: false });
    st.turn.sceneKind = 'memory';
  }

  /** Memory Scene step 4: give the card to the other player. */
  function memoryGive(st) {
    const t = st.table.find((x) => x.kind === 'memory');
    if (!t) return null;
    st.table = st.table.filter((x) => x !== t);
    const to = st.characters.find((c) => c.id === t.to);
    const from = st.characters.find((c) => c.id === t.from);
    if (to) to.hand.push(t.cardId);
    const forgotten = from ? checkForgotten(from) : false;
    st.turn.phase = 'end-scene';
    return { forgotten, cardId: t.cardId, to: to ? to.id : null, from: from ? from.id : null };
  }

  /* ------------------------------------------------------------------- Birth -- */

  /** Birth (p.34): a chosen player gives the new character a name and a Child Bond. */
  function birth(st, { id, name, pronouns, giverId, bondPrompt, joiner, token, templateId }) {
    const ch = newCharacter({ id, name, pronouns, marks: 0, token: token || freeToken(st), templateId });
    const giver = st.characters.find((c) => c.id === giverId);
    if (giver && bondPrompt) ch.bonds.push({ prompt: bondPrompt, joiner: joiner || 'of', subject: giver.name });
    st.characters.push(ch);
    if (!st.turn.order.includes(ch.id)) st.turn.order.push(ch.id);
    return ch;
  }

  /* ------------------------------------------------ leaving a game in progress */

  /** "If a player ever needs to leave a campaign or session in-progress, transition their character to a side character and add their Tradition Cards to the pool next time we Migrate the Family or end a Chapter." (p.35) */
  function retireLeavers(st) {
    for (const c of st.characters.filter((x) => x.leaving)) {
      toPool(st, c.hand, c);
      c.hand = [];
      if (!st.sideCharacters.some((s) => s.name === c.name)) st.sideCharacters.push({ id: c.id, name: c.name, marks: c.marks });
    }
    const gone = new Set(st.characters.filter((x) => x.leaving).map((c) => c.id));
    st.characters = st.characters.filter((c) => !gone.has(c.id));
    st.turn.order = st.turn.order.filter((id) => !gone.has(id));
  }

  /* --------------------------------------------------- The Wandering Borough -- */

  /** "The Borough Wanders" was drawn and revealed (p.44). */
  function boroughArrives(st, station) {
    st.borough.inPlay = true;
    st.borough.station = station;
  }

  /** "Any visiting character tokens are returned to their home." (p.44) */
  function boroughLeaves(st) {
    st.borough.inPlay = false;
    st.borough.station = null;
    for (const c of st.characters) {
      if (c.visiting === BOROUGH) { c.visiting = null; c.scene = null; }
    }
  }

  /** Living on the Borough: the Die was rolled; the table says which line (p.45). */
  function boroughLine(roll) {
    const line = F.transitLines.find((t) => t.die === roll);
    return { roll, line: line ? line.name : null, stations: line ? line.stations.slice() : [] };
  }

  /* ---------------------------------------------------------------- Ask Fate -- */

  /** Ask Fate (p.47): 1-3 likely, 4-5 unlikely, 6 fateful. */
  function fateOutcome(roll) {
    const band = roll <= 3 ? '1-3' : roll <= 5 ? '4-5' : '6';
    return { roll, band, outcome: F.askFate.find((o) => o.roll === band) || null };
  }

  return {
    F, BOROUGH, TOKENS, blankGame, view, loc, card,
    bringDeckIntoPlay, drawFrom, discard, detach,
    newCharacter, freeToken, tierForMarks, isElder, handLimit, activeCharacters, livingCharacters, bondBanners,
    homeOf, regionOf, households, completeHousehold,
    currentCharacter, peekPass, nextCharacter, passTurn, beginMigration, migrateApart, apartCompanions, giveTurnTo, migrationUnderway, canPlayMigrationScene,
    chooseScene, shareTradition, witnessTradition, localDecks, witnessOptions, setShareRecipient, passOnTradition,
    layDownExcess, migrationCards, migrationSavers, finishMigrationScene, saveTradition, leaveBehind, isArrival, migrateFamily, settleHomes,
    distance, isDerivedDistance, distanceLocations, travelReach, migrationDestinations, travelTargets,
    beginEndingChapter, markAge, unmarkAge, holdTraditions, discardPool, closeChapter, startNewChapter, closeSession, newSession,
    deathResult, becomeMemory, checkForgotten, memoryMoveToken, memoryPlay, memoryGive, birth, retireLeavers,
    boroughArrives, boroughLeaves, boroughLine, fateOutcome,
  };
});
