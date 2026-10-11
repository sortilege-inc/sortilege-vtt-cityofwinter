// sortilege-vtt-cityofwinter Worker: the session rooms, and the map library.
//
//   POST /session                  create a room → { code, gmToken }
//   GET  /session/:code            { exists }
//   GET  /session/:code/ws?token=  WebSocket into the room
//   GET  /library                  the library's images (X-Library-Key)
//   PUT  /library/:name            upload an image (X-Library-Key) → { key, name, size, type, uploaded }
//   GET  /library/:key             the image itself (public: the key carries a random part)
//   DELETE /library/:key           remove it (X-Library-Key)
//
// City of Winter has no GM: the one who starts the room holds the 'gm' token (the
// facilitator) and every seated player may send every game op — the rules are the system's
// (system/cityofwinter/ops.js, bundled here so the room applies the same ops the browser does).
// The library (PLAN.md, D4) is a KV namespace: nothing in the repo, one library per deployment,
// the upload key a Worker secret (LIBRARY_KEY) the facilitator enters once in Settings.
//
// A SessionRoom is one Durable Object per room code. It holds the campaign's shared
// document (whatever engine/ops.js declares shared) in SQLite, applies ops with the
// same ops.js the browser uses, and fans them out to every socket. Players get the
// filtered view (ops.js playerView). Rooms expire after 14 idle days; the campaign
// pack in the GM's repo is the durable record.
import { DurableObject } from 'cloudflare:workers';
// @ts-ignore — plain JS, UMD; esbuild bundles it
import Ops from '../../engine/ops.js';
// @ts-ignore — the game's ops register themselves on the same Ops (UMD, requires engine/ops.js)
import '../../system/cityofwinter/ops.js';

export interface Env {
  ALLOWED_ORIGIN: string;
  SESSION_ROOM: DurableObjectNamespace<SessionRoom>;
  LIBRARY: KVNamespace;
  LIBRARY_KEY?: string;      // `wrangler secret put LIBRARY_KEY`; locally in .dev.vars
}

const LIBRARY_MAX = 25 * 1024 * 1024;   // KV's value limit
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/avif'];
interface LibraryMeta { name: string; size: number; type: string; uploaded: number; }

type Role = 'gm' | 'player';
interface Attachment {
  role: Role;
  memberId: string | null;
  token: string | null;
}

const IDLE_MS = 14 * 24 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(len = 5): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ALLOWED_ORIGIN: the site's origins, comma-separated (the custom domain and the github.io
// fallback); localhost is always allowed for `wrangler dev`.
function allowedOrigins(env: Env): string[] {
  return env.ALLOWED_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
}

function originAllowed(env: Env, origin: string | null): boolean {
  if (!origin) return true;
  if (allowedOrigins(env).indexOf(origin) !== -1) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(env: Env, request: Request): HeadersInit {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': origin && originAllowed(env, origin) ? origin : allowedOrigins(env)[0],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Library-Key',
    Vary: 'Origin',
  };
}

function json(env: Env, request: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(env, request) } });
}

// ── the map library ──────────────────────────────────────────────────
function libraryKeyOk(env: Env, request: Request): boolean {
  const k = request.headers.get('X-Library-Key') || '';
  return !!env.LIBRARY_KEY && k.length > 0 && k === env.LIBRARY_KEY;
}

