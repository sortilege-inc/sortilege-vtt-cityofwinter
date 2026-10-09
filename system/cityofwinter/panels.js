// system/cityofwinter/panels.js — the table, as panels in the family's shell.
//
// The stage (whose turn it is, which step of which procedure, the book's words for it and the
// choices it offers) · the location (the Home or where a character is visiting, its Scenes with
// the tokens on them) · the family (the notecards) · turn order and decks · the record · the
// rules, the atlas, the traditions · the campaign. Every change goes through a named op
// (system/cityofwinter/ops.js); every rule shown is looked up by name in the corpus.
//
// Carried from the first play surface (city-of-winter/web/table/table.js, 2026-09) and split
// into panels; the facilitator's page and the player's page draw the same ones.
window.CowPanels = (function () {
  const UI = window.CowUI;
  const { el, add, clear, choose, modal, marksRow, shapeIcon, ruleText, details, dieFace, rollDie, fmtTime, miniMarkdown } = UI;
  const D = window.CowData;
  const R = window.CowRules;
  const State = window.VttState;
  const Bus = window.VttBus;
  const Panels = window.VttPanels;
  const TOKENS = R.TOKENS;
  const BOROUGH = R.BOROUGH;
  const SETUP = 'First Session Setup';

  /** Things only this window needs to remember — never saved, never shared. */
  const ui = {
    look: new Set(),        // notecards whose hand is turned face up
    holdFor: null,          // setup step 6: whose hand the spread is filling
    witness: null,          // { picks:[], to }
    memTarget: null,        // Memory Scene: whose token is being moved
    carry: null,            // Migration Scene: Set of card ids carried
    keep: {},               // Ending a Chapter: chId -> Set of card ids carried
    passPick: null,         // City witness: which card is passed on
    travel: false,          // the Travel list is open
    migrateScene: false,    // the Migration Scene is being played
    peek: null,             // a witnessed card being read privately
    apart: null,            // Migrate Apart: who joins
  };

  /* ----------------------------------------------------------------- helpers */

  const S = () => R.view(State.state);
  const card = (id) => D.byCard.get(id);
  const chById = (id) => S().characters.find((c) => c.id === id);
  const tok = (ch, opts) => UI.tokenEl(ch, TOKENS, opts);
  const cardEl = (c, opts) => UI.cardEl(c, D.byDeck.get(c.deck), D.palette(c.deck), opts);
  const me = () => (window.VttSession && window.VttSession.memberId()) || null;
  /** Commit a game op: the args object carries when and who, so every window agrees. */
  function commit(name, p) {
    State.commit(name, [Object.assign({ at: Date.now(), who: me() }, p || {})]);
  }
  /** Redraw this window's panels after a change that is only this window's (a pick, a fold). */
  function bump() { Bus.emit('cow:ui', null, { local: true }); }
  function redrawOn(ctx, draw) {
    ctx.on('state:changed', draw);
    ctx.on('state:remote', draw);
    ctx.on('cow:ui', draw);
  }

  const instr = (text) => ruleText(text, { cls: 'instr' });
  const teach = (text) => ruleText(text, { cls: 'teach aloud' });

  /** The one sentence of a rule that contains `needle` — quoted whole, never trimmed. */
  function sentence(text, needle) {
    const all = String(text).split(/\n+/).flatMap((p) => p.match(/[^.!?]+[.!?]+[”’)]*/g) || [p]);
    return (all.find((s) => s.includes(needle)) || '').trim();
  }

  /** The Location a character is at right now: where they travelled, or Home. */
  function whereIs(st, ch) {
    return D.byLocation.get((ch && ch.visiting) || R.homeOf(st, ch)) || null;
  }

  /** "Our Home", or whose Home it is when the family lives apart. */
  function homeLabel(st, name) {
    if (name === st.family.home) return R.households(st).length > 1 ? 'The family’s Home' : 'Our Home';
    const there = R.livingCharacters(st).filter((c) => R.homeOf(st, c) === name);
    return there.length ? `Home to ${there.map((c) => c.name).join(' & ')}` : null;
  }

  const locName = (name) => (name === BOROUGH && D.wanderingBorough.printedTitle) || name;

  function who(ch, extra) {
    return el('span', { class: 'who' }, tok(ch, { size: 'sm' }), el('span', { text: ch.name }), extra || null);
  }

  /** Buttons for choosing a character (or several: pass a Set), each wearing their token. */
  function pickChars(chars, selected, onPick, opts) {
    opts = opts || {};
    const on = (c) => (selected instanceof Set ? selected.has(c.id) : c.id === selected);
    return el('div', { class: 'pickrow' }, chars.map((c) => el('button', {
      type: 'button', class: `pick ${on(c) ? 'on' : ''}`.trim(), 'aria-pressed': String(on(c)), disabled: opts.disabled ? opts.disabled(c) : false,
      onclick: () => onPick(c),
    }, tok(c, { size: 'sm' }), el('span', { text: c.name }), opts.note && opts.note(c) ? el('span', { class: 'note', text: opts.note(c) }) : null)));
  }

  /** The steps of a procedure, as the book numbers them, with where we are. */
  function stepper(procName, active, names) {
    const steps = names || D.proc(procName).steps.map((s) => s.name);
    const act = [].concat(active);
    const first = Math.min.apply(null, act);
    return el('ol', { class: 'stepper', 'aria-label': procName }, steps.map((nm, i) => {
      const n = i + 1;
      const cls = act.includes(n) ? 'on' : n < first ? 'done' : '';
      return el('li', { class: cls, 'aria-current': act.includes(n) ? 'step' : null }, el('span', { class: 'n', text: n }), el('span', { class: 'nm', text: nm }));
    }));
  }

  function stepBlock(n, name, state) {
    const kids = Array.prototype.slice.call(arguments, 3);
    return el('section', { class: `stepblock ${state || ''}`.trim() },
      el('h4', {}, el('span', { class: 'n', text: n }), name, state === 'done' ? el('span', { class: 'tick', text: '✓' }) : null), kids);
  }

  function stageHead(eyebrow, title, ch, cite) {
    return el('header', { class: 'stagehead' }, ch ? tok(ch, { size: 'lg' }) : null,
      el('div', { class: 'grow' }, el('div', { class: 'eyebrow', text: eyebrow }), el('h2', { text: title })),
      cite ? window.CowReader.cite(cite) : null);
  }

  /** The datalist of names a Bond may be with: the family, the side-characters, every Banner. */
  function namesList(st) {
    let dl = document.getElementById('allnames');
    if (!dl) { dl = el('datalist', { id: 'allnames' }); document.body.append(dl); }
    clear(dl);
    add(dl, [...st.characters.map((c) => c.name), ...st.sideCharacters.map((c) => c.name), ...D.decks.flatMap((k) => k.names || [])]
      .filter((v, i, a) => v && a.indexOf(v) === i).map((n) => el('option', { value: n })));
  }

  /* ================================================================== SETUP === */

  function renderSetup(st) {
    const steps = D.proc(SETUP).steps;
    const stage = (st.setup && st.setup.stage) || 0;
    const wrap = el('div', { class: 'setup' });
    add(wrap, el('div', { class: 'setuphead' }, el('div', { class: 'eyebrow', text: 'Before we play' }), el('h1', { text: SETUP })));
    const reachable = (i) => i <= stage || i <= maxSetupStage(st);
    add(wrap, el('ol', { class: 'stepper big' }, steps.map((s, i) => el('li', { class: i === stage ? 'on' : i < stage ? 'done' : '' },
      el('button', { type: 'button', disabled: !reachable(i) || i === stage, onclick: () => commit('setupStage', { stage: i }) },
        el('span', { class: 'n', text: s.n }), el('span', { class: 'nm', text: s.name }))))));
    const step = steps[stage];
    const panel = el('div', { class: 'panel setupstep' });
    add(panel, el('div', { class: 'setuphead-row' }, el('div', { class: 'grow' }, el('div', { class: 'eyebrow', text: `Step ${step.n} of ${steps.length}` }), el('h2', { text: step.name })), window.CowReader.cite(`${step.n}. ${step.name}`, step.name)));
    add(panel, [setupIntro, setupHome, setupNames, setupAge, setupBonds, setupHold, setupTokens, setupUmbra][stage](st, step));
    add(wrap, panel);
    return wrap;
  }

  function maxSetupStage(st) {
    if (!st.family.home) return 1;
    if (!st.characters.length) return 2;
    if (st.characters.some((c) => c.hand.length < R.handLimit(c))) return 5;
    return 7;
  }

  function setupNav(st, o) {
    o = Object.assign({ back: true, next: 'Next', ok: true, why: '' }, o || {});
    const i = st.setup.stage;
    return el('div', { class: 'setupnav' },
      o.back && i > 0 ? el('button', { class: 'ghost', text: '← Back', onclick: () => commit('setupStage', { stage: i - 1 }) }) : el('span'),
      el('span', { class: 'grow' }),
      o.why ? el('span', { class: 'small muted', text: o.why }) : null,
      o.next ? el('button', { class: 'primary', text: `${o.next} →`, disabled: !o.ok, onclick: () => commit('setupStage', { stage: i + 1 }) }) : null);
  }

  function xcard() {
    const ss = D.substep(SETUP, 'Introduction', 'Safety and the X-Card');
    UI.xcard(ss.teaching, 'The X-Card was created by John Stavropoulos.');
  }

  function setupIntro(st, step) {
    return el('div', {}, instr(step.instruction),
      el('div', { class: 'readaloud' }, step.substeps.map((ss) => el('section', {}, el('h3', { text: ss.name }), teach(ss.teaching),
        ss.name.includes('X-Card') ? el('button', { class: 'xbtn', text: '✕ The X-Card', onclick: xcard }) : null))),
      setupNav(st, { back: false, next: 'Choose our home' }));
  }

  function setupHome(st, step) {
    const city = st.setup.start === 'city';
    const box = el('div', {});
    if (!city) add(box, instr(step.instruction), teach(step.teaching));
    const pickHome = (home, tradition, region) => commit('chooseHome', { home, tradition, region });
    if (!city) {
      add(box, el('div', { class: 'homes' }, D.startingHomes.map((loc) => homeCard(loc, loc.traditions[0], st.family.home === loc.name, () => pickHome(loc.name, loc.traditions[0], 'Riverlands')))));
    } else {
      add(box, el('div', { class: 'callout' }, el('h3', { text: 'Starting in the City' }),
        instr(D.rule('Starting in the City').split(/\n\s*\n/)[0]),
        details('Plan for a longer setup', instr(D.guidanceText('plan-for-a-longer-setup')))));
      add(box, el('div', { class: 'homes' }, D.cityStartingOptions.map((o) => {
        const home = /wandering/i.test(o.home) ? BOROUGH : o.home;
        return homeCard(D.byLocation.get(home), o.tradition, st.family.home === home, () => pickHome(home, o.tradition, 'City'), o.text);
      })));
    }
    const variants = el('div', { class: 'variants' });
    add(variants, el('div', { class: 'segmented', role: 'group', 'aria-label': 'Where the family begins' },
      el('button', { class: city ? '' : 'on', 'aria-pressed': String(!city), text: 'Begin on the River Scroll', onclick: () => city && commit('setStart', { start: 'riverlands' }) }),
      el('button', { class: city ? 'on' : '', 'aria-pressed': String(city), text: 'Begin in the City', onclick: () => !city && commit('setStart', { start: 'city' }) })));
    add(variants, variantToggles(st, ['The Umbra Follows', 'Fleeing the City', 'Solo Play']));
    const vd = details('Variants and other ways to begin', variants);
    vd.open = city || Object.values(st.variants).some(Boolean);
    add(box, vd, setupNav(st, { next: 'Choose names', ok: !!st.family.home, why: st.family.home ? '' : 'Choose a home to go on.' }));
    return box;
  }

  function homeCard(loc, deck, on, onclick, label) {
    const k = D.byDeck.get(deck);
    return el('button', { type: 'button', class: `homecard ${on ? 'on' : ''} ${loc.region === 'City' ? 'city' : 'river'}`.trim(), 'aria-pressed': String(on), onclick },
      el('span', { class: 'cat' }, shapeIcon(k && k.shape), label || deck),
      el('span', { class: 'nm', text: locName(loc.name) }),
      el('span', { class: 'scenes', text: loc.scenes.join(' · ') }),
      on ? el('span', { class: 'chosen', text: 'Our home' }) : null);
  }

  /** Optional rules, each with the book's own description. */
  function variantToggles(st, names) {
    return el('div', { class: 'toggles' }, names.map((nm) => {
      const o = D.optional(nm);
      const on = !!st.variants[nm];
      const locked = nm === 'Fleeing the City' && st.setupComplete;
      return el('div', { class: `toggle ${on ? 'on' : ''}`.trim() },
        el('label', {}, el('input', { type: 'checkbox', checked: on, disabled: locked, onchange: (e) => commit('setVariant', { name: nm, on: e.target.checked }) }), el('span', { class: 'tname', text: nm })),
        instr(o.optionalText), details('The rule', instr(o.text)));
    }));
  }

  function setupNames(st, step) {
    const deck = D.byDeck.get(st.family.tradition);
    const used = new Set([...st.characters.map((c) => c.name), ...st.sideCharacters.map((c) => c.name)]);
    const name = el('input', { id: 'newname', placeholder: 'a name from the Banner', autocomplete: 'off' });
    const pron = el('input', { id: 'newpron', placeholder: 'optional' });
    const submit = () => {
      const n = name.value.trim();
      if (!n) { name.focus(); return; }
      commit('addMember', { id: State.genId('ch'), name: n, pronouns: pron.value.trim(), templateId: (D.named('Main Character') || {}).id });
      setTimeout(() => { const f = document.getElementById('newname'); if (f) f.focus(); }, 0);
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    pron.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    return el('div', {}, instr(step.instruction), teach(step.teaching),
      st.variants['Solo Play'] ? el('div', { class: 'callout small' }, instr(D.guidanceText('solo-first-session'))) : null,
      el('div', { class: 'banner' },
        el('div', { class: 'bannerhead' }, shapeIcon(deck.shape), el('span', { text: `${deck.banner} Banner` })),
        el('div', { class: 'namechips' }, deck.names.map((n) => el('button', { type: 'button', class: 'namechip', text: n, disabled: used.has(n), onclick: () => { name.value = n; pron.focus(); } }))),
        el('div', { class: 'nameprompt', text: deck.namePrompt })),
      el('div', { class: 'addrow' }, el('label', {}, 'Name', name), el('label', {}, 'Pronouns', pron), el('button', { class: 'primary', text: 'Add to the family', onclick: submit })),
      st.characters.length ? el('div', {}, el('h3', { text: 'Our family' }), el('p', { class: 'small muted', text: 'Listed in turn order.' }),
        el('ol', { class: 'roster' }, st.characters.map((c, i) => el('li', {},
          tok(c), el('b', { text: c.name }), c.pronouns ? el('span', { class: 'pronouns', text: c.pronouns }) : null, el('span', { class: 'grow' }),
          el('button', { class: 'tiny ghost', text: '↑', title: 'Earlier in turn order', disabled: i === 0, onclick: () => commit('moveMember', { id: c.id, dir: -1 }) }),
          el('button', { class: 'tiny ghost', text: '↓', title: 'Later in turn order', disabled: i === st.characters.length - 1, onclick: () => commit('moveMember', { id: c.id, dir: 1 }) }),
          el('button', { class: 'tiny ghost', text: 'Remove', onclick: () => commit('removeMember', { id: c.id }) }))))) : null,
      setupNav(st, { next: 'Mark Age', ok: st.characters.length > 0, why: st.characters.length ? '' : 'Add at least one character.' }));
  }

  function setupAge(st, step) {
    return el('div', {}, teach(step.teaching),
      el('div', { class: 'agelist' }, st.characters.map((c) => {
        const tier = D.tierForMarks(c.marks);
        const setMarks = (m) => commit('setMarks', { id: c.id, marks: m });
        const tierRow = D.ageTiers.find((t) => t.name === tier) || { marks: [] };
        return el('div', { class: 'agerow' }, who(c),
          el('div', { class: 'segmented', role: 'group', 'aria-label': `${c.name}’s age` }, D.ageTiers.map((t) =>
            el('button', { class: tier === t.name ? 'on' : '', 'aria-pressed': String(tier === t.name), text: t.name, onclick: () => tier === t.name || setMarks(t.marks[0]) }))),
          el('div', { class: 'markpick' }, tierRow.marks.length > 1
            ? tierRow.marks.map((m) => el('button', { type: 'button', class: `mp ${c.marks === m ? 'on' : ''}`.trim(), 'aria-pressed': String(c.marks === m), title: `${m} Marks`, onclick: () => setMarks(m) }, marksRow(m, 0)))
            : marksRow(c.marks, 0)));
      })),
      setupNav(st, { next: 'Make Bonds' }));
  }

  function setupBonds(st, step) {
    const deck = D.byDeck.get(st.family.tradition);
    const mains = new Set(st.characters.map((c) => c.name));
    return el('div', {}, teach(step.teaching),
      el('div', { class: 'bondgrid' }, st.characters.map((c) => {
        const withMain = c.bonds.some((b) => mains.has(b.subject));
        const status = c.bonds.length < 2 ? `${c.bonds.length} of 2 Bonds` : withMain || st.characters.length === 1 ? 'Two Bonds' : 'Needs a Bond with another main character';
        const ok = c.bonds.length >= 2 && (withMain || st.characters.length === 1);
        return el('div', { class: 'bondcard' },
          el('div', { class: 'bondhead' }, who(c, el('span', { class: 'tierlabel', text: D.tierForMarks(c.marks) })), el('span', { class: `status ${ok ? 'ok' : ''}`.trim(), text: status })),
          bondList(c), bondComposer(c, { lists: D.bondsAtOrBelow(D.tierForMarks(c.marks)), banners: [deck], exclude: c.name }));
      })),
      setupNav(st, { next: 'Hold Traditions' }));
  }

  function setupHold(st, step) {
    const deckName = st.family.tradition;
    const pool = st.decks[deckName] || [];
    const choose1 = D.substep(SETUP, 'Hold Traditions', 'Choose Tradition Cards');
    const gather = D.substep(SETUP, 'Hold Traditions', 'Gather the Tradition Deck');
    const needing = st.characters.filter((c) => c.hand.length < R.handLimit(c));
    if (!ui.holdFor || !chById(ui.holdFor) || R.handLimit(chById(ui.holdFor)) === 0) ui.holdFor = (needing[0] || st.characters.find((c) => c.marks > 0) || {}).id || null;
    const forCh = chById(ui.holdFor);
    const give = (id) => {
      if (!forCh || forCh.hand.length >= R.handLimit(forCh)) return;
      commit('holdCard', { id: forCh.id, cardId: id });
      const now = chById(forCh.id);
      if (now && now.hand.length >= R.handLimit(now)) {
        const nxt = S().characters.find((c) => c.hand.length < R.handLimit(c));
        if (nxt) { ui.holdFor = nxt.id; bump(); }
      }
    };
    return el('div', {},
      el('h3', { text: choose1.name }), instr(choose1.instruction), teach(choose1.teaching),
      el('div', { class: 'holdtabs', role: 'tablist' }, st.characters.map((c) => {
        const lim = R.handLimit(c);
        return el('button', { type: 'button', role: 'tab', class: `holdtab ${c.id === ui.holdFor ? 'on' : ''} ${c.hand.length >= lim ? 'full' : ''}`.trim(), 'aria-selected': String(c.id === ui.holdFor), disabled: lim === 0,
          onclick: () => { ui.holdFor = c.id; bump(); } }, tok(c, { size: 'sm' }), el('span', { class: 'nm', text: c.name }), el('span', { class: 'count', text: lim === 0 ? 'Child' : `${c.hand.length}/${lim}` }));
      })),
      forCh ? el('div', { class: 'holding' },
        el('div', { class: 'small muted', text: forCh.hand.length ? `${forCh.name} holds — choose a card to put it back:` : `${forCh.name} holds nothing yet.` }),
        el('div', { class: 'cardrow' }, forCh.hand.map((id) => cardEl(card(id), { onclick: () => commit('putBack', { id: forCh.id, cardId: id }), title: 'Put it back' })))) : null,
      el('h4', { text: forCh && forCh.hand.length < R.handLimit(forCh) ? `The spread — choosing for ${forCh.name}` : 'The spread' }),
      el('div', { class: 'cardrow spread' }, pool.map((id) => cardEl(card(id), { onclick: forCh && forCh.hand.length < R.handLimit(forCh) ? () => give(id) : undefined }))),
      el('h3', { text: gather.name }), instr(gather.instruction),
      setupNav(st, { next: 'Choose Tokens', ok: !needing.length, why: needing.length ? `${needing.map((c) => c.name).join(', ')} still ${needing.length === 1 ? 'needs' : 'need'} cards.` : '' }));
  }

  function swatches(st, c, after) {
    return el('div', { class: 'swatches' }, TOKENS.map((t) => {
      const taken = st.characters.find((x) => x.token === t.id && x.id !== c.id);
      return el('button', { type: 'button', class: `swatch ${c.token === t.id ? 'on' : ''}`.trim(), style: `--tok:${t.color}`, title: taken ? `${t.name} — ${taken.name}’s` : t.name, 'aria-label': `${t.name} token`, 'aria-pressed': String(c.token === t.id), disabled: !!taken,
        onclick: () => { commit('setToken', { id: c.id, token: t.id }); if (after) after(); } });
    }));
  }

  function setupTokens(st, step) {
    return el('div', {}, instr(step.instruction), teach(step.teaching),
      el('p', { class: 'small muted', text: 'The boxed Tokens are picture discs; here each character wears a colour and their initial.' }),
      el('div', { class: 'tokengrid' }, st.characters.map((c) => el('div', { class: 'tokenrow' }, who(c), swatches(st, c)))),
      setupNav(st, { next: 'Introduce the Umbra' }));
  }

  function setupUmbra(st, step) {
    const city = st.setup.start === 'city';
    const fleeing = !!st.variants['Fleeing the City'];
    const follows = !!st.variants['The Umbra Follows'];
    const umbra = !city || fleeing || follows;
    const box = el('div', {});
    if (!city) add(box, instr(step.instruction), el('div', { class: 'prelude' }, teach(step.teaching)), instr(step.followUp), teach(step.teachingTwo));
    else if (fleeing) {
      const paras = D.optional('Fleeing the City').text.split(/\n\s*\n/);
      add(box, instr(step.instruction), el('div', { class: 'prelude' }, teach(paras[paras.indexOf('New Prelude') + 1])), instr(step.followUp), teach(step.teachingTwo));
    } else add(box, variantToggles(st, ['The Umbra Follows']), follows ? teach(step.teachingTwo) : null);
    add(box, el('div', { class: 'setupnav' },
      el('button', { class: 'ghost', text: '← Back', onclick: () => commit('setupStage', { stage: 6 }) }), el('span', { class: 'grow' }),
      el('button', { class: 'primary big', text: umbra ? 'Place the Umbra Deck and begin' : 'Begin the first Chapter', onclick: () => commit('beginPlay', { umbra }) })));
    return box;
  }

  /* ================================================================== BONDS === */

  const bondText = (b) => `${b.prompt} ${b.joiner || 'of'} ${b.subject}`;

  function bondList(ch, o) {
    o = o || { removable: true };
    if (!ch.bonds.length) return el('p', { class: 'small muted nobonds', text: 'No Bonds yet.' });
    return el('ul', { class: 'bonds' }, ch.bonds.map((b, i) => el('li', { class: b.city ? 'city' : b.memory ? 'memory' : '' }, el('span', { text: bondText(b) }),
      o.removable !== false ? el('button', { class: 'x', title: 'Remove this Bond', 'aria-label': `Remove ${bondText(b)}`, text: '×', onclick: () => commit('removeBond', { id: ch.id, index: i }) }) : null)));
  }

  /** Compose a Bond: a prompt from the lists this character may use, joined by that list's own word, to a name. */
  function bondComposer(ch, o) {
    o = Object.assign({ banners: [], label: 'Make the Bond', city: false, memory: false }, o || {});
    const opts = [];
    const sel = el('select', { 'aria-label': 'Bond prompt' });
    for (const l of o.lists) {
      const joiner = D.bondJoiner(l);
      const g = el('optgroup', { label: l.kind === 'City Bonds' ? `${l.tier} (City)` : l.kind === 'Memory Bonds' ? 'Memory' : l.tier });
      for (const p of l.prompts) { opts.push({ prompt: p, joiner }); add(g, el('option', { value: opts.length - 1, text: `${p} ${joiner}…` })); }
      const open = D.openPromptWord(l);
      if (open) { opts.push({ prompt: open, joiner }); add(g, el('option', { value: opts.length - 1, text: `${open} ${joiner}…` })); }
      add(sel, g);
    }
    const whom = el('input', { placeholder: 'whom', list: 'allnames', 'aria-label': 'Bond with whom', autocomplete: 'off' });
    const submit = () => {
      const subject = whom.value.trim();
      if (!subject) { whom.focus(); return; }
      const x = opts[Number(sel.value)];
      commit('addBond', { id: ch.id, prompt: x.prompt, joiner: x.joiner, subject, city: o.city, memory: o.memory });
      if (o.onDone) o.onDone();
    };
    whom.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    const st = S();
    const taken = new Set([...st.characters.map((c) => c.name), ...st.sideCharacters.map((c) => c.name)]);
    const mains = st.characters.filter((c) => c.name !== o.exclude && !c.forgotten).map((c) => c.name);
    const chips = el('div', { class: 'namechips small' },
      mains.map((n) => el('button', { type: 'button', class: 'namechip main', text: n, title: 'a main character', onclick: () => { whom.value = n; } })),
      o.banners.flatMap((k) => (k.names || []).filter((n) => !taken.has(n)).map((n) => el('button', { type: 'button', class: 'namechip', text: n, title: `from the ${k.banner} Banner`, onclick: () => { whom.value = n; } }))));
    return el('div', { class: 'composer' }, el('div', { class: 'composerow' }, sel, whom, el('button', { class: 'tiny primary', text: o.label, onclick: submit })), chips);
  }

  /* ============================================================== THE STAGE == */

  /** The chronicle: Chapter, Session, the Home(s), what is in play; Ask Fate, End the Chapter, End the session. */
  function chronicleBar(st) {
    const ph = st.turn.phase;
    const busy = ['end-chapter', 'chapter-start', 'session-closed', 'city-arrival'].includes(ph);
    const midMigration = R.migrationUnderway(st);
    return el('div', { class: 'chronicle' },
      el('div', { class: 'cfield' }, el('span', { class: 'k', text: 'Chapter' }), el('span', { class: 'v', text: st.family.chapter })),
      el('div', { class: 'cfield' }, el('span', { class: 'k', text: 'Session' }), el('span', { class: 'v', text: st.family.session })),
      homesField(st),
      el('div', { class: 'ctags' },
        st.umbraInPlay ? el('span', { class: 'tag umbra', text: 'Umbra Deck in play' }) : null,
        st.borough.inPlay ? el('span', { class: 'tag spire', text: st.borough.station ? `The Borough is at ${st.borough.station}` : 'The Borough wanders' }) : null,
        Object.keys(st.variants).filter((k) => st.variants[k]).map((k) => el('span', { class: 'tag', text: k }))),
      el('span', { class: 'grow' }),
      el('div', { class: 'cactions' },
        el('button', { class: 'tiny', text: '🎲 Ask Fate', onclick: askFateDialog }),
        el('button', { class: 'tiny', text: 'End the Chapter', disabled: busy || midMigration, title: midMigration ? D.guidanceText('chapters-and-pacing').split(/\n\s*\n/).pop() : '',
          onclick: async () => {
            const ok = await choose('End the Chapter?', [{ label: 'Bring the Chapter to a close', value: true, class: 'primary' }], { body: instr(D.proc('Ending a Chapter').instruction) });
            if (ok) commit('beginEndChapter', {});
          } }),
        el('button', { class: 'tiny ghost', text: 'End the session', disabled: busy || midMigration,
          onclick: async () => {
            const ok = await choose('End the session here?', [{ label: 'End the session — the Chapter continues next time', value: true }], { body: el('div', {}, instr(D.guidanceText('chapters-and-pacing'))) });
            if (ok) commit('endSession', {});
          } })));
  }

  function homesField(st) {
    const hh = R.households(st);
    if (hh.length <= 1) {
      return el('div', { class: 'cfield home' }, el('span', { class: 'k', text: st.family.region === 'City' ? 'Home · the City' : 'Home · the Riverlands' }), el('span', { class: 'v', text: locName(st.family.home) || '—' }));
    }
    return el('div', { class: 'cfield home' }, el('span', { class: 'k', text: 'Homes · living apart' }),
      el('span', { class: 'homes-list' }, hh.map((h) => el('span', { class: 'hh' }, el('span', { class: 'v', text: locName(h.home) }), el('span', { class: 'hhtoks' }, h.members.map((c) => tok(c, { size: 'xs' })))))));
  }

  function renderStage(st) {
    const cur = R.currentCharacter(st);
    const ph = st.turn.phase;
    const stage = el('section', { class: `stage ph-${ph}`, 'aria-live': 'polite' });
    if (ph === 'chapter-start') return chapterStartStage(st, stage);
    if (ph === 'end-chapter') return endChapterStage(st, stage);
    if (ph === 'session-closed') return sessionClosedStage(st, stage);
    if (ph === 'city-arrival') return cityArrivalStage(st, stage);
    if (ph === 'who-first') return whoFirstStage(st, stage, D.step('Migrate the Family', 'Migrate the family').instruction.split(/\n\s*\n/).pop());
    if (ph === 'migrate-family') return migrateStage(st, stage);
    if (ph === 'apart-offer') return apartOfferStage(st, stage);
    if (!cur) {
      add(stage, stageHead('The family', 'No one can take a turn'), instr(D.rule('Becoming forgotten')),
        el('div', { class: 'btnrow' }, el('button', { class: 'primary', text: 'Birth', onclick: () => birthDialog() })));
      return stage;
    }
    if (cur.isMemory && ['choose-scene', 'memory-share'].includes(ph)) return memoryStage(st, cur, stage);
    if (ui.migrateScene && ph === 'choose-scene') return migrationSceneStage(st, cur, stage);

    const TS = 'Tradition Scene';
    if (ph === 'choose-scene') {
      const s1 = D.step(TS, 'Choose a Scene');
      add(stage, stageHead(`${cur.name}’s turn · ${TS}`, s1.name, cur, TS), stepper(TS, 1), el('p', { class: 'action', text: 'Choose a Scene on the location →' }), instr(s1.instruction));
      const acts = el('div', { class: 'altacts' });
      if (R.regionOf(st, cur) === 'City') add(acts, travelBox(st, cur));
      add(acts, el('div', { class: 'alt' },
        el('button', { class: 'warm', text: 'Play a Migration Scene instead', disabled: !R.canPlayMigrationScene(cur), onclick: () => { ui.migrateScene = true; ui.carry = null; bump(); } }),
        el('div', { class: 'small muted', text: sentence(D.proc('Migration Scene').instruction, 'play a Migration Scene') })));
      add(stage, acts);
      return stage;
    }
    if (ph === 'share-or-witness') {
      const s2 = D.step(TS, 'Share or witness?');
      add(stage, stageHead(`${cur.name}’s turn · ${TS}`, st.turn.scene, cur, TS), stepper(TS, 2), instr(s2.instruction),
        el('div', { class: 'options two' }, shareOption(st, cur, s2), witnessOption(st, cur, s2)),
        el('div', { class: 'btnrow' }, el('button', { class: 'ghost tiny', text: '← Choose a different Scene', onclick: () => commit('unchooseScene', { id: cur.id }) })));
      return stage;
    }
    if (ph === 'lead') return leadStage(st, cur, stage);
    if (ph === 'end-scene') {
      const peek = R.peekPass(st);
      const wasMemory = st.turn.sceneKind === 'memory';
      const text = wasMemory ? D.step('Memory Scene', 'Pass the Turn').instruction : D.step(TS, 'End the Scene').instruction;
      add(stage, stageHead(`${cur.name}’s turn · ${wasMemory ? 'Memory Scene' : TS}`, wasMemory ? 'Pass the Turn' : 'End the Scene', cur, wasMemory ? 'Memory Scene' : TS), stepper(wasMemory ? 'Memory Scene' : TS, 5));
      const btns = el('div', { class: 'btnrow' });
      if (peek) {
        add(btns, el('button', { class: 'primary big', onclick: () => commit('passTurn', {}) },
          peek.kind === 'turn' ? ['Pass the turn to ', tok(peek.c, { size: 'sm' }), ` ${peek.c.name}`]
            : peek.kind === 'migrate' ? (R.households(st).length > 1 ? `Pass the turn — ${peek.household.members.map((c) => c.name).join(' & ')} migrate` : 'Pass the turn — the family migrates') : 'Pass the turn'));
      }
      add(stage, btns, instr(text));
      if (st.variants['Solo Play']) {
        add(stage, el('h4', { text: 'Or act as another main character' }),
          pickChars(R.activeCharacters(st).filter((c) => c.id !== cur.id && !c.hadMigrationScene), null, (c) => commit('giveTurn', { id: c.id, text: `${cur.name} ends the scene; the story turns to ${c.name}.` })));
      }
      return stage;
    }
    add(stage, stageHead('The table', 'The table is quiet'), el('div', { class: 'btnrow' }, el('button', { class: 'primary', text: 'Begin a turn', onclick: () => commit('giveTurn', { id: cur.id, text: '' }) })));
    return stage;
  }

  function travelBox(st, cur) {
    const reach = R.travelTargets(st, cur);
    const box = el('div', { class: 'alt' });
    add(box, el('button', { text: ui.travel ? 'Close the Transit map' : `Travel… (${cur.cityMarks} City Mark${cur.cityMarks === 1 ? '' : 's'})`, disabled: !reach.length && !cur.visiting, onclick: () => { ui.travel = !ui.travel; bump(); } }),
      el('div', { class: 'small muted', text: sentence(D.rule('Transit Lines & Stations'), 'option to Travel') }));
    if (ui.travel) {
      add(box, el('div', { class: 'travel' }, instr(D.rule('Travel')),
        reach.some((r) => r.derived) ? el('p', { class: 'small muted', text: '* Wintermount is absent from the printed distance table; its distances are derived from its Moon Path adjacencies.' }) : null,
        el('div', { class: 'destgrid' }, reach.map((r) => el('button', { type: 'button', class: `dest ${cur.visiting === r.to ? 'on' : ''}`.trim(), onclick: () => { ui.travel = false; commit('travel', { id: cur.id, to: r.to }); } },
          el('span', { class: 'nm', text: locName(r.to) }), el('span', { class: 'cost', text: `${r.cost}${r.derived ? '*' : ''}` })))),
        cur.visiting ? el('button', { class: 'ghost tiny', text: `Return Home to ${locName(R.homeOf(st, cur))}`, onclick: () => { ui.travel = false; commit('travel', { id: cur.id, to: null }); } }) : null));
    }
    return box;
  }

  function shareOption(st, cur, s2) {
    const o = s2.options.find((x) => x.name === 'Share a Tradition');
    const can = cur.hand.length > 0;
    return el('div', { class: `option ${can ? '' : 'off'}`.trim() }, el('h3', { text: o.name }), instr(o.instruction),
      can ? el('div', {}, el('div', { class: 'small muted', text: 'Choose the card from your hand:' }),
        el('div', { class: 'cardrow' }, cur.hand.map((id) => cardEl(card(id), { onclick: () => commit('share', { id: cur.id, cardId: id }) })))) : null);
  }

  function witnessOption(st, cur, s2) {
    const loc = whereIs(st, cur);
    const opts = R.witnessOptions(st, loc.name);
    const inCity = R.regionOf(st, cur) === 'City';
    const solo = !!st.variants['Solo Play'];
    const recips = R.activeCharacters(st).filter((c) => c.id !== cur.id);
    if (!ui.witness || ui.witness.loc !== loc.name || ui.witness.n !== opts.length) {
      ui.witness = { loc: loc.name, n: opts.length, picks: opts.map((o) => (o.blank ? (o.decks.length === 1 ? o.decks[0] : null) : o.decks[0])), to: recips.length === 1 ? recips[0].id : null };
    }
    const w = ui.witness;
    const o = s2.options.find((x) => x.name === 'Witness a Tradition');
    const box = el('div', { class: 'option' }, el('h3', { text: o.name }));
    if (inCity) {
      add(box, instr(D.rule('Witnessing in the City')));
      if (opts.some((x) => x.blank)) add(box, details('Blank Tradition Icons', instr(D.rule('Blank Tradition Icons'))));
    } else add(box, instr(o.instruction));
    if (solo) add(box, details('Solo Play', instr(sentence(D.optional('Solo Play').text, 'When you would Witness'))));
    opts.forEach((op, i) => {
      add(box, el('div', { class: 'drawrow' }, el('span', { class: 'k' }, shapeIcon(op.shape), op.blank ? `Blank ${op.shape} icon` : `${op.decks[0]} icon`),
        el('div', { class: 'deckpicks' }, op.decks.map((d) => el('button', { type: 'button', class: `deckpick ${w.picks[i] === d ? 'on' : ''} ${d === 'Umbra' ? 'umbra' : ''}`.trim(), 'aria-pressed': String(w.picks[i] === d), onclick: () => { w.picks[i] = d; bump(); } },
          shapeIcon((D.byDeck.get(d) || {}).shape), d)))));
    });
    add(box, el('div', { class: 'k small', text: solo ? 'Give the cards to (optional in Solo Play)' : 'Give the cards to' }),
      pickChars(recips, w.to, (c) => { w.to = w.to === c.id ? null : c.id; bump(); }),
      details('Juggling roles', instr(D.guidanceText('role-juggling'))));
    const ready = w.picks.every(Boolean) && (w.to || solo);
    add(box, el('div', { class: 'btnrow' }, el('button', { class: 'primary', text: `Draw ${w.picks.length} card${w.picks.length === 1 ? '' : 's'}`, disabled: !ready,
      onclick: () => { const p = { id: cur.id, to: w.to, picks: w.picks.slice() }; ui.witness = null; ui.passPick = null; commit('witness', p); } })));
    return box;
  }

  function leadStage(st, cur, stage) {
    const TS = 'Tradition Scene';
    const s3 = D.step(TS, 'Lead the scene');
    const kind = st.turn.sceneKind;
    add(stage, stageHead(`${cur.name}’s turn · ${TS}`, st.turn.scene, cur, TS), stepper(TS, [3, 4]), el('h4', { text: s3.name }), instr(s3.instruction),
      details('Scene Advice', el('div', { class: 'lore', html: miniMarkdown(D.loreByTitle('Scene Advice').markdown.replace(/^# .*\n/, '')) })));
    const s4 = D.step(TS, 'Pass on the Tradition');
    add(stage, el('h4', { text: s4.name }), instr(s4.instruction));
    const entries = st.table;

    if (kind === 'share') {
      const t = entries[0];
      const o = s4.options.find((x) => x.name === 'Share the Tradition');
      const recips = R.livingCharacters(st).filter((c) => c.id !== cur.id);
      add(stage, el('div', { class: 'tablecards' }, entries.map((e) => el('div', { class: 'tslot' },
        cardEl(card(e.cardId), { facedown: !e.revealed, onclick: () => commit('reveal', { cardId: e.cardId }), title: e.revealed ? 'Turn it face down' : 'Turn it over' }),
        el('span', { class: 'small muted', text: e.revealed ? 'played' : 'face down — turn it over when you share it' })))),
      instr(o.instruction), el('div', { class: 'k small', text: 'Share it with' }),
      pickChars(recips, t && t.to, (c) => commit('setRecipient', { cardId: t.cardId, to: c.id })),
      el('div', { class: 'btnrow' }, el('button', { class: 'primary big', text: t && t.to ? `Pass the card to ${(chById(t.to) || {}).name}` : 'Pass on the Tradition', disabled: !t || !t.to, onclick: () => commit('passOn', { cardId: t.cardId }) })));
      return stage;
    }

    const o = s4.options.find((x) => x.name === 'Witness the Tradition');
    const holder = entries[0] && entries[0].to ? chById(entries[0].to) : null;
    const inCity = R.regionOf(st, cur) === 'City';
    const passable = entries.filter((e) => !(card(e.cardId).borough && e.revealed));   // a face-down card must not give itself away
    if (!passable.some((e) => e.cardId === ui.passPick)) ui.passPick = passable.length === 1 ? passable[0].cardId : null;
    add(stage, holder ? el('p', { class: 'holder' }, who(holder), ` holds ${entries.length === 1 ? 'the card' : `${entries.length} cards`} and reads ${entries.length === 1 ? 'it' : 'them'} privately.`) : null,
      instr(o.instruction), inCity && entries.length > 1 ? details('During a scene (City)', instr(D.rule('During a scene'))) : null);
    add(stage, el('div', { class: 'tablecards' }, entries.map((e) => {
      const c = card(e.cardId);
      const peeking = ui.peek === e.cardId;
      const slot = el('div', { class: `tslot ${ui.passPick === e.cardId ? 'kept' : ''}`.trim() }, cardEl(c, { facedown: !e.revealed && !peeking }));
      const peekBtn = el('button', { class: 'tiny ghost', text: peeking ? 'Reading…' : 'Hold to read privately', disabled: e.revealed });
      peekBtn.addEventListener('pointerdown', (ev) => { ev.preventDefault(); ui.peek = e.cardId; bump(); });
      for (const evn of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) peekBtn.addEventListener(evn, () => { if (ui.peek) { ui.peek = null; bump(); } });
      add(slot, el('div', { class: 'slotacts' }, e.revealed ? null : peekBtn,
        el('button', { class: 'tiny', text: e.revealed ? 'Played' : 'Play it', disabled: e.revealed, onclick: () => { commit('reveal', { cardId: e.cardId, on: true }); if (c.borough) boroughPanel(); } }),
        entries.length > 1 && !(c.borough && e.revealed) ? el('button', { class: `tiny ${ui.passPick === e.cardId ? 'primary' : 'ghost'}`, text: ui.passPick === e.cardId ? 'Passed on' : 'Pass this one', onclick: () => { ui.passPick = e.cardId; bump(); } }) : null,
        c.borough && e.revealed ? el('span', { class: 'small muted', text: 'See The Borough Wanders, below.' }) : null));
      return slot;
    })));
    if (entries.some((e) => card(e.cardId).borough && e.revealed)) {
      add(stage, el('div', { class: 'callout borough' }, instr(D.rule('The Borough Wanders')), el('div', { class: 'btnrow' }, el('button', { class: 'tiny', text: 'The Wandering Borough…', onclick: boroughPanel }))));
    }
    const pick = ui.passPick;
    add(stage, el('div', { class: 'btnrow' }, el('button', { class: 'primary big', text: pick ? `Pass the card to ${cur.name}` : passable.length ? 'Choose the card to pass on' : 'End the scene — nothing to pass on', disabled: passable.length > 0 && !pick,
      onclick: () => { const p = pick; ui.passPick = null; commit('passOn', { cardId: p }); } })));
    return stage;
  }

  function migrationSceneStage(st, cur, stage) {
    const MS = 'Migration Scene';
    const proc = D.proc(MS);
    const lim = R.handLimit(cur);
    if (!ui.carry) ui.carry = new Set(cur.hand.slice(0, lim));
    const over = cur.hand.length > lim;
    add(stage, stageHead(`${cur.name}’s turn`, MS, cur, MS), stepper(MS, [1, 2, 3]), details('What a Migration Scene is', instr(proc.instruction)),
      stepBlock(1, proc.steps[0].name, '', instr(proc.steps[0].instruction)),
      stepBlock(2, proc.steps[1].name, '', instr(proc.steps[1].instruction),
        over ? el('div', {}, el('p', { class: 'small', text: `${cur.name} may carry ${lim} — carrying ${ui.carry.size}.` }),
          el('div', { class: 'cardrow' }, cur.hand.map((id) => cardEl(card(id), { chosen: ui.carry.has(id), dim: !ui.carry.has(id), onclick: () => { if (ui.carry.has(id)) ui.carry.delete(id); else if (ui.carry.size < lim) ui.carry.add(id); bump(); } }))))
          : el('p', { class: 'small muted', text: `${cur.name} holds ${cur.hand.length} of ${lim} and carries everything.` })),
      stepBlock(3, proc.steps[2].name, '', instr(proc.steps[2].instruction),
        el('div', { class: 'btnrow' }, el('button', { class: 'ghost', text: '← Not yet', onclick: () => { ui.migrateScene = false; bump(); } }),
          el('button', { class: 'primary big', text: 'Pass the turn', disabled: over && ui.carry.size !== lim, onclick: () => { const keep = over ? [...ui.carry] : cur.hand.slice(); ui.migrateScene = false; ui.carry = null; commit('migrationScene', { id: cur.id, keep }); } }))));
    return stage;
  }

  function migrateStage(st, stage) {
    const MF = 'Migrate the Family';
    const proc = D.proc(MF);
    const [s1, s2, s3, s4] = proc.steps;
    const dests = R.migrationDestinations(st);
    const m = st.migration || { destination: null, entrance: null };
    const dest = m.destination;
    const arrival = dest && R.isArrival(dest);
    const destLoc = dest ? D.byLocation.get(dest) : null;
    const short = R.migrationSavers(st);
    const cards = R.migrationCards(st);
    const group = (m.group || []).map(chById).filter(Boolean);
    const whole = !m.apart && R.households(st).length <= 1;
    const fromRegion = (D.byLocation.get(m.from || st.family.home) || {}).region;
    const gnames = group.map((c) => c.name).join(' & ');
    add(stage, stageHead(m.apart || !whole ? `${gnames} · from ${locName(m.from)}` : 'The whole family', m.apart ? 'Migrate Apart' : MF, null, m.apart ? 'Migrate apart' : MF),
      stepper(MF, [!dest || (arrival && !m.entrance) ? 1 : cards.length ? (short.length ? 2 : 3) : 4]),
      m.apart ? el('div', { class: 'callout' }, el('h3', { text: 'Migrate apart' }), instr(D.rule('Migrate apart')), details('Living apart', instr(D.guidanceText('different-homes'))))
        : whole ? instr(proc.instruction) : el('div', {}, instr(proc.instruction), details('Living apart', instr(D.guidanceText('different-homes')))),
      group.length ? el('div', { class: 'pickrow' }, group.map((c) => el('span', { class: 'pick on' }, tok(c, { size: 'sm' }), el('span', { text: c.name })))) : null);
    add(stage, stepBlock(1, s1.name, dest && (!arrival || m.entrance) ? 'done' : '',
      instr(fromRegion === 'City' ? D.rule('Migration in the City') : s1.instruction),
      dests.some((d) => d.route) ? details('By ship or by caravan', instr(D.guidanceText('by-ship-or-by-caravan'))) : null,
      el('div', { class: 'destgrid' }, dests.map((d) => el('button', { type: 'button', class: `dest ${dest === d.to ? 'on' : ''}`.trim(), 'aria-pressed': String(dest === d.to), onclick: () => commit('setDestination', { to: d.to }) },
        el('span', { class: 'nm', text: locName(d.to) }), el('span', { class: 'why', text: d.why }),
        el('span', { class: 'trads' }, ((D.byLocation.get(d.to) || {}).traditions || []).map((t) => shapeIcon(t.startsWith('ANY:') ? t.slice(4) : (D.byDeck.get(t) || {}).shape)))))),
      arrival ? el('div', { class: 'entrances' }, el('h4', { text: locName(dest) }),
        el('div', { class: 'destgrid' }, destLoc.entrances.map((e) => el('button', { type: 'button', class: `dest entrance ${m.entrance === e.target ? 'on' : ''}`.trim(), 'aria-pressed': String(m.entrance === e.target), onclick: () => commit('setEntrance', { target: e.target }) }, el('span', { class: 'nm', text: e.text }))))) : null));
    const saveable = cards.length && short.length;
    add(stage, stepBlock(2, s2.name, !saveable ? 'done' : '', instr(s2.instruction),
      saveable ? el('div', { class: 'poolsave' }, cards.map((id) => el('div', { class: 'tslot' }, cardEl(card(id)),
        el('div', { class: 'slotacts' }, short.map((c) => el('button', { class: 'tiny', title: `${c.name} saves it`, onclick: () => commit('saveCard', { id: c.id, cardId: id }) }, tok(c, { size: 'xs' }), ` ${c.name}`)))))) : el('p', { class: 'small muted', text: cards.length ? 'Every hand is full.' : 'Nothing was left face-up.' })));
    add(stage, stepBlock(3, s3.name, !cards.length ? 'done' : '', instr(s3.instruction),
      cards.length ? el('div', { class: 'poolsave' }, cards.map((id) => el('div', { class: 'tslot' }, cardEl(card(id)), el('div', { class: 'slotacts' }, el('button', { class: 'tiny danger', text: 'Left behind', onclick: () => commit('leaveCard', { cardId: id }) }))))) : null));
    const target = arrival ? m.entrance : dest;
    const ready = target && !cards.length;
    add(stage, stepBlock(4, s4.name, '', instr(s4.instruction),
      el('div', { class: 'btnrow' }, el('button', { class: 'primary big', disabled: !ready,
        text: ready ? `Migrate to ${locName(target)}` : !dest ? 'Choose a destination first' : arrival && !m.entrance ? 'Choose how we enter the City' : 'Save or leave behind every face-up card first',
        onclick: () => commit('migrate', { target, arrival: arrival ? destLoc.entrances.find((e) => e.target === target).text : null }) }))));
    return stage;
  }

  function apartOfferStage(st, stage) {
    const c = chById(st.turn.offer) || R.currentCharacter(st);
    const MS = D.proc('Migration Scene');
    const companions = R.apartCompanions(st, c);
    if (!ui.apart || ui.apart.for !== c.id) ui.apart = { for: c.id, join: new Set() };
    const join = ui.apart.join;
    add(stage, stageHead(`${c.name}’s turn · waiting to migrate`, 'Migrate Apart?', c, 'Migrate apart'), instr(MS.steps[2].instruction),
      el('div', { class: 'callout' }, instr(D.rule('Migrate apart')), details('Living apart', instr(D.guidanceText('different-homes')))),
      el('div', { class: 'options two' },
        el('div', { class: 'option' }, el('h3', { text: 'Wait for the family' }), el('p', { class: 'small muted', text: `${c.name}’s turn passes to the next player.` }),
          el('button', { text: 'Skip the turn', onclick: () => commit('passTurn', { text: `${c.name} waits for the family.` }) })),
        el('div', { class: 'option' }, el('h3', { text: 'Migrate Apart' }),
          companions.length ? el('div', {}, el('div', { class: 'k small', text: 'Who joins them?' }), pickChars(companions, join, (x) => { if (join.has(x.id)) join.delete(x.id); else join.add(x.id); bump(); }, { note: (x) => (join.has(x.id) ? 'joins' : '') }))
            : el('p', { class: 'small muted', text: 'No one else has had their Migration Scene yet.' }),
          el('button', { class: 'warm', text: join.size ? `Migrate Apart — ${[c, ...companions.filter((x) => join.has(x.id))].map((x) => x.name).join(' & ')}` : `${c.name} migrates apart`,
            onclick: () => { const ids = [...join]; ui.apart = null; commit('migrateApart', { id: c.id, joiners: ids }); } }))));
    return stage;
  }

  function cityArrivalStage(st, stage) {
    const P = D.proc('Migrating to the City');
    add(stage, stageHead('The City of Winter', P.name, null, P.name), instr(P.instruction), P.steps.map((s) => stepBlock(s.n, s.name, 'done', instr(s.instruction))),
      el('div', { class: 'btnrow' }, el('button', { class: 'primary big', text: 'Open the City Map', onclick: () => commit('openCityMap', {}) })));
    return stage;
  }

  function whoFirstStage(st, stage, text) {
    add(stage, stageHead(locName(st.family.home), 'Who takes the first turn?', null, 'Migrate the Family'), instr(text),
      pickChars(R.activeCharacters(st), null, (c) => commit('giveTurn', { id: c.id, text: `${c.name} takes the first turn.` })));
    return stage;
  }

  function memoryStage(st, cur, stage) {
    const MS = 'Memory Scene';
    const proc = D.proc(MS);
    const [s1, s2, s3, s4] = proc.steps;
    const ph = st.turn.phase;
    const targets = R.livingCharacters(st).filter((c) => c.id !== cur.id);
    if (ph === 'choose-scene') {
      add(stage, stageHead(`${cur.name}’s turn · a Memory`, MS, cur, MS), stepper(MS, 1), details('Playing a Memory', instr(proc.instruction)), instr(s1.instruction));
      if (!targets.length) {
        add(stage, el('p', { class: 'muted', text: 'There is no living character whose token could be moved.' }), el('div', { class: 'btnrow' }, el('button', { class: 'primary', text: 'Pass the turn', onclick: () => commit('passTurn', {}) })));
        return stage;
      }
      if (!targets.some((t) => t.id === ui.memTarget)) ui.memTarget = targets.length === 1 ? targets[0].id : null;
      add(stage, el('div', { class: 'k small', text: 'Whose token?' }), pickChars(targets, ui.memTarget, (c) => { ui.memTarget = c.id; bump(); }),
        ui.memTarget ? el('p', { class: 'small muted', text: `Now choose a Scene on the location for ${chById(ui.memTarget).name}.` }) : null);
      return stage;
    }
    const target = chById(st.turn.memoryTarget);
    const played = st.table.find((t) => t.kind === 'memory');
    add(stage, stageHead(`${cur.name}’s turn · a Memory`, st.turn.scene, cur, MS), stepper(MS, played ? [3, 4] : 2),
      stepBlock(2, s2.name, played ? 'done' : '', instr(s2.instruction),
        played ? el('div', { class: 'tablecards' }, el('div', { class: 'tslot' }, cardEl(card(played.cardId), { facedown: !played.revealed, onclick: () => commit('reveal', { cardId: played.cardId }) })))
          : el('div', { class: 'cardrow' }, cur.hand.map((id) => cardEl(card(id), { onclick: () => commit('memoryPlay', { id: cur.id, cardId: id }) })))),
      played ? stepBlock(3, s3.name, '', instr(s3.instruction)) : null,
      played ? stepBlock(4, s4.name, '', instr(s4.instruction), el('div', { class: 'btnrow' }, el('button', { class: 'primary big', text: `Give the card to ${target ? target.name : '?'}`, onclick: () => commit('memoryGive', {}) }))) : null);
    return stage;
  }

  function endChapterStage(st, stage) {
    const EC = 'Ending a Chapter';
    const proc = D.proc(EC);
    const [s1, s2, s3, s4] = proc.steps;
    const ce = st.chapterEnd || { marked: {} };
    const living = R.livingCharacters(st);
    const cityOf = (c) => R.regionOf(st, c) === 'City';
    const inCity = living.some(cityOf);
    const allMarked = living.every((c) => ce.marked[c.id]);
    const gained = living.filter((c) => ['age', 'city'].includes(ce.marked[c.id]));
    const overs = living.filter((c) => c.hand.length > R.handLimit(c));
    const unders = living.filter((c) => c.hand.length < R.handLimit(c));
    const at = !allMarked ? 1 : overs.length || st.pool.length ? 3 : 4;
    add(stage, stageHead(`Chapter ${st.family.chapter}`, EC, null, EC), stepper(EC, at === 1 ? 1 : at === 3 ? [2, 3] : 4), instr(proc.instruction));
    add(stage, stepBlock(1, s1.name, allMarked ? 'done' : '', instr(s1.instruction), inCity ? details('City Marks', instr(D.concept('City Marks'))) : null,
      el('div', { class: 'markrows' }, living.map((c) => {
        const done = ce.marked[c.id];
        const elder = R.isElder(c);
        const cty = cityOf(c);
        return el('div', { class: `markrow ${done ? 'done' : ''}`.trim() }, who(c), el('span', { class: 'tierlabel', text: D.tierForMarks(c.marks) }),
          el('span', { class: 'mk' }, marksRow(c.marks, c.crossed), c.cityMarks ? marksRow(c.cityMarks, c.cityCrossed, 'city') : null), el('span', { class: 'grow' }),
          done ? el('span', { class: 'did' }, { age: 'gained a Mark', city: 'gained a City Mark', cross: 'crossed off a Mark', 'cross-city': 'crossed off a City Mark' }[done],
            el('button', { class: 'x', title: 'Undo', text: '↶', onclick: () => commit('unmarkAge', { id: c.id }) }))
            : el('span', { class: 'btnrow tight' }, el('button', { class: 'tiny primary', text: elder ? 'Cross off a Mark' : cty ? 'Add a City Mark' : 'Add a Mark', onclick: () => commit('markAge', { id: c.id }) }),
              elder && c.cityMarks > c.cityCrossed ? el('button', { class: 'tiny', text: 'Cross off a City Mark', onclick: () => commit('markAge', { id: c.id, crossCity: true }) }) : null));
      }))));
    add(stage, stepBlock(2, s2.name, '', instr(s2.instruction),
      gained.length ? el('div', { class: 'bondgrid' }, gained.map((c) => el('div', { class: 'bondcard' }, el('div', { class: 'bondhead' }, who(c, el('span', { class: 'tierlabel', text: D.tierForMarks(c.marks) }))), bondList(c),
        bondComposer(c, { lists: D.bondsAtOrBelow(D.tierForMarks(c.marks)), banners: R.bondBanners(st, c), exclude: c.name }),
        c.cityMarks >= 1 ? details('Or a City Bond', instr(D.rule('City Bonds')), bondComposer(c, { lists: D.cityBondsAtOrBelow(c.cityMarks), banners: R.bondBanners(st, c), exclude: c.name, label: 'Make the City Bond', city: true })) : null)))
        : el('p', { class: 'small muted', text: allMarked ? 'No one gained a Mark this Chapter.' : 'Mark Age first.' })));
    const hold = el('div', {});
    for (const c of overs) {
      const lim = R.handLimit(c);
      if (!ui.keep[c.id]) ui.keep[c.id] = new Set(c.hand.slice(0, lim));
      const keep = ui.keep[c.id];
      add(hold, el('div', { class: 'holdrow' }, el('div', { class: 'small' }, who(c), ` carries ${lim} of ${c.hand.length} — choose which:`),
        el('div', { class: 'cardrow' }, c.hand.map((id) => cardEl(card(id), { chosen: keep.has(id), dim: !keep.has(id), size: 'sm', onclick: () => { if (keep.has(id)) keep.delete(id); else if (keep.size < lim) keep.add(id); bump(); } }))),
        el('div', { class: 'btnrow' }, el('button', { class: 'tiny primary', text: 'Place the extras face-up', disabled: keep.size !== lim, onclick: () => { const k = [...keep]; delete ui.keep[c.id]; commit('holdTraditions', { id: c.id, keep: k }); } }))));
    }
    if (st.pool.length) {
      const takers = unders.filter((c) => !overs.includes(c));
      add(hold, el('div', { class: 'poolsave' }, st.pool.map((id) => el('div', { class: 'tslot' }, cardEl(card(id), { size: 'sm' }),
        el('div', { class: 'slotacts' }, takers.map((c) => el('button', { class: 'tiny', title: `${c.name} takes it`, onclick: () => commit('saveCard', { id: c.id, cardId: id, verb: 'takes' }) }, tok(c, { size: 'xs' }), ` ${c.name}`)))))),
      el('div', { class: 'btnrow' }, el('button', { class: 'tiny danger', text: `Discard the remaining ${st.pool.length}`, disabled: overs.length > 0, onclick: () => commit('discardPool', {}) })));
    }
    if (!overs.length && !st.pool.length) add(hold, el('p', { class: 'small muted', text: 'Every hand is within its Marks of Age.' }));
    add(stage, stepBlock(3, s3.name, !overs.length && !st.pool.length ? 'done' : '', instr(s3.instruction), hold));
    const ready = allMarked && !overs.length && !st.pool.length;
    const [newCh, reflect] = s4.options;
    add(stage, stepBlock(4, s4.name, '', instr(s4.instruction),
      el('div', { class: 'options two' },
        el('div', { class: 'option' }, el('h3', { text: newCh.name }), instr(newCh.instruction), el('button', { class: 'primary', text: `Begin Chapter ${st.family.chapter + 1}`, disabled: !ready, onclick: () => commit('newChapter', {}) })),
        el('div', { class: 'option' }, el('h3', { text: reflect.name }), instr(reflect.instruction), el('button', { class: '', text: 'End the session', disabled: !ready, onclick: () => commit('endSession', {}) }))),
      !ready ? el('p', { class: 'small muted', text: !allMarked ? 'Everyone marks age first.' : 'Hold Traditions first.' }) : null,
      el('div', { class: 'btnrow' }, el('button', { class: 'ghost tiny', text: '← Not yet — back to the Chapter', disabled: Object.keys(ce.marked).length > 0, title: Object.keys(ce.marked).length ? 'Undo the Marks first' : '', onclick: () => commit('cancelEndChapter', {}) }))));
    return stage;
  }

  function chapterStartStage(st, stage) {
    const cs = st.chapterStart || { rolled: {}, continuing: false };
    const rolls = !cs.continuing && !cs.first;
    const elders = rolls ? R.livingCharacters(st).filter((c) => R.isElder(c)) : [];
    const died = st.characters.filter((c) => cs.rolled[c.id] && cs.rolled[c.id].died);
    const allRolled = elders.every((c) => cs.rolled[c.id]);
    const boroughDue = !cs.continuing && st.borough.isHome;
    const boroughDone = !boroughDue || !!(cs.borough && cs.borough.station);
    add(stage, stageHead(`Session ${st.family.session}`, cs.continuing && !cs.first ? `Chapter ${st.family.chapter} continues` : `Chapter ${st.family.chapter} begins`, null, cs.fromSession ? 'New Session Setup' : 'Starting a New Chapter'));
    if (cs.fromSession) {
      const NS = D.proc('New Session Setup');
      add(stage, el('div', { class: 'steps compact' }, NS.steps.map((s) => stepBlock(s.n, s.name, '', instr(s.instruction)))));
    } else if (!cs.first) add(stage, instr(D.step('Ending a Chapter', 'New Chapter or End the session?').options[0].instruction));
    if (elders.length) {
      const WD = D.proc('When You Die');
      add(stage, stepBlock('☾', 'The Elders roll', allRolled ? 'done' : '', instr(WD.instruction.split(/\n\s*\n/).slice(0, 2).join('\n\n')),
        el('div', { class: 'markrows' }, elders.map((c) => {
          const r = cs.rolled[c.id];
          return el('div', { class: `markrow ${r ? 'done' : ''}`.trim() }, who(c), el('span', { class: 'mk' }, marksRow(c.marks, c.crossed)), el('span', { class: 'small muted', text: `${c.crossed} crossed off` }), el('span', { class: 'grow' }),
            r ? el('span', { class: 'rolled' }, dieFace(r.roll, { size: 34 }), el('span', { text: r.died ? 'dies of old age' : 'lives on' }))
              : el('button', { class: 'tiny primary', text: '🎲 Roll the Die', onclick: () => commit('rollDeath', { id: c.id, roll: rollDie() }) }));
        }))));
      for (const c of died) {
        const madeBond = c.bonds.some((b) => b.memory);
        add(stage, stepBlock('☾', `${c.name} becomes a Memory`, madeBond ? 'done' : '', WD.steps.map((s) => el('div', {}, el('b', { text: s.name }), instr(s.instruction))),
          bondList(c, { removable: false }), madeBond ? null : bondComposer(c, { lists: [D.memoryBonds()], exclude: c.name, label: 'Make the Memory Bond', memory: true })));
      }
    }
    if (boroughDue) add(stage, stepBlock('⌂', 'Living on the Borough', boroughDone ? 'done' : '', instr(D.rule('Living on the Borough')), boroughRoller(st)));
    const bornFor = st.characters.filter((c) => c.isMemory || c.forgotten);
    if (!cs.first) {
      const B = D.proc('Birth');
      add(stage, stepBlock('✦', B.name, '', instr(B.instruction),
        details(bornFor.length ? `A new character for ${bornFor.map((c) => c.name).join(', ')}’s player` : 'A new player joins the family', birthForm(), instr(D.guidanceText('rejoining-as-children')))));
    }
    const ready = allRolled && boroughDone && died.every((c) => c.bonds.some((b) => b.memory));
    add(stage, stepBlock('→', 'Who takes the first turn?', '', instr(D.rule('Starting a New Chapter')),
      ready ? pickChars(R.activeCharacters(st), null, (c) => commit('firstTurn', { id: c.id }))
        : el('p', { class: 'small muted', text: !allRolled ? 'Every Elder rolls first.' : !boroughDone ? 'Roll for the Borough first.' : 'Make the Memory Bond first.' })));
    return stage;
  }

  function sessionClosedStage(st, stage) {
    const reflect = D.step('Ending a Chapter', 'New Chapter or End the session?').options.find((o) => o.name === 'Closing Reflection');
    add(stage, stageHead(`Session ${st.family.session}`, reflect.name, null, 'Ending a Chapter'), instr(reflect.instruction),
      details('Ending a Campaign', instr(D.guidanceText('ending-a-campaign'))), details('Storing the game', instr(D.rule('Storing the Game'))),
      el('div', { class: 'btnrow' }, el('button', { class: 'primary big', text: `Begin Session ${st.family.session + 1}`, onclick: () => commit('newSession', {}) })),
      el('p', { class: 'small muted', text: st.family.chapterClosed ? `The next session begins Chapter ${st.family.chapter + 1}.` : `Chapter ${st.family.chapter} is still open; the next session continues it.` }));
    return stage;
  }

  function birthForm() {
    const st = S();
    const givers = R.livingCharacters(st);
    const childList = D.bondLists.find((b) => b.kind === 'Bonds' && b.tier === 'Child');
    const joiner = D.bondJoiner(childList);
    const name = el('input', { placeholder: 'the name they give you', autocomplete: 'off' });
    const pron = el('input', { placeholder: 'optional' });
    const giver = el('select', {}, givers.map((g) => el('option', { value: g.id, text: g.name })));
    const bond = el('select', {}, [...childList.prompts, D.openPromptWord(childList)].map((p) => el('option', { value: p, text: `${p} ${joiner}…` })));
    const B = D.proc('Birth');
    return el('div', { class: 'birth' },
      el('ol', { class: 'plain' }, B.steps.map((s) => el('li', {}, s.instruction.startsWith(s.name) ? null : el('b', { text: `${s.name}. ` }), s.instruction))),
      el('div', { class: 'addrow' }, el('label', {}, 'Chosen player', giver), el('label', {}, 'Name', name), el('label', {}, 'Pronouns', pron), el('label', {}, 'Child Bond', bond),
        el('button', { class: 'primary', text: 'Born into the family', disabled: !givers.length, onclick: () => {
          if (!name.value.trim()) { name.focus(); return; }
          commit('birth', { id: State.genId('ch'), name: name.value.trim(), pronouns: pron.value.trim(), giverId: giver.value, bondPrompt: bond.value, joiner, templateId: (D.named('Main Character') || {}).id });
        } })));
  }

  function boroughRoller(st) {
    const r = st.chapterStart && st.chapterStart.borough;
    if (r && r.station) return el('p', { class: 'small', text: `The Borough settles at ${r.station}.` });
    if (r && r.roll) {
      return el('div', {}, el('div', { class: 'rolled' }, dieFace(r.roll, { size: 40 }), el('b', { text: r.line })),
        el('div', { class: 'destgrid' }, r.stations.map((loc) => el('button', { type: 'button', class: 'dest', onclick: () => commit('boroughSettle', { station: loc }) }, el('span', { class: 'nm', text: loc })))));
    }
    return el('button', { class: 'primary tiny', text: '🎲 Roll the Die', onclick: () => commit('boroughRoll', { roll: rollDie() }) });
  }

  function boroughPanel() {
    const st = S();
    const cur = R.currentCharacter(st);
    const at = (whereIs(st, cur) || {}).name;
    return modal('The Wandering Borough', (close) => {
      const body = el('div', {}, instr(D.rule('The Wandering Borough')));
      if (st.borough.isHome) {
        add(body, instr(D.rule('Living on the Borough')));
        const out = el('div', {});
        add(body, out, el('div', { class: 'btnrow' }, el('button', { class: 'primary', text: '🎲 Roll the Die', onclick: () => {
          const res = R.boroughLine(rollDie());
          add(clear(out), el('div', { class: 'rolled' }, dieFace(res.roll, { size: 44 }), el('b', { text: res.line })),
            el('div', { class: 'destgrid' }, res.stations.map((loc) => el('button', { type: 'button', class: 'dest', onclick: () => { commit('boroughArrives', { station: loc, text: `The Die shows ${res.roll} — the Borough wanders along ${res.line} to ${loc}.` }); close(); } }, el('span', { class: 'nm', text: loc })))));
        } })));
      } else if (st.borough.inPlay) {
        add(body, instr(D.rule('The Borough Leaves')), el('div', { class: 'btnrow' }, el('button', { class: 'primary', text: 'The Borough departs', onclick: () => { commit('boroughLeaves', {}); close(); } })));
      } else {
        const station = at === BOROUGH ? null : at;
        add(body, instr(D.rule('The Borough Wanders').split(/\n\s*\n/).slice(1).join('\n\n')),
          el('div', { class: 'btnrow' }, el('button', { class: 'primary', text: `The Borough arrives near ${station}`, disabled: !station, onclick: () => { commit('boroughArrives', { station }); close(); } })),
          details('Transit and the Borough', instr(D.rule('Transit and The Borough'))));
      }
      add(body, el('div', { class: 'btnrow' }, el('button', { class: 'ghost', text: 'Close', onclick: () => close() })));
      return body;
    });
  }

  function askFateDialog() {
    const AF = D.proc('Ask Fate');
    const [s1, s2, s3] = AF.steps;
    return modal('Ask Fate', (close) => {
      const q = el('input', { placeholder: 'the question for Fate', class: 'wide' });
      const fields = D.askFate.map((o) => ({ o, input: el('textarea', { rows: 2, placeholder: o.definition }) }));
      const out = el('div', { class: 'fateout' });
      return el('div', { class: 'fate' }, el('div', { class: 'citerow' }, window.CowReader.cite(AF.name)), instr(AF.instruction),
        stepBlock(1, s1.name, '', instr(s1.instruction), q),
        stepBlock(2, s2.name, '', instr(s2.instruction.split(/\n\s*\n/)[0]), el('div', { class: 'outcomes' }, fields.map(({ o, input }) => el('label', { class: 'outcome', dataset: { band: o.roll } }, el('span', { class: 'band', text: o.roll }), el('span', { class: 'oname', text: o.outcome }), input)))),
        stepBlock(3, s3.name, '', out, el('div', { class: 'btnrow' },
          el('button', { class: 'primary big', text: '🎲 Roll the Die', onclick: () => {
            const r = R.fateOutcome(rollDie());
            const chosen = fields.find((f) => f.o.roll === r.band);
            for (const f of fields) f.input.closest('.outcome').classList.toggle('hit', f === chosen);
            add(clear(out), el('div', { class: 'rolled big' }, dieFace(r.roll, { size: 64 }), el('div', {}, el('b', { text: r.outcome.outcome }), el('p', { text: chosen.input.value.trim() || r.outcome.definition }))));
            commit('askFate', { roll: r.roll, question: q.value.trim(), answer: chosen.input.value.trim() });
          } }),
          el('button', { class: 'ghost', text: 'Close', onclick: () => close() }))),
        details('Advice on asking Fate', instr(D.guidanceText('fate-advice'))));
    });
  }

  function birthDialog() {
    return modal('Birth', (close) => el('div', {}, instr(D.proc('Birth').instruction), birthForm(), el('div', { class: 'btnrow' }, el('button', { class: 'ghost', text: 'Close', onclick: () => close() }))));
  }

  /* =========================================================== THE LOCATION == */

  function renderLocation(st) {
    const cur = R.currentCharacter(st);
    const ph = st.turn.phase;
    const plateCh = ph === 'memory-share' ? chById(st.turn.memoryTarget) : cur && cur.isMemory && ui.memTarget ? chById(ui.memTarget) : cur;
    const loc = whereIs(st, plateCh && !plateCh.isMemory ? plateCh : null);
    if (!loc) return el('div', { class: 'empty', text: st.setupComplete ? 'No location.' : 'The family has no home yet.' });
    const isBorough = loc.name === BOROUGH;
    const region = isBorough ? 'borough' : loc.region === 'City' ? 'city' : 'river';
    const here = (c) => (c.visiting || R.homeOf(st, c)) === loc.name;
    const onScene = new Map();
    const atLoc = [];
    for (const c of R.activeCharacters(st)) {
      if (c.isMemory || !here(c)) continue;
      if (c.scene && loc.scenes.includes(c.scene)) onScene.set(c.scene, [...(onScene.get(c.scene) || []), c]);
      else atLoc.push(c);
    }
    let pick = null;
    if (st.setupComplete && ph === 'choose-scene' && cur && !cur.isMemory && !ui.migrateScene) pick = (s) => commit('chooseScene', { id: cur.id, scene: s });
    else if (st.setupComplete && ph === 'choose-scene' && cur && cur.isMemory && ui.memTarget) { const t = chById(ui.memTarget); pick = (s) => { ui.memTarget = null; commit('memoryMove', { memId: cur.id, targetId: t.id, scene: s }); }; }
    const lines = D.transitLines.filter((l) => l.stations.includes(isBorough ? st.borough.station : loc.name));
    const icons = R.localDecks(loc.name);
    return el('section', { class: `plate ${region} ${pick ? 'picking' : ''}`.trim(), 'aria-label': `The location: ${locName(loc.name)}` },
      el('header', { class: 'platehead' },
        el('div', {}, el('div', { class: 'eyebrow', text: [isBorough ? 'The Wandering Borough' : loc.region === 'City' ? 'The City of Winter' : 'The Riverlands', loc.route ? `by ${loc.route}` : null, cur && cur.visiting === loc.name ? `${cur.name} is visiting` : homeLabel(st, loc.name)].filter(Boolean).join(' · ') }), el('h2', { text: locName(loc.name) })),
        el('div', { class: 'localtrads' }, icons.map((i) => el('span', { class: `ltrad ${i.blank ? 'blank' : ''}`.trim(), title: i.blank ? `Blank ${i.shape} icon: any of ${i.decks.join(', ')}` : i.decks[0] }, shapeIcon(i.shape), i.blank ? `any ${i.shape}` : i.decks[0])))),
      lines.length || isBorough ? el('div', { class: 'lines' }, isBorough ? el('span', { class: 'small', text: st.borough.station ? `At ${st.borough.station}’s Station` : 'Not yet at a Station' }) : null, lines.map((l) => el('span', { class: 'line', text: l.name }))) : null,
      pick ? el('div', { class: 'pickhint', text: cur.isMemory ? `Choose a Scene for ${(chById(ui.memTarget) || {}).name}’s token` : 'Choose a Scene' }) : null,
      el('div', { class: 'scenegrid' }, loc.scenes.map((s) => {
        const toks = onScene.get(s) || [];
        const mine = cur && toks.some((c) => c.id === cur.id);
        return el(pick ? 'button' : 'div', { type: pick ? 'button' : null, class: `scenetile ${toks.length ? 'taken' : ''} ${mine ? 'mine' : ''}`.trim(), onclick: pick ? () => pick(s) : null },
          el('span', { class: 'sname', text: s }), toks.length ? el('span', { class: 'toks' }, toks.map((c) => tok(c, { size: 'sm' }))) : null);
      })),
      atLoc.length ? el('div', { class: 'athome' }, el('span', { class: 'k', text: 'Tokens on the location' }), atLoc.map((c) => tok(c, { size: 'sm' }))) : null);
  }

  /* ============================================================= THE FAMILY == */

  const TURN_PHASES = ['choose-scene', 'share-or-witness', 'lead', 'end-scene', 'memory-share', 'apart-offer'];

  function renderFamily(st) {
    const cur = R.currentCharacter(st);
    const sec = el('section', { class: 'family' });
    if (!st.characters.length) add(sec, el('div', { class: 'empty', text: 'No one is in the family yet.' }));
    add(sec, el('div', { class: 'notecards' }, st.characters.map((c) => notecard(st, c, cur))));
    if (st.setupComplete) add(sec, el('p', { class: 'small muted', text: D.guidanceText('keep-cards-face-down') }), sideCharacters(st));
    return sec;
  }

  function notecard(st, c, cur) {
    const isTurn = st.setupComplete && cur && cur.id === c.id && TURN_PHASES.includes(st.turn.phase);
    const lim = R.handLimit(c);
    const looking = ui.look.has(c.id);
    const mine = me() === c.id;
    const apart = c.home && c.home !== st.family.home && !c.isMemory;
    const state = c.forgotten ? 'forgotten' : c.isMemory ? 'a Memory' : c.leaving ? 'leaving' : c.hadMigrationScene ? 'migrating' : c.visiting ? `visiting ${locName(c.visiting)}` : apart ? `lives at ${locName(c.home)}` : null;
    return el('article', { class: `notecard ${isTurn ? 'turn' : ''} ${c.isMemory ? 'memory' : ''} ${c.forgotten ? 'forgotten' : ''} ${mine ? 'mine' : ''}`.trim(), style: `--tok:${(TOKENS.find((t) => t.id === c.token) || {}).color || 'var(--edge)'}` },
      el('header', {}, tok(c, { size: 'lg' }),
        el('div', { class: 'nmblock' }, el('h3', {}, c.name, c.pronouns ? el('span', { class: 'pronouns', text: c.pronouns }) : null),
          el('div', { class: 'sub' }, el('span', { class: 'tierlabel', text: D.tierForMarks(c.marks) }), state ? el('span', { class: 'state', text: state }) : null, isTurn ? el('span', { class: 'turnflag', text: 'their turn' }) : null, mine ? el('span', { class: 'mineflag', text: 'you' }) : null)),
        el('button', { class: 'menu', title: 'More', 'aria-label': `More for ${c.name}`, text: '⋯', onclick: () => characterMenu(c) })),
      el('div', { class: 'marksline' }, marksRow(c.marks, c.crossed), c.cityMarks ? marksRow(c.cityMarks, c.cityCrossed, 'city') : null),
      c.scene && !c.isMemory ? el('div', { class: 'onscene' }, el('span', { class: 'k', text: 'On' }), ` ${c.scene}`) : null,
      c.bonds.length ? el('ul', { class: 'bonds' }, c.bonds.map((b) => el('li', { class: b.city ? 'city' : b.memory ? 'memory' : '', text: bondText(b) }))) : null,
      el('div', { class: 'handhead' }, el('span', { class: `handcount ${c.hand.length > lim ? 'over' : ''}`.trim(), text: `Holds ${c.hand.length} of ${lim}` }),
        c.hand.length ? el('button', { class: 'tiny ghost', text: looking ? 'Turn face down' : 'Look', 'aria-pressed': String(looking), onclick: () => { if (looking) ui.look.delete(c.id); else ui.look.add(c.id); bump(); } }) : null),
      c.hand.length ? el('div', { class: `hand ${looking ? 'up' : 'down'}` }, c.hand.map((id) => cardEl(card(id), { facedown: !looking, size: 'sm' }))) : null);
  }

  function characterMenu(c) {
    const st = S();
    return modal(c.name, (close) => {
      const body = el('div', { class: 'charmenu' });
      const living = !c.isMemory && !c.forgotten;
      add(body, el('h3', { text: 'Bonds' }), bondList(c));
      if (!c.forgotten) {
        add(body, bondComposer(c, { lists: c.isMemory ? [D.memoryBonds()] : D.bondsAtOrBelow(D.tierForMarks(c.marks)), banners: R.bondBanners(st, c), exclude: c.name, memory: c.isMemory, onDone: () => { close(); characterMenu(chById(c.id)); } }));
        if (c.cityMarks >= 1) add(body, details('City Bonds', instr(D.rule('City Bonds')), bondComposer(c, { lists: D.cityBondsAtOrBelow(c.cityMarks), banners: R.bondBanners(st, c), exclude: c.name, label: 'Make the City Bond', city: true, onDone: () => { close(); characterMenu(chById(c.id)); } })));
      }
      if (living) add(body, el('h3', { text: 'Token' }), swatches(st, c, close));
      const acts = el('div', { class: 'menuacts' });
      if (!c.forgotten && !c.leaving && ['choose-scene', 'share-or-witness'].includes(st.turn.phase) && (R.currentCharacter(st) || {}).id !== c.id && !c.hadMigrationScene) {
        add(acts, el('div', { class: 'act' }, el('button', { text: 'Take the turn', onclick: () => { commit('giveTurn', { id: c.id }); close(); } }), el('span', { class: 'small muted', text: 'Out of order — for when the table agrees.' })));
      }
      if (living) {
        add(acts, el('div', { class: 'act' }, el('button', { class: 'ghost', text: 'Pass into memory', onclick: async () => {
          close();
          const ok = await choose(`${c.name} dies`, [{ label: `${c.name} becomes a Memory`, value: true, class: 'primary' }], { body: el('div', {}, instr(D.guidanceText('other-ways-to-die')), instr(D.proc('When You Die').steps.map((s) => s.instruction).join('\n\n'))) });
          if (!ok) return;
          commit('becomeMemory', { id: c.id });
          modal(`${c.name} becomes a Memory`, (cl) => el('div', {}, instr(D.step('When You Die', 'Make a Memory Bond').instruction), bondComposer(chById(c.id), { lists: [D.memoryBonds()], exclude: c.name, label: 'Make the Memory Bond', memory: true, onDone: () => cl() })));
        } }), el('span', { class: 'small muted', text: sentence(D.guidanceText('other-ways-to-die'), 'you always decide') })));
        add(acts, el('div', { class: 'act' }, el('button', { class: 'ghost', text: c.leaving ? 'Staying after all' : 'Leaving the game', onclick: () => { commit('setLeaving', { id: c.id, on: !c.leaving }); close(); } }), el('span', { class: 'small muted', text: D.guidanceText('leaving-mid-game') })));
      }
      if (acts.childNodes.length) add(body, el('h3', { text: 'At the table' }), acts);
      add(body, el('div', { class: 'btnrow' }, el('button', { class: 'ghost', text: 'Close', onclick: () => close() })));
      return body;
    });
  }

  function sideCharacters(st) {
    const input = el('input', { placeholder: 'a new side-character', list: 'allnames', autocomplete: 'off' });
    const submit = () => { const n = input.value.trim(); if (!n) return; commit('addSide', { id: State.genId('side'), name: n }); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    return el('div', { class: 'sides' }, el('h3', { text: 'Side-Characters' }),
      details('About side-characters', instr(D.guidanceText('side-characters')), instr(D.guidanceText('side-characters-and-age'))),
      el('div', { class: 'sidechips' }, st.sideCharacters.map((s) => el('span', { class: 'sidechip' }, s.name, el('button', { class: 'x', title: `Remove ${s.name}`, text: '×', onclick: () => commit('removeSide', { id: s.id }) }))),
        el('span', { class: 'addside' }, input, el('button', { class: 'tiny', text: 'Add', onclick: submit }))));
  }

  /* ================================================================ THE RAIL == */

  function renderTurn(st) {
    const cur = TURN_PHASES.includes(st.turn.phase) ? R.currentCharacter(st) : null;
    const order = st.turn.order.map(chById).filter((c) => c && !c.forgotten);
    const box = el('div', {});
    add(box, el('h3', { text: 'Turn order' }),
      order.length ? el('ol', { class: 'turnorder' }, order.map((c) => el('li', { class: `${cur && cur.id === c.id ? 'now' : ''} ${c.hadMigrationScene ? 'skip' : ''} ${c.isMemory ? 'mem' : ''}`.trim() }, tok(c, { size: 'sm' }), el('span', { class: 'nm', text: c.name }), el('span', { class: 'note', text: c.hadMigrationScene ? 'migrating' : c.isMemory ? 'Memory' : c.leaving ? 'leaving' : '' })))) : el('p', { class: 'small muted', text: 'No one yet.' }));
    add(box, el('h3', { text: 'Tradition Decks in play' }),
      el('div', { class: 'decks' }, st.inPlay.map((d) => { const k = D.byDeck.get(d); const n = (st.decks[d] || []).length; return el('div', { class: `deckchip ${D.palette(d)}`, title: `${n} cards in the deck` }, el('span', { class: 'stack' }, shapeIcon(k && k.shape)), el('span', { class: 'nm', text: d }), el('span', { class: 'n', text: n })); })),
      details('Shuffling', instr(D.substep(SETUP, 'Hold Traditions', 'Gather the Tradition Deck').instruction.split(/\n\s*\n/).pop())));
    if (st.pool.length && !['migrate-family', 'end-chapter'].includes(st.turn.phase)) {
      add(box, el('h3', { text: `Face-up on the table · ${st.pool.length}` }), el('div', { class: 'cardrow tight' }, st.pool.map((id) => cardEl(card(id), { size: 'sm' }))));
    }
    return box;
  }

  function renderRecord(st) {
    const items = [];
    let lastCh = null;
    for (const l of (State.state.log || []).slice(-120).reverse()) {
      if (l.ch && l.ch !== lastCh) { items.push(el('li', { class: 'chsep', text: `Chapter ${l.ch}` })); lastCh = l.ch; }
      items.push(el('li', { class: l.kind === 'undo' ? 'undo' : '' }, el('span', { class: 'when', text: fmtTime(l.at) }), l.text));
    }
    return el('ul', { class: 'log' }, items.length ? items : el('li', { class: 'muted', text: 'Nothing yet.' }));
  }

  /* ============================================================ RULES & BOOKS == */

  // the reader (reader.js): the book in its own order; the stage cites into it
  function renderRules(container, ctx) {
    clear(container);
    const host = el('div', { class: 'rules-panel' });
    add(container, host);
    const r = window.CowReader.mount(host, { mode: 'panel' });
    ctx.on('cow:reader', (t) => { const s = D.outline().find((x) => x.slug === t.section || x.title === t.section); if (s) r.go(s, t.term); });
  }

  /* =================================================================== ATLAS == */

  function renderAtlas() {
    const locCard = (loc) => el('div', { class: `loc ${loc.borough ? 'borough' : ''}`.trim(), dataset: { region: loc.region } },
      el('h3', { text: locName(loc.name) }),
      el('div', { class: 'icons' }, R.localDecks(loc.name).map((i) => el('span', { title: i.blank ? `blank ${i.shape}: any of ${i.decks.join(', ')}` : i.decks[0] }, shapeIcon(i.shape), el('span', { class: 'small', text: i.blank ? `any ${i.shape} ` : i.decks[0] + ' ' })))),
      loc.route ? el('p', { class: 'meta' }, el('b', { text: 'Route ' }), `by ${loc.route}`) : null,
      loc.connects.length ? el('p', { class: 'meta' }, el('b', { text: 'Connects to ' }), loc.connects.join(' · ')) : null,
      loc.entrances.length ? el('div', { class: 'meta' }, loc.entrances.map((e) => el('div', { class: 'entr', text: `${e.text} → ${e.target}` }))) : null,
      loc.scenes.length ? el('div', { class: 'scenelist' }, loc.scenes.map((s) => el('span', { text: s }))) : null);
    const DIST = D.transitDistance;
    const cell = (v, extra) => el('td', { class: `${v === '7+' ? 'far' : v === '1' ? 'near' : ''} ${extra || ''}`.trim(), text: v === '-' ? '' : v });
    const tbl = el('table', { class: 'dist' },
      el('thead', {}, el('tr', {}, el('th', {}), DIST.order.map((c) => el('th', { text: c })))),
      el('tbody', {}, DIST.order.map((r) => el('tr', {}, el('td', { text: r }), DIST.rows[r].map((v) => cell(v)))),
        Object.keys((DIST.derived || { rows: {} }).rows).map((r) => el('tr', { class: 'derivedrow' }, el('td', {}, r, el('span', { class: 'tag', style: 'margin-left:0.4rem', text: 'derived' })), DIST.derived.rows[r].map((v) => cell(v, 'derived'))))));
    return el('div', { class: 'atlas' },
      el('h2', { text: 'The Riverlands' }), instr(D.guidanceText('by-ship-or-by-caravan')), el('div', { class: 'grid' }, D.riverlands.map(locCard)),
      el('h2', { text: 'The City of Winter' }), instr(D.rule('Witnessing in the City')), instr(D.rule('Blank Tradition Icons')), el('div', { class: 'grid' }, D.city.map(locCard)),
      el('h2', { text: 'The Wandering Borough' }), instr(D.rule('The Wandering Borough')), el('div', { class: 'grid' }, locCard(D.wanderingBorough)),
      el('h2', { text: 'Transit Lines & Stations' }), instr(D.rule('Transit Lines & Stations')), instr(D.rule('Travel').split(/\n\s*\n/)[1]),
      el('div', { class: 'lines-list' }, D.transitLines.map((t) => el('div', { class: 'tline' }, el('b', { text: t.name }), t.die ? el('span', { class: 'tag spire', text: `Borough die ${t.die}` }) : el('span', { class: 'tag', text: 'not on the Borough table' }), el('div', { class: 'small muted', text: t.stations.join('  ·  ') })))),
      el('h2', { text: 'Transit Distance' }), el('p', { class: 'small muted', text: D.named('Transit Distance').desc }), el('div', { class: 'scroller' }, tbl),
      DIST.derived ? el('p', { class: 'small muted' }, el('b', { text: 'The last row is not printed. ' }), DIST.derived.note) : null);
  }

  /* ============================================================== TRADITIONS == */

  let tradFilter = null;
  let tradQ = '';
  function renderTraditions(container) {
    const box = el('div', { class: 'traditions' });
    const draw = () => {
      clear(box);
      add(box, el('div', { class: 'panel' }, el('h3', { style: 'margin-top:0', text: 'Blank Tradition Icons' }), instr(D.rule('Blank Tradition Icons')),
        Object.keys(D.shapeFamilies).map((shape) => el('p', { class: 'small muted' }, 'A blank ', shapeIcon(shape), shape, ' icon may be drawn from: ', D.shapeFamilies[shape].join(', '), '.'))));
      const search = el('input', { type: 'search', placeholder: 'search prompts…', value: tradQ, style: 'margin-left:auto;min-width:180px' });
      search.addEventListener('input', () => { tradQ = search.value; drawCards(); });
      add(box, el('div', { class: 'deckbar' }, el('button', { class: tradFilter === null ? 'on' : '', text: `All (${D.cards.length})`, onclick: () => { tradFilter = null; draw(); } }),
        D.decks.map((k) => el('button', { class: tradFilter === k.name ? 'on' : '', onclick: () => { tradFilter = k.name; draw(); } }, shapeIcon(k.shape), `${k.name} (${k.cards.length})`)), search));
      const host = el('div', { class: 'cards-host' });
      add(box, host);
      const drawCards = () => {
        clear(host);
        const q = tradQ.trim().toLowerCase();
        for (const k of (tradFilter ? [D.byDeck.get(tradFilter)] : D.decks)) {
          const cards = D.cardsByDeck.get(k.name).filter((c) => !q || c.prompt.toLowerCase().includes(q));
          if (!cards.length) continue;
          add(host, el('h3', {}, shapeIcon(k.shape), `${k.name} `, el('span', { class: 'tag ' + (k.shape === 'umbra' ? 'umbra' : k.region === 'City' ? 'city' : 'river'), text: k.region }), el('span', { class: 'tag', text: `${cards.length} of ${k.cards.length}` })),
            el('div', { class: 'cardrow' }, cards.map((c) => cardEl(c))));
        }
        if (!host.children.length) add(host, el('p', { class: 'muted', text: 'No prompt matches that search.' }));
      };
      drawCards();
      add(box, el('h2', { text: 'Banners' }), instr(D.concept('Tradition Banner')), instr(D.guidanceText('tradition-banners-in-play')),
        el('div', { class: 'grid' }, D.decks.filter((k) => k.names && k.names.length).map((k) => el('div', { class: 'banner' }, el('h4', {}, shapeIcon(k.shape), k.banner), el('p', { class: 'names', text: k.names.join(', ') + '…' }), el('p', { class: 'small muted', text: k.namePrompt || '' })))));
    };
    draw();
    return box;
  }

  /* ================================================================ CAMPAIGN == */

  function renderCampaign(container) {
    const st = S();
    const c = State.state.campaign;
    const name = el('input', { type: 'text', value: c.name || '', placeholder: 'the family’s name' });
    name.addEventListener('change', () => State.commit('setCampaign', [{ name: name.value.trim() }]));
    const file = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
    file.addEventListener('change', () => { const f = file.files && file.files[0]; if (!f) return; f.text().then((t) => { State.importPack(JSON.parse(t)); location.reload(); }).catch((e) => alert(e.message)).finally(() => (file.value = '')); });
    const autos = el('div', { class: 'autosaves' });
    if (State.listAutosaves) State.listAutosaves().then((rows) => { clear(autos); rows.forEach((r) => add(autos, el('div', { class: 'chiprow' }, el('span', { class: 'small muted', text: new Date(r.at).toLocaleString() }), el('button', { class: 'tiny ghost', text: 'restore', onclick: () => { if (confirm('Restore this autosave? The table as it is now is replaced.')) State.restoreAutosave(r.key).then(() => location.reload()); } })))); }).catch(() => {});
    return el('div', { class: 'campaign' },
      el('h3', { text: 'This family' }), el('div', { class: 'addrow' }, el('label', {}, 'Name', name)),
      el('p', { class: 'small muted', text: st.setupComplete ? `Chapter ${st.family.chapter} · Session ${st.family.session} · Home ${locName(st.family.home) || '—'}` : 'First Session Setup is under way.' }),
      el('h3', { text: 'Variants' }), variantToggles(st, st.setupComplete ? ['The Umbra Follows', 'Solo Play'] : ['The Umbra Follows', 'Fleeing the City', 'Solo Play']),
      st.setupComplete && st.variants['Fleeing the City'] ? el('p', { class: 'small muted', text: 'Fleeing the City was chosen at setup.' }) : null,
      el('h3', { text: 'The pack' }), el('p', { class: 'small muted', text: 'The family, the decks and the record, as a file: the durable record between evenings. A room outlives a session; the pack outlives the room.' }),
      el('div', { class: 'btnrow' }, el('button', { text: 'Save pack', onclick: () => State.downloadPack() }), el('button', { class: 'ghost', text: 'Restore pack…', onclick: () => file.click() }), file),
      el('h4', { text: 'Autosaves' }), autos,
      el('h3', { text: 'The box' }),
      el('div', { class: 'btnrow' }, el('button', { class: 'danger', text: 'Put everything back in the box…', onclick: async () => {
        const ok = await choose('Reset the table?', [{ label: 'Yes, put everything back in the box', value: true, class: 'danger' }], { body: el('p', { class: 'small muted', text: 'This clears the family, the decks and the record for this campaign.' }) });
        if (ok) { Object.assign(ui, { look: new Set(), holdFor: null, witness: null, memTarget: null, carry: null, keep: {}, passPick: null, travel: false, migrateScene: false, apart: null }); commit('resetTable', {}); }
      } })));
  }

  /* ============================================================ REGISTRATION == */

  // A panel's draw: redrawn on every change, unless a field inside it has focus (typing keeps its box).
  const editing = (c) => document.activeElement && /TEXTAREA|INPUT|SELECT/.test(document.activeElement.tagName) && c.contains(document.activeElement) && document.activeElement.type !== 'checkbox';
  function panel(label, build, opts) {
    return { label, render(container, ctx) {
      const draw = () => {
        if (editing(container)) return;
        const y = container.scrollTop;
        clear(container);
        const st = S();
        namesList(st);
        add(container, build(st, container, ctx));
        container.scrollTop = y;
      };
      redrawOn(ctx, draw);
      draw();
    } };
  }

  /** The stage, with the chronicle above it — or First Session Setup until it is done. */
  const stagePanel = (st) => (st.setupComplete ? el('div', {}, chronicleBar(st), renderStage(st)) : renderSetup(st));

  Panels.register('stage', panel('The stage', stagePanel));
  Panels.register('location', panel('The location', renderLocation));
  Panels.register('family', panel('The family', renderFamily));
  Panels.register('turn', panel('Turn & decks', renderTurn));
  Panels.register('record', panel('The record', renderRecord));
  Panels.register('rules', { label: 'Rules & Books', render: renderRules });
  Panels.register('atlas', { label: 'Atlas', render(container) { clear(container); add(container, renderAtlas()); } });
  Panels.register('traditions', { label: 'Traditions', render(container) { clear(container); add(container, renderTraditions(container)); } });
  Panels.register('campaign', panel('The family’s table', renderCampaign));

  /** The whole table in one element — the player's page (system.js liveSheet). */
  function wholeTable(st, opts) {
    opts = opts || {};
    return el('div', { class: 'playtable' },
      el('div', { class: 'playmain' }, st.setupComplete ? [chronicleBar(st), renderStage(st), renderLocation(st)] : renderSetup(st), renderFamily(st)),
      el('aside', { class: 'playrail' }, el('section', { class: 'panel' }, renderTurn(st)),
        opts.player ? null : el('section', { class: 'panel' }, el('h3', { text: 'The record' }), renderRecord(st))));   // the player's page shows the record as its feed
  }

  return { ui, bump, commit, S, renderSetup, renderStage, renderLocation, renderFamily, renderTurn, renderRecord, chronicleBar, wholeTable, notecard, namesList };
})();
