// system/cityofwinter/data.js — accessors over the generated corpus (window.COW from data/*.js)
// and the game's facts (facts.js). This is the only file that knows the data files' shape; the
// panels, the sheet and the site ask here. Every string it returns is the book's own.
window.CowData = (function () {
  const T = window.COW || { books: {}, entities: {}, index: { books: [] } };
  const F = window.CowFacts;
  const E = T.entities;

  /* ---------------------------------------------------- the entity graph ---- */

  function books() {
    return (T.index && T.index.books ? T.index.books : Object.keys(T.books).map((id) => ({ id }))).map((b) => T.books[b.id]).filter(Boolean);
  }
  const book = (id) => T.books[id] || null;
  const entity = (id) => E[id] || null;
  const byName = {};
  Object.keys(E).forEach((id) => { if (!byName[E[id].name]) byName[E[id].name] = E[id]; });
  const named = (name) => byName[name] || null;
  const children = (id) => (entity(id) ? entity(id).children.map(entity).filter(Boolean) : []);

  function all(bookIds) {
    const ids = bookIds && bookIds.length ? bookIds : Object.keys(T.books);
    const out = [];
    const seen = new Set();
    ids.forEach((bid) => {
      const b = T.books[bid];
      if (!b) return;
      const stack = b.entities.slice();
      while (stack.length) {
        const id = stack.shift();
        if (seen.has(id)) continue;
        seen.add(id);
        const e = E[id];
        if (!e) continue;
        out.push(e);
        stack.push.apply(stack, e.children);
      }
    });
    return out;
  }
  const byType = (type, bookIds) => all(bookIds).filter((e) => e.type === type);
  const roots = (bookId) => (book(bookId) ? book(bookId).entities.map(entity).filter((e) => e && !e.parent) : []);

  function propValue(e, name) {
    const p = (e.props || []).find((x) => x.name === name);
    if (!p) return undefined;
    if (p.vk === 'scalar' || p.vk === 'enum') return p.value;
    if (p.vk === 'ref') return 'value' in p ? p.value : p.ref;
    if (p.vk === 'list') return p.items;
    return p;
  }
  const block = (e, kw) => (e.blocks || []).find((b) => b.kw === kw) || null;
  const blocksOf = (e, kw) => (e.blocks || []).filter((b) => b.kw === kw);
  const firstStr = (b) => (b && (b.args || []).find((a) => typeof a === 'string')) || null;

  function searchText(e) {
    const parts = [e.name, e.desc || ''];
    (e.props || []).forEach((p) => {
      if ((p.vk === 'scalar' || p.vk === 'enum') && typeof p.value === 'string') parts.push(p.value);
      if (p.vk === 'list') p.items.forEach((it) => it.vk === 'scalar' && parts.push(String(it.value)));
    });
    (e.blocks || []).forEach(function walk(b) {
      (b.args || []).forEach((a) => typeof a === 'string' && parts.push(a));
      (b.body || []).forEach((x) => { if (x.kw) walk(x); else if (x.str) parts.push(x.str); });
    });
    (e.outcomes || []).forEach((o) => parts.push(Array.isArray(o) ? o[1] : (o.fields || []).map((f) => f.value).join(' ')));
    return parts.join('\n').toLowerCase();
  }
  const searchCache = new Map();
  function search(query, bookIds, limit) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits = [];
    all(bookIds).forEach((e) => {
      let text = searchCache.get(e.id);
      if (!text) { text = searchText(e); searchCache.set(e.id, text); }
      const inName = e.name.toLowerCase().indexOf(q) !== -1;
      const hasText = !!(e.desc || (e.props || []).some((p) => p.vk === 'scalar' && p.value !== undefined) || e.children.length);
      if (inName || text.indexOf(q) !== -1) hits.push({ e, score: (inName ? 0 : 2) + (hasText ? 0 : 1) });
    });
    hits.sort((a, b) => a.score - b.score || a.e.name.localeCompare(b.e.name));
    return hits.slice(0, limit || 200).map((h) => h.e);
  }

  /* ------------------------------------------------------- the game's facts -- */

  const decks = F.deckOrder.map((n) => F.decks[n]);
  const byDeck = new Map(decks.map((k) => [k.name, k]));
  const cards = decks.flatMap((k) => k.cards.map((id) => F.cards[id]));
  const byCard = new Map(cards.map((c) => [c.id, c]));
  const cardsByDeck = new Map(decks.map((k) => [k.name, k.cards.map((id) => F.cards[id])]));
  const locations = F.locationOrder.map((n) => F.locations[n]);
  const byLocation = new Map(locations.map((l) => [l.name, l]));
  const riverlands = locations.filter((l) => l.region === 'Riverlands');
  const city = locations.filter((l) => l.region === 'City' && !l.borough);
  const wanderingBorough = F.locations[F.wanderingBorough];
  const startingHomes = riverlands.filter((l) => l.startingHome);
  const sceneLocation = new Map();
  locations.forEach((l) => l.scenes.forEach((s) => sceneLocation.set(s, l.name)));
  const byLine = new Map(F.transitLines.map((t) => [t.name, t]));

  const TIERS = ['Child', 'Youth', 'Parent', 'Elder'];
  const bondsAtOrBelow = (tierName) => F.bondLists.filter((b) => b.kind === 'Bonds' && TIERS.indexOf(b.tier) <= TIERS.indexOf(tierName));
  const cityBondsAtOrBelow = (cityMarks) => F.bondLists.filter((b) => b.kind === 'City Bonds' && Number((b.tier.match(/\d+/) || [0])[0]) <= cityMarks);
  const memoryBonds = () => F.bondLists.find((b) => b.kind === 'Memory Bonds');
  /** The word that joins a Bond prompt to a name — each list's own open prompt states it ("or Child of…", "or Shadowed by…", "or Lost to…"). */
  const bondJoiner = (list) => { const m = (list.openPrompt || '').match(/\b(of|by|to|with)\s*\.*\s*$/i); return m ? m[1].toLowerCase() : 'of'; };
  const openPromptWord = (list) => (list.openPrompt || '').replace(/^or\s+/i, '').replace(/\s*\b(of|by|to|with)\s*\.*\s*$/i, '').trim();
  const tierForMarks = (marks) => (F.ageTiers.find((t) => t.marks.includes(marks)) || {}).name || (marks > 6 ? 'Elder' : 'Child');
  /** The palette a deck's cards are printed in. */
  const palette = (deckName) => { const k = byDeck.get(deckName); if (!k) return 'river'; if (k.shape === 'umbra') return 'umbra'; return k.region === 'City' ? 'city' : 'river'; };

  /* -------------------------------------------------- the rules, by name ----- */

  const must = (v, what) => { if (v == null) throw new Error(`the corpus has no ${what}`); return v; };
  const stepName = (e) => e.name.replace(/^.*: /, '');
  function stepRecord(e) {
    const teach = blocksOf(e, 'TEACHING_TEXT').map(firstStr);
    const options = blocksOf(e, 'OPTION').map((o) => ({ name: (o.args[0] || {}).name, instruction: firstStr((o.body || []).find((x) => x.kw === 'DESCRIPTION')) }));
    const subs = children(e.id).filter((c) => c.type === 'Step').sort((a, b) => (propValue(a, 'Order') || 0) - (propValue(b, 'Order') || 0));
    return {
      id: e.id, n: propValue(e, 'Order'), name: stepName(e), page: propValue(e, 'Page'),
      instruction: e.desc, teaching: teach[0] || null, followUp: firstStr(block(e, 'FOLLOW_UP')), teachingTwo: teach[1] || null,
      options: options.length ? options : null, substeps: subs.length ? subs.map(stepRecord) : null,
    };
  }
  const procedures = byType('Procedure').map((e) => ({
    id: e.id, name: e.name, phase: propValue(e, 'Phase'), page: propValue(e, 'Page'), instruction: e.desc,
    steps: children(e.id).filter((c) => c.type === 'Step').sort((a, b) => (propValue(a, 'Order') || 0) - (propValue(b, 'Order') || 0)).map(stepRecord),
  }));
  const byProcedure = new Map(procedures.map((p) => [p.name, p]));
  const proc = (name) => must(byProcedure.get(name), `procedure ${name}`);
  const step = (procName, stepName_) => must(proc(procName).steps.find((s) => s.name === stepName_), `step ${procName} / ${stepName_}`);
  const option = (procName, stepName_, optName) => must((step(procName, stepName_).options || []).find((o) => o.name === optName), `option ${optName}`);
  const substep = (procName, stepName_, subName) => must((step(procName, stepName_).substeps || []).find((o) => o.name === subName), `substep ${subName}`);

  const ruleEntities = byType('Rule');
  const optionalRules = ruleEntities.filter((e) => block(e, 'OPTIONAL')).map((e) => {
    const o = block(e, 'OPTIONAL');
    const body = o.body || [];
    const dflt = (body.find((x) => x.kw === 'DEFAULT') || { args: [] }).args[0];
    return { id: e.id, name: e.name, page: propValue(e, 'Page'), phase: propValue(e, 'Phase'), text: e.desc, optionalText: firstStr(body.find((x) => x.kw === 'TEXT')), default: dflt && dflt.id ? dflt.id : dflt };
  });
  const soloModules = ruleEntities.filter((e) => / Module$/.test(e.name)).map((e) => ({ id: e.id, name: e.name, page: propValue(e, 'Page'), text: e.desc }));
  const rules = ruleEntities.filter((e) => !block(e, 'OPTIONAL') && !/ Module$/.test(e.name)).map((e) => ({ id: e.id, name: e.name, page: propValue(e, 'Page'), phase: propValue(e, 'Phase'), text: e.desc }));
  const byRule = new Map(rules.map((r) => [r.name, r]));
  const rule = (name) => must(byRule.get(name), `rule ${name}`).text;
  const optional = (name) => must(optionalRules.find((o) => o.name === name), `optional rule ${name}`);
  const askFate = F.askFate;
  const fateProc = byProcedure.get('Ask Fate');

  // concepts: the type definitions that carry the book's words (Marks of Age, City Marks, Bond, Token…)
  const concept = (name) => must((named(name) || {}).desc, `concept ${name}`);

  // guidance: the sidebars, as ENTRY entities (their labels are slugs)
  const guidance = Object.values(E).filter((e) => e.form === 'ENTRY').map((e) => ({
    id: e.id, label: e.name,
    concerns: ((block(e, 'CONCERNS') || { args: [[]] }).args[0] || []).map((r) => r.name),
    topics: (block(e, 'TOPICS') || { args: [[]] }).args[0] || [],
    text: firstStr(block(e, 'TEXT')),
  }));
  const guidanceText = (label) => must(guidance.find((g) => g.label === label), `guidance ${label}`).text;

  // hooks: the rules' triggers (a file-level HOOKS block)
  const hooks = [];
  books().forEach((b) => (b.files || []).forEach((f) => (f.blocks || []).filter((x) => x.kw === 'HOOKS').forEach((h) => (h.body || []).forEach((hk) => {
    if (hk.kw !== 'HOOK') return;
    const body = hk.body || [];
    const trig = body.find((x) => x.kw === 'TRIGGER');
    hooks.push({
      formality: (body.find((x) => x.kw === 'CONDITIONAL') ? 'CONDITIONAL' : body.find((x) => x.kw === 'TAGGED') ? 'TAGGED' : body.find((x) => x.kw === 'PROSE') ? 'PROSE' : null),
      when: firstStr(body.find((x) => x.kw === 'WHEN')),
      trigger: trig ? ((trig.body || []).find((x) => x.kw === 'ANY') || { args: [[]] }).args[0] : [],
      then: ((body.find((x) => x.kw === 'THEN') || { args: [[]] }).args[0] || []).map((r) => r.name),
    });
  }))));

  const sections = byType('Rulebook Section').map((e) => ({ title: e.name.replace(/^Section: /, ''), page: propValue(e, 'Page') }));
  const lore = books().flatMap((b) => (b.lore || []).map((l) => ({
    file: l.file, title: (l.sections[0] && l.sections[0].title) || l.file,
    markdown: l.sections.map((s) => (s.title ? '#'.repeat(s.level || 1) + ' ' + s.title + '\n\n' : '') + s.paragraphs.join('\n\n')).join('\n\n'),
  })));
  const loreByTitle = (title) => must(lore.find((l) => l.title === title), `lore ${title}`);
  const themes = books().flatMap((b) => (b.files || []).flatMap((f) => (f.blocks || []).filter((x) => x.kw === 'THEMES').flatMap((t) => (t.body || []).map((x) => x.str).filter(Boolean))));

  return {
    T, F, books, book, entity, named, children, all, byType, roots, propValue, block, blocksOf, search,
    decks, byDeck, cards, byCard, cardsByDeck, shapeFamilies: F.shapeFamilies,
    locations, byLocation, riverlands, city, wanderingBorough, startingHomes, sceneLocation,
    transitLines: F.transitLines, byLine, transitDistance: F.transitDistance, cityStartingOptions: F.cityStartingOptions,
    bondLists: F.bondLists, ageTiers: F.ageTiers, bondsAtOrBelow, cityBondsAtOrBelow, memoryBonds, bondJoiner, openPromptWord, tierForMarks, palette,
    procedures, byProcedure, proc, step, option, substep, rules, byRule, rule, optionalRules, optional, soloModules, askFate, fateProc,
    concept, guidance, guidanceText, hooks, sections, lore, loreByTitle, themes,
  };
})();
