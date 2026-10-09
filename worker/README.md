# sortilege-vtt-cityofwinter Worker

The session rooms. `POST /session` creates a room (`{ code, gmToken }`);
`GET /session/:code/ws?token=…` is the WebSocket into it. Each room is a `SessionRoom`
Durable Object holding the campaign's shared document in SQLite; it applies ops with the same
`engine/ops.js` the browser uses, validates them by role (the facilitator's token may do anything; a
seated player may send every game op — City of Winter is played by everyone), and sends players the filtered
view. Rooms expire after 14 idle days — the campaign pack is the durable record.

It also holds the **map library** (PLAN.md, D4): `PUT /library/<name>` stores an image in the
`LIBRARY` KV namespace (25 MB each; nothing in the repo), `GET /library` lists it, `GET
/library/<key>` serves an image publicly (the key carries a random part), `DELETE /library/<key>`
removes one. Uploading, listing and deleting need the `X-Library-Key` header — the secret
`LIBRARY_KEY`, which the facilitator enters once in the table page's Settings (that browser's
localStorage only).

```bash
cd worker && npx wrangler dev --port 8810                   # local; the app on localhost talks to it (key: .dev.vars)
cd worker && npx wrangler secret put LIBRARY_KEY            # once per deployment: the upload key
cd worker && npx wrangler deploy                            # then engine/config.js worker.deployed
```
