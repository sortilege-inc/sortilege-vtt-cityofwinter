# sortilege-vtt-cityofwinter

Live at [cityofwinter.sortilege.online](https://cityofwinter.sortilege.online/) — the site; `gm/` is the facilitator's table, `gm/play.html` a player's page.

A virtual tabletop for **City of Winter** (Ross Cowman, Heart of the Deernicorn, 2022) — the
family's table on every player's device, the River Scroll and the City Map, the Tradition Decks,
and the rules, built from the [Titterpig DSL corpus](https://github.com/sortilege-inc/city-of-winter)
in the shape of the Sortilege VTT family (`~/Sortilege/VTT/PLAYBOOK.md`). Plan, decisions and
proof: [PLAN.md](PLAN.md).

Buildless static site (GitHub Pages) plus one Cloudflare Worker for the rooms.

City of Winter has no GM: a **facilitator** starts the room and holds the campaign; every player
acts. There is nothing to hide, so nothing is hidden.

## Layout

```
engine/          the family's engine (bus, ops, state, session, shell, play, site) — no game words
system/cityofwinter/   this game: data accessors, the game as ops, panels, the notecard, the site tabs
data/            GENERATED from the corpus by build/ — never edit by hand
build/           build_data.py · verify_data.py (the two-way gate) · parse_dsl.py · build.sh
gm/              the facilitator's table (index), the table page, the player's page
worker/          the rooms (Cloudflare Worker + Durable Object) and the map library
```

## Building the data

```bash
bash build/build.sh    # [<path to titterpig-dsl-city-of-winter/0.5>]
```

parse every token of every file → `data/<book>.js` (rules · atlas · cards) → verify both ways →
`node --check`. Any failure exits non-zero. The gate: every string the corpus prints reaches the
data, and every string in the data came from the corpus.

## Running it

```bash
python3 -m http.server 8761
```

`http://localhost:8761/` is the site, `http://localhost:8761/gm/` the facilitator's table.

---

City of Winter is © 2022 Heart of the Deernicorn. This is an unofficial play aid: you need the
game to play.
