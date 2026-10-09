# sortilege-vtt-teeth Worker

The session rooms. `POST /session` creates a room (`{ code, gmToken }`);
`GET /session/:code/ws?token=…` is the WebSocket into it. Each room is a `SessionRoom`
Durable Object holding the campaign's shared document in SQLite; it applies ops with the same
`engine/ops.js` the browser uses, validates them by role (the GM token may do anything; a
player token only its claimed character and its own tokens), and sends players the filtered
view. Rooms expire after 14 idle days — the campaign pack is the durable record.

```bash
cd worker && npm install && npx wrangler dev --port 8787   # local; the app on localhost talks to it
cd worker && npx wrangler deploy                            # then set engine/config.js worker.deployed
```
