// system/cityofwinter/ui.js — the game's own DOM helpers: the Tradition Card in its printing,
// the token, the book's text laid out, the die. Carried from the first play surface. The
// family's VttRender serves the shell; these serve the table.
window.CowUI = (function () {
  function el(tag, attrs) {
    const kids = Array.prototype.slice.call(arguments, 2);
    const node = document.createElement(tag);
    for (const k of Object.keys(attrs || {})) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    add.apply(null, [node].concat(kids));
    return node;
  }

  /** node.append, but skipping null/false/undefined — which append() would print. */
  function add(node) {
    const kids = Array.prototype.slice.call(arguments, 1).flat(Infinity);
    for (const k of kids) if (k !== null && k !== undefined && k !== false) node.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return node;
  }

  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

  /** A modal that resolves to the chosen value (or null if dismissed). */
  function choose(title, options, opts) {
    opts = opts || {};
    const cancel = opts.cancel === undefined ? 'Never mind' : opts.cancel;
    return new Promise((resolve) => {
      let done = false;
      const dlg = el('dialog', { class: 'cow-dialog' });
      const finish = (v) => { if (!done) { done = true; resolve(v); dlg.close(); } };
      add(dlg, el('h2', { text: title }), opts.body || null,
        el('div', { class: 'btnrow' },
          options.map((o) => el('button', { class: o.class || '', text: o.label, onclick: () => finish(o.value) })),
          cancel ? el('button', { class: 'ghost', text: cancel, onclick: () => finish(null) }) : null));
      document.body.append(dlg);
      dlg.addEventListener('close', () => { dlg.remove(); if (!done) { done = true; resolve(null); } });
      dlg.showModal();
    });
  }

  /** A modal with arbitrary content; resolves when closed. `render(close)` builds it. */
  function modal(title, render) {
    return new Promise((resolve) => {
      const dlg = el('dialog', { class: 'cow-dialog' });
      const close = (v) => { dlg.close(); resolve(v); };
      add(dlg, el('h2', { text: title }), render(close));
      document.body.append(dlg);
      dlg.addEventListener('close', () => { dlg.remove(); resolve(undefined); });
      dlg.showModal();
    });
  }

  /** The X-Card, as the rules define it (p.11). */
  function xcard(text, credit) {
    modal('✕ The X-Card', (close) => el('div', {},
      el('p', { class: 'lede', text: text }),
      credit ? el('p', { class: 'small muted', text: credit }) : null,
      el('div', { class: 'btnrow' }, el('button', { class: 'primary', text: 'No questions asked', onclick: () => close() }))));
  }

  function marksRow(n, crossed, kind) {
    kind = kind || '';
    const row = el('span', { class: 'marks', title: `${n} ${kind === 'city' ? 'City Mark' : 'Mark'}${n === 1 ? '' : 's'}${crossed ? `, ${crossed} crossed off` : ''}` });
    for (let i = 0; i < n; i++) row.append(el('span', { class: `mark ${kind} ${i < crossed ? 'off' : ''}`.trim() }));
    if (n === 0 && kind !== 'city') row.append(el('span', { class: 'nomarks', text: 'no Marks' }));
    return row;
  }

  function shapeIcon(shape) {
    return el('span', { class: `shape ${shape || 'circle'}`, title: shape });
  }

  /** A Tradition Card in the game's own printing. Face down it shows its back — "every card has an icon on the back showing which deck it belongs to" (p.8). Selectable cards are real buttons. */
  function cardEl(card, deck, palette, opts) {
    opts = opts || {};
    const tag = opts.onclick ? 'button' : 'div';
    const node = el(tag, {
      type: tag === 'button' ? 'button' : null,
      class: ['tcard', opts.selectable || opts.onclick ? 'selectable' : '', opts.chosen ? 'chosen' : '', opts.facedown ? 'facedown' : '', opts.dim ? 'dim' : '', opts.size ? `sz-${opts.size}` : ''].filter(Boolean).join(' '),
      dataset: { palette, card: card.id },
      title: opts.title !== undefined ? opts.title : (opts.facedown ? `${card.deck} — face down` : `${card.prompt} — ${card.deck}`),
      'aria-pressed': opts.chosen === undefined || tag !== 'button' ? null : String(!!opts.chosen),
      onclick: opts.onclick,
    });
    if (opts.facedown) {
      node.append(el('span', { class: 'back' }, shapeIcon(deck && deck.shape), el('span', { class: 'deck', text: card.deck })));
    } else {
      if (card.borough) node.append(el('span', { class: 'borough', title: 'The Borough Wanders', text: '⌂' }));
      node.append(el('span', { class: 'prompt', text: card.prompt }), el('span', { class: 'deck' }, shapeIcon(deck && deck.shape), card.deck));
    }
    if (opts.badge) node.append(el('span', { class: 'cbadge', text: opts.badge }));
    return node;
  }

  /** A character's token: the colour they chose, worn with their initial — or ☾ for a Memory. */
  function tokenEl(ch, tokens, opts) {
    opts = opts || {};
    if (ch && ch.isMemory) return el('span', { class: `token ${opts.size || ''} memorytok`.trim(), title: `${ch.name} · a Memory`, 'aria-hidden': 'true', text: '☾' });
    const t = tokens.find((x) => x.id === (ch && ch.token)) || { color: 'var(--chalk-faint)', name: '' };
    const initial = ((ch && ch.name) || '?').trim().charAt(0).toUpperCase();
    return el('span', { class: `token ${opts.size || ''}`.trim(), style: `--tok:${t.color}`, title: opts.title !== undefined ? opts.title : `${(ch && ch.name) || ''}${t.name ? ` · ${t.name} token` : ''}`, 'aria-hidden': 'true', text: initial });
  }

  /** The book's own words, laid out: blank lines are paragraphs, "- " lines a list. Nothing is reworded. */
  function ruleText(text, opts) {
    opts = opts || {};
    const node = el(opts.tag || 'div', { class: `rtext ${opts.cls || ''}`.trim() });
    if (!text) return node;
    let list = null;
    for (const para of String(text).split(/\n\s*\n/)) {
      const t = para.trim();
      if (!t) continue;
      const m = t.match(/^-\s+([\s\S]*)$/);
      if (m) {
        if (!list) { list = el('ul'); node.append(list); }
        list.append(el('li', { text: m[1] }));
      } else {
        list = null;
        node.append(el('p', { text: t }));
      }
    }
    return node;
  }

  /** A collapsible aside, closed by default. */
  function details(summary) {
    const kids = Array.prototype.slice.call(arguments, 1);
    return el('details', { class: 'aside' }, el('summary', {}, summary), kids);
  }

  /** A die face with pips. */
  function dieFace(n, opts) {
    const size = (opts && opts.size) || 64;
    const P = { 1: [[2, 2]], 2: [[1, 1], [3, 3]], 3: [[1, 1], [2, 2], [3, 3]], 4: [[1, 1], [3, 1], [1, 3], [3, 3]], 5: [[1, 1], [3, 1], [2, 2], [1, 3], [3, 3]], 6: [[1, 1], [3, 1], [1, 2], [3, 2], [1, 3], [3, 3]] }[n] || [];
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 40 40');
    svg.setAttribute('width', size); svg.setAttribute('height', size);
    svg.setAttribute('class', 'die6'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `the Die shows ${n}`);
    const r = document.createElementNS(ns, 'rect');
    Object.entries({ x: 2, y: 2, width: 36, height: 36, rx: 7 }).forEach(([k, v]) => r.setAttribute(k, v));
    svg.append(r);
    for (const [cx, cy] of P) {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', cx * 10); c.setAttribute('cy', cy * 10); c.setAttribute('r', 3.4);
      svg.append(c);
    }
    return svg;
  }

  function rollDie() { return 1 + Math.floor(Math.random() * 6); }

  function fmtTime(iso) {
    try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }

  /** Markdown-ish rendering for the .lore bodies: hard-wrapped lines join into one paragraph. */
  function miniMarkdown(md) {
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/`(.+?)`/g, '<code>$1</code>').replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
    const blocks = [];
    let cur = null;
    const flush = () => { if (cur) blocks.push(cur); cur = null; };
    for (const raw of String(md || '').split('\n')) {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) { flush(); continue; }
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flush(); blocks.push({ kind: 'h', level: m[1].length, text: m[2] }); continue; }
      if (line === '---') { flush(); blocks.push({ kind: 'hr' }); continue; }
      if ((m = line.match(/^[-*]\s+(.*)$/))) { flush(); cur = { kind: 'li', text: m[1] }; continue; }
      if ((m = line.match(/^>\s?(.*)$/))) {
        if (cur && cur.kind === 'q') cur.text += m[1] ? ' ' + m[1] : '\n'; else { flush(); cur = { kind: 'q', text: m[1] }; }
        continue;
      }
      if (cur && (cur.kind === 'p' || cur.kind === 'li')) { cur.text += ' ' + line.trim(); continue; }
      flush(); cur = { kind: 'p', text: line.trim() };
    }
    flush();
    let out = '', inList = false;
    for (const b of blocks) {
      if (b.kind !== 'li' && inList) { out += '</ul>'; inList = false; }
      if (b.kind === 'h') out += `<h${b.level + 1}>${inline(b.text)}</h${b.level + 1}>`;
      else if (b.kind === 'hr') out += '<div class="flourish"></div>';
      else if (b.kind === 'li') { if (!inList) { out += '<ul>'; inList = true; } out += `<li>${inline(b.text)}</li>`; }
      else if (b.kind === 'q') out += `<blockquote>${b.text.split('\n').filter((x) => x.trim()).map((x) => `<p>${inline(x.trim())}</p>`).join('')}</blockquote>`;
      else out += `<p>${inline(b.text)}</p>`;
    }
    if (inList) out += '</ul>';
    return out;
  }

  return { el, add, clear, choose, modal, xcard, marksRow, shapeIcon, cardEl, tokenEl, ruleText, details, dieFace, rollDie, fmtTime, miniMarkdown };
})();
