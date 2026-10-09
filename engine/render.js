// engine/render.js — DOM helpers. Nothing here knows the game.
window.VttRender = (function () {
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : v);
      }
    }
    (children || []).forEach((c) => {
      if (c == null || c === false) return;
      if (Array.isArray(c)) c.forEach((cc) => cc != null && e.appendChild(typeof cc === 'string' ? document.createTextNode(cc) : cc));
      else e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return e;
  }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Source text uses \n\n for paragraph breaks and \n for line breaks; nothing is
  // added or reflowed — the text stays the book's.
  function paragraphs(text, cls) {
    if (text == null || text === '') return null;
    const wrap = el('div', { class: cls || 'prose' });
    String(text).split(/\n\s*\n/).forEach((p) => {
      wrap.appendChild(el('p', { html: esc(p).replace(/\n/g, '<br>') }));
    });
    return wrap;
  }

  function chip(label, attrs) {
    return el('span', Object.assign({ class: 'chip' }, attrs || {}), [label]);
  }

  function button(label, onclick, cls) {
    return el('button', { class: 'btn' + (cls ? ' ' + cls : ''), type: 'button', onclick }, [label]);
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  // Drag-to-reorder over plain DOM: items (opts.item selector) move within and between lists
  // (opts.list selector, default: the root) as the pointer passes; opts.onDrop runs once the
  // drop lands, and reads the new order off the DOM. Pointer devices only (HTML5 drag events).
  function dragSort(root, opts) {
    let dragging = null;
    root.querySelectorAll(opts.item).forEach((it) => {
      it.draggable = true;
    });
    root.addEventListener('dragstart', (e) => {
      const it = e.target.closest && e.target.closest(opts.item);
      if (!it) return;
      dragging = it;
      it.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', it.dataset.id || '');
      }
    });
    root.addEventListener('dragover', (e) => {
      if (!dragging) return;
      e.preventDefault();
      const it = e.target.closest && e.target.closest(opts.item);
      if (it && it !== dragging) {
        const r = it.getBoundingClientRect();
        const after = e.clientY - r.top > r.height / 2;
        it.parentElement.insertBefore(dragging, after ? it.nextSibling : it);
        return;
      }
      const list = opts.list ? e.target.closest && e.target.closest(opts.list) : root;
      if (list && !it && !list.contains(dragging)) list.appendChild(dragging);
    });
    root.addEventListener('drop', (e) => e.preventDefault());
    root.addEventListener('dragend', () => {
      if (!dragging) return;
      dragging.classList.remove('dragging');
      dragging = null;
      if (opts.onDrop) opts.onDrop();
    });
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), ms || 250);
    };
  }

  return { el, esc, paragraphs, chip, button, clear, debounce, dragSort };
})();
