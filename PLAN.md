# sortilege-vtt-cityofwinter — plan, decisions, proof

A virtual tabletop for **City of Winter** (Ross Cowman, Heart of the Deernicorn, 2022), built as
the next system in the Sortilege VTT family (`~/Sortilege/VTT/PLAYBOOK.md`): TEETH's `engine/`,
`build/` and `worker/` copied whole at `sortilege-vtt-teeth` 2cef6b6 (2026-10-09), a
`system/cityofwinter/` written for this game, and `data/` generated from the DSL corpus in
`sortilege-inc/city-of-winter` (`titterpig-dsl-city-of-winter/0.5`) through the two-way gate.

It replaces the first play surface (`city-of-winter/web/`, 2026-08 → 2026-10), whose rules engine
becomes this system's ops table, and whose deferred requirement — several players on their own
devices — the family's Worker and rooms supply.

## What is different about this game (owner, 2026-10-09)

City of Winter has no GM. Everyone at the table plays a member of one family; every step of play is
a group decision. So:

- the **facilitator** is whoever starts the room and holds the campaign pack (reset, restore, the
  Undo for all) — the family's `gm` role, with nothing hidden from anyone;
- every seated **player** may send every game op — choose a scene, witness, pass the turn, save a
  card for a short-handed character, mark age at a Chapter's end, migrate — not only on their own
  notecard;
- First Session Setup happens at the table with everyone connected: a player joins the room and
  adds their own family member, instead of claiming one the facilitator made;
- the player's view is the whole document; the player's page is the whole table from their own
  device, with their seat.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 (owner) | The repo is public; `data/` (the corpus text) is published with it | Pages on the free org plan needs a public repo; `web/data/cow.json` already published the same text. |
| D2 (owner) | The corpus stays in `sortilege-inc/city-of-winter` (its generator, errata and gates); `build/build.sh` reads it by path. When this VTT is live, `web/` retires there and `cityofwinter.sortilege.online` moves here | One corpus repo, one VTT repo, as TEETH. Moving the corpus to `~/Sortilege/Titterpig/DSL/` would be churn for no gain now. |
| D3 (owner) | The family standards that assume a GM are off: no veil before `/gm/` (`gmGate: null`), the books open on the site (`siteBooks: true`). The `gm/` directory keeps its name so engine ports apply; every visible label says *facilitator* | The rules are the play surface and have been public since the first app. Robots / noindex standards still apply. |
| D4 (owner) | Maps are not in the repo. A **map library in R2**, bound to this VTT's Worker: `PUT /library/<name>` with an upload key held as a Worker secret and entered once in the facilitator's Settings (that browser's localStorage, never in state or a pack); `GET /library` lists with the key; `GET /library/<key>` reads publicly, keys carrying a random component so URLs are unguessable; one library per deployment; the map table's *set image* control gains *Upload…* and the library list. Rooms expire; R2 objects and the URLs in the pack endure | The Atlas art is not ours to publish (the campaign folder's README), and the owner needs it on the live instance. Lands with M4. |
| 5 | `build/parse_dsl.py`: a typed reference property may carry a value — `^"Deck" ^"Tradition Deck" #hash ^"Brass Ones"`, or a scalar | 12 of 14 corpus files failed on it; TEETH never used the form. Spec-legal (the canonical validator passes it). A generic extension; log it for the family port. |
| 6 | `build/build_data.py`: a keyword block that names an entity (`LOCATION ^"Cloud Citadel" #hash { … }` in a FRAME) is an entity (`form: "LOCATION"`), its nested DEFs its children | Without it the 32 locations were dropped — the same hole `coverage.ts` had with frames in August. |
| 7 | Every statement a record does not read into a named field is carried verbatim under `blocks` (`{ kw, args, body }`), including statements inside PROPERTIES that are not properties (a FIAT after an empty list), and the container's own statements on the file record (THEMES, DEPENDS_ON, a top-level GUIDANCE or HOOKS) | A corpus construct the build has never seen is never dropped; the gate then proves it. City of Winter's STEPS / OPTION / TEACHING_TEXT / ENTRANCE / OPTIONAL / GIVEN all ride this way. |
| 8 | OUTCOMES may be named DEF rows (*Fate Answers*), carried as `{ name, fields }` beside TEETH's `[band, text]` pairs; a TABLE may be COLUMNS + ROWS directly on the entity, a row's leading string its label | The gate's first run: 11 strings uncovered, all here. |
| 9 | `sources.json` may sit beside the version directory (City of Winter's is at the corpus root); the corpus's generator now writes a `sources` array of three books — *Rules V2*, *Atlas Edition*, *Tradition Cards* — in the family's shape, with `frame_files` as a file kind | The books the data ships are the published documents. |
| 10 | The data global is `window.COW`, the index's `system` read from `sources.json` | The engine never reads the global; the system module does. |
| 11 | The gate's hash pattern is generic (`#` + 1–4 letters + 16+ alphanumerics); statement keywords (`kw`), entity forms and nested-entity ids are skipped by key | COW-prefixed hashes; keyword names are the DSL's, not the book's. |

Found and left as is: the parser reads `SCOPE GLOBAL` as two bare statements (every all-caps word
starts one); nothing is lost — `DEFAULT off` keeps its value — and the system reads it as such.

## Milestones

| # | Milestone | Proof |
|---|---|---|
| M1 | `build/` generates `data/` from the corpus with the two-way gate | **landed 2026-10-09** — `build.sh`: 14 DSL files + 5 lore, 3 books, 722 entities (249 cards, 195 scenes, 32 locations, 11 procedures / 50 steps, 27 rules, 27 guidance entries, 8 hooks); `verify_data: 1459 DSL strings + 141 lore lines — 0 uncovered · 0 unsourced`; the gate proven to fail on a planted mangled prompt (1 uncovered, 1 unsourced) and clean after restore |
| M2 | `system/cityofwinter/`: data accessors; the game as ops with inverses; the facilitator's table — Stage · Location · Family · Turn & decks · Record · Rules & Books · Atlas · Traditions · Campaign — in the family's shell | |
| M3 | The player's page: join, add yourself or claim a seat, the same table from your own device; phone layout | |
| M4 | Sessions: the Worker, everyone-may-act rules, the map library (D4), two-origin live proof | |
| M5 | The site: Rules, Atlas, Traditions over `data/` | |
| M6 | Deploy: Pages, Worker, the domain moved, the old `web/` retired | |

## Family port notes

Engine-adjacent changes made here that a future port to the family might carry: decisions 5–9 and
11 (`build/parse_dsl.py`, `build/build_data.py`, `build/verify_data.py`). Nothing in
`sortilege-vtt-teeth` or any sibling was changed.
