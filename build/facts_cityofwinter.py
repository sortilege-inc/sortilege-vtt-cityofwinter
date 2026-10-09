#!/usr/bin/env python3
"""
facts_cityofwinter.py — the game's facts the rules need, as a small UMD module:
system/cityofwinter/facts.js. Derived from data/*.js (never from the DSL directly), so the
chain is corpus → data (gated) → facts (checked against data). The Worker applies the same ops
the browser does, and an op that brings a deck into play or migrates the family needs to know
which cards a deck holds and what a Location connects to — this is that knowledge, and nothing
more: no rules text, no scene prompts.

Checked: every string in facts.js occurs in data/ (so nothing is invented here either).

    python3 build/facts_cityofwinter.py
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "system", "cityofwinter", "facts.js")


def load(book):
    src = open(os.path.join(HERE, "data", book + ".js"), encoding="utf-8").read()
    m = re.search(r"var d=(\{.*\});var T=", src, re.S)
    return json.loads(m.group(1))


def prop(e, name):
    return next((p for p in e.get("props", []) if p["name"] == name), None)


def pval(e, name):
    p = prop(e, name)
    if not p:
        return None
    if p["vk"] == "scalar" or p["vk"] == "enum":
        return p.get("value")
    if p["vk"] == "ref":
        return (p.get("ref") or {}).get("name") if "value" not in p else p["value"]
    if p["vk"] == "list":
        return [it.get("value") if it["vk"] == "scalar" else it.get("name") for it in p["items"]]
    return None


def block(e, kw):
    return next((b for b in e.get("blocks", []) if b.get("kw") == kw), None)


def blocks(e, kw):
    return [b for b in e.get("blocks", []) if b.get("kw") == kw]


def main():
    books = {k: load(k) for k in ("rules", "atlas", "cards")}
    E = {}
    order = []
    for b in books.values():
        for i in b["book"]["entities"]:
            if i not in E:
                order.append(i)
        E.update(b["entities"])
    by_type = lambda t: [E[i] for i in order if E[i].get("type") == t] + [e for e in E.values() if e.get("type") == t and e["id"] not in order]

    def all_of(t):
        seen, out = set(), []
        for e in [E[i] for i in order] + list(E.values()):
            if e.get("type") == t and e["id"] not in seen:
                seen.add(e["id"])
                out.append(e)
        return out

    # ── decks, banners, shape families ──
    banners = {pval(b, "Deck"): b for b in all_of("Tradition Banner") if pval(b, "Deck")}
    decks = {}
    for d in all_of("Tradition Deck"):
        bn = banners.get(d["name"])
        decks[d["name"]] = {
            "name": d["name"], "shape": pval(d, "Shape"), "region": pval(d, "Region"),
            "banner": bn["name"].replace(" Banner", "") if bn else d["name"],
            "names": pval(bn, "Names") if bn else [], "namePrompt": pval(bn, "Open Prompt") if bn else None,
            "cards": [],
        }
    shape_families = {}
    blank_icons = {}
    for f in all_of("Shape Family"):
        shape_families[pval(f, "Shape")] = pval(f, "Decks")
        blank_icons[f["name"]] = pval(f, "Shape")

    # ── cards, in each deck's printed order ──
    cards = {}
    for c in [E[i] for i in books["cards"]["book"]["entities"]]:
        if c.get("type") != "Tradition Card":
            continue
        deck = pval(c, "Deck")
        prompt = pval(c, "Prompt")
        cards[c["id"]] = {"id": c["id"], "name": c["name"], "deck": deck, "prompt": prompt,
                          "borough": prompt == "The Borough Wanders"}
        pnp = pval(c, "PnP Prompt")
        if pnp:
            cards[c["id"]]["pnpPrompt"] = pnp
        decks[deck]["cards"].append(c["id"])

    # ── locations ──
    locations = {}
    loc_order = []
    for e in [E[i] for i in books["atlas"]["book"]["entities"]]:
        if e.get("form") != "LOCATION":
            continue
        tags = (block(e, "TAGS") or {"args": [[]]})["args"][0]
        trads = []
        for r in (block(e, "LOCAL_TRADITIONS") or {"args": [[]]})["args"][0]:
            nm = r.get("name")
            trads.append("ANY:" + blank_icons[nm] if nm in blank_icons else nm)
        entrances = []
        for en in (block(e, "ENTRANCES") or {"body": []})["body"] or []:
            if en.get("kw") != "ENTRANCE":
                continue
            dest = next((x for x in en["body"] if x.get("kw") == "DESTINATION"), None)
            target = next((a for a in dest["args"] if isinstance(a, str)), None) if dest else None
            entrances.append({"text": en["args"][0]["name"], "target": target})
        route = "Caravan" if "route-caravan" in tags else "Lantern Ship" if "route-lantern-ship" in tags else None
        rec = {
            "name": e["name"], "region": "City" if "city" in tags else "Riverlands",
            "traditions": trads, "scenes": [E[c]["name"] for c in e["children"] if c in E],
            "connects": (block(e, "CONNECTS_TO") or {"args": [[]]})["args"][0],
            "entrances": entrances, "route": route,
            "startingHome": "starting-home" in tags, "isArrival": "city-entrance" in tags,
            "borough": "wandering-borough" in tags,
        }
        pt = block(e, "PRINTED_TITLE")
        if pt:
            rec["printedTitle"] = pt["args"][0]
        rs = block(e, "RULES_SPELLING")
        if rs:
            rec["rulesSpelling"] = rs["args"][0]
        ap = block(e, "ATLAS_PAGE")
        if ap:
            rec["page"] = ap["args"][0]
        locations[e["name"]] = rec
        loc_order.append(e["name"])
    borough = next(n for n, l in locations.items() if l["borough"])

    # ── transit ──
    lines = [{"name": t["name"], "die": pval(t, "Borough Die Result"), "stations": pval(t, "Stations")} for t in all_of("Transit Line")]
    dist = next(e for e in E.values() if e["name"] == "Transit Distance")
    derived = next((e for e in E.values() if e["name"] == "Transit Distance — Wintermount"), None)
    distance = {"order": dist["table"]["columns"], "rows": {r[0]: r[1:] for r in dist["table"]["rows"]}}
    if derived:
        distance["derived"] = {"rows": {r[0]: r[1:] for r in derived["table"]["rows"]}, "note": derived.get("desc")}

    # ── bonds, ages, fate, starting in the City ──
    bond_lists = [{"tier": pval(b, "Tier"), "kind": pval(b, "Kind"), "prompts": pval(b, "Prompts"), "openPrompt": pval(b, "Open Prompt")} for b in all_of("Bonds List")]
    tiers = [{"name": t["name"], "marks": [int(m) for m in pval(t, "Marks")], "marksText": pval(t, "Marks Text")} for t in all_of("Age Tier")]
    fate_e = next(e for e in E.values() if e["name"] == "Fate Answers")
    fate = []
    for o in fate_e["outcomes"]:
        f = {x["name"]: x.get("value") for x in o["fields"]}
        fate.append({"roll": f.get("Roll"), "outcome": o["name"], "definition": f.get("Definition")})
    starts = []
    for e in [E[i] for i in order]:
        if e["name"].startswith("Starting Option: "):
            starts.append({"tradition": pval(e, "Tradition"), "home": pval(e, "Home"), "text": pval(e, "As Printed")})

    facts = {
        "decks": decks, "deckOrder": list(decks.keys()), "cards": cards, "shapeFamilies": shape_families,
        "locations": locations, "locationOrder": loc_order, "wanderingBorough": borough,
        "transitLines": lines, "transitDistance": distance,
        "bondLists": bond_lists, "ageTiers": tiers, "askFate": fate, "cityStartingOptions": starts,
    }

    # ── the check: every string in facts occurs somewhere in data/ ──
    data_text = "\n".join(open(os.path.join(HERE, "data", k + ".js"), encoding="utf-8").read() for k in books)
    OWN = {"City", "Riverlands", "Caravan", "Lantern Ship"}   # the build's own labels for tags the DSL spells as route-caravan / city

    def strings(v):
        if isinstance(v, str):
            yield v
        elif isinstance(v, dict):
            for k, x in v.items():
                if k not in ("id",):
                    yield from strings(x)
                yield from strings(k) if False else ()
        elif isinstance(v, list):
            for x in v:
                yield from strings(x)
    # "ANY:<shape>" is this build's spelling of a blank icon (the DSL's "Blank <shape> icon" reference)
    missing = sorted({s for s in strings(facts) if s and s not in OWN and not s.startswith("ANY:") and json.dumps(s, ensure_ascii=False)[1:-1] not in data_text and s not in data_text})
    if missing:
        print("facts: %d string(s) not found in data/: %s" % (len(missing), missing[:10]))
        sys.exit(1)

    head = ("/* Generated by build/facts_cityofwinter.py from data/ — do not edit by hand.\n"
            "   The facts the rules need (decks and their cards in printed order, Locations and what they\n"
            "   connect to, transit, bonds, ages); UMD so the Worker applies the same ops the browser does. */\n")
    body = json.dumps(facts, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(head)
        fh.write("(function (root, factory) {\n  if (typeof module !== 'undefined' && module.exports) module.exports = factory();\n"
                 "  else root.CowFacts = factory();\n})(typeof self !== 'undefined' ? self : this, function () {\n  return %s;\n});\n" % body)
    print("facts_cityofwinter: %d decks, %d cards, %d locations, %d transit lines, %d bond lists → %s" % (
        len(decks), len(cards), len(locations), len(lines), len(bond_lists), os.path.relpath(OUT, HERE)))


if __name__ == "__main__":
    main()
