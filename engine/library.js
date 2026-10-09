// engine/library.js — the map library: images the facilitator uploads to the Worker's KV store
// (PLAN.md, D4). Nothing in the repo; one library per deployment. Uploading and listing need the
// library key — a Worker secret the facilitator types once into Settings; it lives in this
// browser's localStorage only, never in the pack or the shared state. Reading an image is public
// (its key carries a random part), so a map URL can sit in the shared document for every player.
window.VttLibrary = (function () {
  const CFG = window.VttConfig || {};
  const KEY = (CFG.storagePrefix || 'sortilege-vtt') + ':library-key';

  const enabled = () => !!CFG.library && !!CFG.workerUrl;
  const base = () => CFG.workerUrl + '/library';

  function key() {
    try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
  }
  function setKey(k) {
    try { if (k) localStorage.setItem(KEY, k); else localStorage.removeItem(KEY); } catch (e) { /* private mode */ }
  }
  const ready = () => enabled() && !!key();
  const headers = () => ({ 'X-Library-Key': key() });

  // the images in the library: [{ key, name, size, type, uploaded, url }], newest first
  async function list() {
    if (!ready()) return [];
    const res = await fetch(base(), { headers: headers() });
    if (!res.ok) throw new Error(res.status === 403 ? 'The library key is wrong.' : 'Could not list the library (HTTP ' + res.status + ').');
    const rows = await res.json();
    return rows.map((r) => Object.assign({ url: base() + '/' + r.key }, r));
  }

  // upload one image; resolves to its entry (with url)
  async function upload(file) {
    if (!ready()) throw new Error('Enter the library key in Settings first.');
    if (!/^image\//.test(file.type)) throw new Error('That is not an image.');
    const name = encodeURIComponent(file.name || 'map');
    const res = await fetch(base() + '/' + name, { method: 'PUT', headers: Object.assign({ 'Content-Type': file.type }, headers()), body: file });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || (res.status === 403 ? 'The library key is wrong.' : 'Upload failed (HTTP ' + res.status + ').'));
    }
    const r = await res.json();
    return Object.assign({ url: base() + '/' + r.key }, r);
  }

  // the library's maps: everything that isn't a token's art (VttConfig.tokenArt — those are tokens, not maps)
  const tokenArtUrls = () => new Set(Object.values(CFG.tokenArt || {}));
  async function maps() {
    const hidden = tokenArtUrls();
    return (await list()).filter((r) => !hidden.has(r.url));
  }

  async function remove(k) {
    if (!ready()) throw new Error('Enter the library key in Settings first.');
    const res = await fetch(base() + '/' + k, { method: 'DELETE', headers: headers() });
    if (!res.ok) throw new Error('Could not remove it (HTTP ' + res.status + ').');
  }

  return { enabled, ready, key, setKey, list, maps, upload, remove, base };
})();