async function library(env: Env, request: Request, parts: string[]): Promise<Response> {
  if (!env.LIBRARY) return json(env, request, 503, { success: false, message: 'no library on this deployment' });
  const rest = parts.slice(1).map(decodeURIComponent).join('/');
  // the image: public, cached (a key is never reused)
  if (request.method === 'GET' && rest) {
    const obj = await env.LIBRARY.getWithMetadata<LibraryMeta>(rest, 'stream');
    if (!obj.value) return json(env, request, 404, { success: false, message: 'not found' });
    const meta = obj.metadata || ({} as LibraryMeta);
    return new Response(obj.value, { headers: { 'Content-Type': meta.type || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable', ...corsHeaders(env, request) } });
  }
  if (!libraryKeyOk(env, request)) return json(env, request, 403, { success: false, message: env.LIBRARY_KEY ? 'library key wrong' : 'no library key set on this deployment' });
  if (request.method === 'GET') {
    const out: Array<LibraryMeta & { key: string }> = [];
    let cursor: string | undefined;
    do {
      const page = await env.LIBRARY.list<LibraryMeta>({ cursor });
      page.keys.forEach((k) => out.push({ key: k.name, ...(k.metadata || ({ name: k.name, size: 0, type: '', uploaded: 0 } as LibraryMeta)) }));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    out.sort((a, b) => b.uploaded - a.uploaded);
    return json(env, request, 200, out);
  }
  if (request.method === 'PUT' && rest) {
    const type = (request.headers.get('Content-Type') || '').split(';')[0].trim();
    if (IMAGE_TYPES.indexOf(type) === -1) return json(env, request, 415, { success: false, message: 'images only (png, jpeg, webp, gif, svg, avif)' });
    const body = await request.arrayBuffer();
    if (!body.byteLength) return json(env, request, 400, { success: false, message: 'empty upload' });
    if (body.byteLength > LIBRARY_MAX) return json(env, request, 413, { success: false, message: 'too large: the limit is 25 MB' });
    const name = rest.replace(/[^A-Za-z0-9._ -]+/g, '_').slice(0, 120) || 'map';
    const key = `${Date.now().toString(36)}-${randomCode(6).toLowerCase()}-${name}`;
    const meta: LibraryMeta = { name, size: body.byteLength, type, uploaded: Date.now() };
    await env.LIBRARY.put(key, body, { metadata: meta });
    return json(env, request, 200, { key, ...meta });
  }
  if (request.method === 'DELETE' && rest) {
    await env.LIBRARY.delete(rest);
    return json(env, request, 200, { success: true });
  }
  return json(env, request, 404, { success: false, message: 'not found' });
}

export class SessionRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS claims (member_id TEXT PRIMARY KEY, token TEXT NOT NULL, name TEXT NOT NULL, claimed_at INTEGER NOT NULL);
      `);
    });
  }

  private get(key: string): any {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM kv WHERE key = ?', key).toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }

  private put(key: string, value: unknown): void {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, JSON.stringify(value));
  }

  private touch(): void {
    this.put('lastActive', Date.now());
    this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }

  private claimsMap(): Record<string, { name: string }> {
    const out: Record<string, { name: string }> = {};
    this.ctx.storage.sql.exec<{ member_id: string; name: string }>('SELECT member_id, name FROM claims').toArray().forEach((r) => (out[r.member_id] = { name: r.name }));
    return out;
  }

  async create(gmToken: string): Promise<void> {
    if (this.get('gmToken')) throw new Error('room exists');
    this.put('gmToken', gmToken);
    this.put('createdAt', Date.now());
    this.touch();
  }

  async exists(): Promise<boolean> {
    return !!this.get('gmToken');
  }

  async info(): Promise<{ exists: boolean; createdAt: number | null; lastActive: number | null; idleMs: number }> {
    const exists = !!this.get('gmToken');
    return { exists, createdAt: this.get('createdAt'), lastActive: this.get('lastActive'), idleMs: IDLE_MS };
  }

  async alarm(): Promise<void> {
    const last = this.get('lastActive') || 0;
    if (Date.now() - last < IDLE_MS) {
      this.ctx.storage.setAlarm(last + IDLE_MS);
      return;
    }
    for (const ws of this.ctx.getWebSockets()) ws.close(4000, 'session expired');
    await this.ctx.storage.deleteAll();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (!this.get('gmToken')) return new Response('no such session', { status: 404 });
    const token = new URL(request.url).searchParams.get('token');
    const att = this.roleFor(token);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [att.role]);
    server.serializeAttachment(att);
    return new Response(null, { status: 101, webSocket: client });
  }

  private roleFor(token: string | null): Attachment {
    if (token && token === this.get('gmToken')) return { role: 'gm', memberId: null, token };
    if (token) {
      const row = this.ctx.storage.sql.exec<{ member_id: string }>('SELECT member_id FROM claims WHERE token = ?', token).toArray()[0];
      if (row) return { role: 'player', memberId: row.member_id, token };
    }
    return { role: 'player', memberId: null, token: null };
  }

  private sendTo(ws: WebSocket, msg: unknown): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      /* closed */
    }
  }

  private broadcast(build: (att: Attachment) => unknown | null, except?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const att = ws.deserializeAttachment() as Attachment;
      const msg = build(att);
      if (msg) this.sendTo(ws, msg);
    }
  }

  private snapshotFor(att: Attachment): unknown {
    const doc = this.get('doc');
    return { type: 'snapshot', role: att.role, memberId: att.memberId, token: att.token, claims: this.claimsMap(), doc: doc ? (att.role === 'gm' ? doc : Ops.playerView(doc)) : null };
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch (e) {
      return;
    }
    const att = ws.deserializeAttachment() as Attachment;
    this.touch();

    switch (msg.type) {
      case 'hello':
        this.sendTo(ws, this.snapshotFor(att));
        return;

      case 'init': {
        if (att.role !== 'gm') return this.sendTo(ws, { type: 'error', message: 'only the facilitator can seed a session' });
        if (this.get('doc') && !msg.force) return this.sendTo(ws, this.snapshotFor(att));
        const doc: Record<string, unknown> = {};
        (Ops.SHARED_KEYS as string[]).forEach((k) => {
          if (msg.doc && msg.doc[k] !== undefined) doc[k] = msg.doc[k];
        });
        this.put('doc', doc);
        this.broadcast((a) => this.snapshotFor(a));
        return;
      }

      case 'op': {
        const doc = this.get('doc');
        if (!doc) return this.sendTo(ws, { type: 'error', message: 'session not seeded yet' });
        // a refused op was already applied to the sender's own copy (state.js commits before the room
        // answers): send it the room's document again, so it is never left holding a change that
        // never happened
        if (!Ops.permits(doc, att.role, att.memberId, msg.name, msg.args)) {
          this.sendTo(ws, { type: 'error', message: `not allowed: ${msg.name}` });
          return this.sendTo(ws, this.snapshotFor(att));
        }
        try {
          Ops.apply(doc, msg.name, msg.args);
        } catch (e) {
          // the op failed here but already ran on the sender's copy: resend the stored document
          this.sendTo(ws, { type: 'error', message: (e as Error).message });
          return this.sendTo(ws, this.snapshotFor(att));
        }
        this.put('doc', doc);
        const forPlayers = Ops.forPlayers(doc, msg.name, msg.args);
        this.broadcast((a) => {
          if (a.role === 'gm') return { type: 'op', name: msg.name, args: msg.args };
          return forPlayers ? { type: 'op', name: forPlayers.name, args: forPlayers.args } : null;
        }, ws);
        return;
      }

      case 'event': {
        const gmOnly = ['select', 'scene:changed'];
        if (att.role !== 'gm' && gmOnly.indexOf(msg.name) !== -1) return;
        if (['roll', 'ping', 'select', 'scene:changed', 'arm', 'card'].indexOf(msg.name) === -1) return;
        if (msg.name === 'card') {
          // a safety card: anonymous to the other players; the GM's copy names the seat that raised it
          const color = msg.payload && msg.payload.color;
          if (!color) return;
          const doc = this.get('doc');
          const member = att.memberId && doc ? (doc.party || []).find((x: any) => x.id === att.memberId) : null;
          const name = member ? member.name : (att.role === 'gm' ? 'the GM' : null);
          this.broadcast((a) => ({ type: 'event', name: 'card', payload: a.role === 'gm' ? { color, memberId: att.memberId, name } : { color } }), ws);
          return;
        }
        this.broadcast(() => ({ type: 'event', name: msg.name, payload: msg.payload }), ws);
        return;
      }

      case 'claim': {
        const doc = this.get('doc');
        const m = doc && (doc.party || []).find((x: any) => x.id === msg.memberId);
        if (!m) return this.sendTo(ws, { type: 'error', message: 'no such character' });
        const taken = this.ctx.storage.sql.exec<{ token: string }>('SELECT token FROM claims WHERE member_id = ?', msg.memberId).toArray()[0];
        if (taken && taken.token !== att.token && att.role !== 'gm') return this.sendTo(ws, { type: 'error', message: 'already claimed' });
        const token = att.role === 'player' && att.token ? att.token : randomToken();
        this.ctx.storage.sql.exec('DELETE FROM claims WHERE token = ?', token);
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO claims (member_id, token, name, claimed_at) VALUES (?, ?, ?, ?)', msg.memberId, token, m.name || 'Character', Date.now());
        if (att.role === 'player') {
          const next: Attachment = { role: 'player', memberId: msg.memberId, token };
          ws.serializeAttachment(next);
          this.sendTo(ws, { type: 'claimed', memberId: msg.memberId, token });
        }
        this.broadcast(() => ({ type: 'claims', claims: this.claimsMap() }));
        return;
      }

      case 'unclaim': {
        if (att.role !== 'gm' && att.memberId !== msg.memberId) return;
        this.ctx.storage.sql.exec('DELETE FROM claims WHERE member_id = ?', msg.memberId);
        for (const other of this.ctx.getWebSockets()) {
          const a = other.deserializeAttachment() as Attachment;
          if (a.role === 'player' && a.memberId === msg.memberId) {
            other.serializeAttachment({ role: 'player', memberId: null, token: null });
            this.sendTo(other, { type: 'claimed', memberId: null, token: null });
          }
        }
        this.broadcast(() => ({ type: 'claims', claims: this.claimsMap() }));
        return;
      }

      default:
        return;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch (e) {
      /* already closed */
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(env, request) });
    const origin = request.headers.get('Origin');
    if (!originAllowed(env, origin)) return json(env, request, 403, { success: false, message: 'origin not allowed' });

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'library') return library(env, request, parts);
    if (parts[0] === 'session') {
      if (parts.length === 1 && request.method === 'POST') {
        for (let attempt = 0; attempt < 5; attempt++) {
          const code = randomCode();
          const stub = env.SESSION_ROOM.getByName(code);
          if (await stub.exists()) continue;
          const gmToken = randomToken();
          await stub.create(gmToken);
          return json(env, request, 200, { code, gmToken });
        }
        return json(env, request, 500, { success: false, message: 'could not allocate a room code' });
      }
      const code = (parts[1] || '').toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(code)) return json(env, request, 400, { success: false, message: 'bad room code' });
      const stub = env.SESSION_ROOM.getByName(code);
      if (parts[2] === 'ws') return stub.fetch(request);
      if (parts.length === 2 && request.method === 'GET') return json(env, request, 200, await stub.info());
    }
    return json(env, request, 404, { success: false, message: 'not found' });
  },
};
