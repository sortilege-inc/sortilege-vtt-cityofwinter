// engine/panels.js — the panel registry and the selection model.
//
// A panel is { label, group, render(container, ctx), count() }. A system module
// (system/teeth/panels.js) registers its panels here; the shell (engine/app.js)
// mounts them. `ctx` is per mount: ctx.on(type, fn) subscribes to the bus and is
// torn down with the panel, so re-rendering never leaks handlers; ctx.navigate(id)
// asks the shell to show another panel.
//
// Selection shapes (kind → fields):
//   entity  { id }                    any corpus entity, by hash
//   scene   { moduleId, sceneId }
//   party   { id }                    a party member
//   clock   { id }
window.VttPanels = (function () {
  const Bus = window.VttBus;
  const PANELS = {};
  const ORDER = [];
  let current = null;

  // an instance may leave panels out (VttConfig.hidePanes: ids)
  const HIDDEN = ((window.VttConfig || {}).hidePanes || []).slice();
  function register(id, panel) {
    if (HIDDEN.indexOf(id) !== -1) return;
    PANELS[id] = panel;
    if (ORDER.indexOf(id) === -1) ORDER.push(id);
  }

  function select(sel) {
    current = sel;
    Bus.emit('select', sel);
  }

  function selection() {
    return current;
  }

  Bus.on('select', (sel, meta) => {
    if (meta && meta.remote) current = sel;
  });

  function makeCtx(navigate) {
    const subs = [];
    return {
      on(type, fn) {
        subs.push(Bus.on(type, fn));
      },
      navigate: navigate || ((id) => window.VttApp && window.VttApp.open(id)),
      teardown() {
        subs.splice(0).forEach((u) => u());
      },
    };
  }

  // the order the shell lists them in: registration order, or the instance's (VttConfig.paneOrder,
  // those ids first)
  function list() {
    const first = ((window.VttConfig || {}).paneOrder || []).filter((id) => PANELS[id]);
    return first.concat(ORDER.filter((id) => first.indexOf(id) === -1)).map((id) => Object.assign({ id }, PANELS[id]));
  }

  function mount(container, id, ctx) {
    const p = PANELS[id];
    container.innerHTML = '';
    if (!p) {
      container.appendChild(window.VttRender.el('div', { class: 'empty' }, ['Unknown panel: ' + id]));
      return;
    }
    p.render(container, ctx);
  }

  return { PANELS, register, list, mount, makeCtx, select, selection };
})();
