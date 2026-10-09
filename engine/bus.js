// engine/bus.js — one event bus for the whole tool, in-window and cross-window.
//
// Every window of this app (the GM page, the table, a player view) loads the same
// state.js over the same localStorage key, so persistence is already shared; what
// this adds is notification. A BroadcastChannel carries events to the other
// same-origin windows; handlers in this window run synchronously. The transport
// is one small object so a server-backed one (the session socket) rides beside it
// without touching panels.
//
// Event catalogue (payload shapes are the contract — keep them stable):
//   state:changed   { at, campaign, op | doc }   state.js saved; other windows apply the op
//                                               (or take the doc) before their handlers run
//   state:remote    { name, args }              an op applied from the session socket
//   op              { name, args, at }          an op committed in this window
//   scene:changed   { moduleId, sceneId }
//   select          { kind, … }                 see engine/panels.js
//   roll            { … }                       a dice roll for the log
//   ping            { sceneId, x, y }           the table
//
// Handlers receive (payload, meta); meta.remote is true when the event came from
// another window.
window.VttBus = (function () {
  const CHANNEL = (window.VttConfig && window.VttConfig.channel) || 'sortilege-vtt';
  const handlers = {};
  const windowId = Math.random().toString(36).slice(2, 10);
  let channel = null;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch (e) {
    channel = null;
  }

  function on(type, fn) {
    (handlers[type] = handlers[type] || []).push(fn);
    return () => off(type, fn);
  }

  function off(type, fn) {
    handlers[type] = (handlers[type] || []).filter((h) => h !== fn);
  }

  function dispatch(type, payload, meta) {
    (handlers[type] || []).slice().forEach((h) => {
      try {
        h(payload, meta);
      } catch (e) {
        console.error('VttBus handler failed for ' + type, e);
      }
    });
  }

  // opts.local: this window only
  function emit(type, payload, opts) {
    dispatch(type, payload, { remote: false });
    if (!(opts && opts.local) && channel) channel.postMessage({ type, payload, from: windowId });
  }

  if (channel) {
    channel.onmessage = (ev) => {
      const m = ev.data;
      if (!m || m.from === windowId) return;
      dispatch(m.type, m.payload, { remote: true });
    };
  }

  return { on, off, emit, windowId };
})();
