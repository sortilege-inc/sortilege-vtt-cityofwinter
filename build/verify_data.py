#!/usr/bin/env python3
"""
verify_data.py — the content gate, both directions (the NOVA Open rule):

  1. COVERAGE — every string the corpus prints (every STR and caret token in every DSL
     file, every paragraph and heading of every .lore) is present in data/*.js, except the
     container-header metadata listed in SKIP_KEYWORDS (each with its reason).
  2. FIDELITY — every string in data/*.js came from the corpus. Catches text the build
     invented or mangled, which coverage alone cannot.

Exit 0 = both clean. Never weaken this to make a build pass: fix the build.

    python3 build/verify_data.py [<path to titterpig-dsl-teeth/0.5>]
"""
import json
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parse_dsl import tokenize, unescape  # noqa: E402
from build_data import DEFAULT_CORPUS  # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sources_path(corpus):
    """sources.json sits in the version directory (TEETH) or one level up beside it (City of Winter)."""
    for d in (corpus, os.path.dirname(os.path.abspath(corpus))):
        p = os.path.join(d, "sources.json")
        if os.path.exists(p):
            return p
    raise SystemExit("no sources.json in or beside %s" % corpus)

SKIP_KEYWORDS = {
    "VERSION": "DSL content version of the source file",
    "SPEC_VERSION": "Titterpig spec version of the source file",
    "RELEASE_DATE": "conversion date of the source file",
}
# Words the DSL grammar uses that survive into the data as field labels, not game text.
TYPE_WORDS = {"STRING", "INTEGER", "BOOLEAN", "FLOAT", "TEXT", "DEF", "TEMPLATE", "ACTOR", "LIST", "ENUM", "REF", "CHOICE"}
# Keys whose values this build writes itself. Skipping is by key only, never by value.
BUILD_KEYS = {"id", "hash", "typeHash", "ofHash", "parent", "children", "book", "file", "vk", "note", "corpus", "system", "container", "level",
              "kw", "form", "entity"}   # kw: a statement's keyword; form: DEF/ACTOR/LOCATION; entity: a nested entity's id
HASH_ID = re.compile(r"^#?[A-Za-z]{1,4}[A-Za-z0-9]{16,}$")


def corpus_strings(corpus, sources):
    want, skipped = Counter(), Counter()
    lore_lines = Counter()
    for src in sources["sources"]:
        for k in ("ttrpg_files", "arc_files", "actor_files", "frame_files"):
            for f in src.get(k, []):
                toks = tokenize(open(os.path.join(corpus, f), encoding="utf-8").read())
                i = 0
                # the container header: KIND "id" [EXTENDS "parent"] — module identifiers, not text
                if toks and toks[0].kind == "ID" and toks[0].val in ("BASE", "EXTENSION", "ARC", "FRAME", "SETTING", "CAMPAIGN"):
                    skipped[toks[1].val] += 1
                    i = 2
                    if len(toks) > 3 and toks[2].kind == "ID" and toks[2].val == "EXTENDS":
                        skipped[toks[3].val] += 1
                        i = 4
                while i < len(toks):
                    t = toks[i]
                    if t.kind == "ID" and t.val in SKIP_KEYWORDS:
                        j = i + 1
                        while j < len(toks) and toks[j].kind in ("STR", "INT"):
                            if toks[j].kind == "STR":
                                skipped[unescape(toks[j].val)] += 1
                            j += 1
                        i = j
                        continue
                    if t.kind == "STR":
                        want[unescape(t.val)] += 1
                    elif t.kind == "CARET":
                        want[t.val] += 1
                    i += 1
        for f in src.get("lore_files", []):
            for line in open(os.path.join(corpus, f), encoding="utf-8").read().split("\n"):
                s = line.strip()
                if not s or s.startswith("<!--"):
                    continue
                lore_lines[re.sub(r"^#{1,6}\s+", "", s)] += 1
    return want, skipped, lore_lines


def data_strings():
    got = Counter()
    blobs = []
    for fn in sorted(os.listdir(os.path.join(HERE, "data"))):
        if not fn.endswith(".js"):
            continue
        src = open(os.path.join(HERE, "data", fn), encoding="utf-8").read()
        m = re.search(r"var d=(\{.*\});var T=", src, re.S) or re.search(r"T\.index=(\{.*\});\}\)\(\);\s*$", src, re.S)
        if not m:
            raise SystemExit("verify_data: %s is not in the expected shape" % fn)
        blobs.append(json.loads(m.group(1)))

    def walk(n):
        if isinstance(n, dict):
            for k, v in n.items():
                if k in BUILD_KEYS and not isinstance(v, (dict, list)):   # scalar ids/labels the build writes; containers are always walked
                    continue
                walk(v)
        elif isinstance(n, list):
            for x in n:
                walk(x)
        elif isinstance(n, str):
            if not HASH_ID.match(n):
                got[n] += 1

    for b in blobs:
        walk(b)
    return blobs, got


def main():
    corpus = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CORPUS
    sources = json.load(open(sources_path(corpus), encoding="utf-8"))
    want, skipped, lore_lines = corpus_strings(corpus, sources)
    blobs, got = data_strings()
    joined = "\n".join(got)

    # text the build adds of its own: book titles / kinds from sources.json, the index
    ours = set(TYPE_WORDS) | {s["title"] for s in sources["sources"]} | {"core", "shared", "one-shot", "supplement", "standalone game"}
    ours |= {s.get("kind") for s in sources["sources"] if s.get("kind")} | {sources.get("system") or ""}
    ours |= {v for b in blobs for v in (b.get("index") or {}).get("counts", {}).values() if isinstance(v, str)}
    ours |= {"data/%s.js" % s["id"] for s in sources["sources"]}

    missing = sorted(k for k in want if k not in got)
    # lore is carried as paragraphs, headings as titles: a paragraph line must appear inside some data string
    lore_missing = sorted(k for k in lore_lines if k not in got and k not in joined)
    invented = sorted(k for k in got if k not in want and k not in ours and k not in skipped and k not in lore_lines
                      and not any(k in p or p in k for p in ()) and k not in joined_lore(lore_lines))

    print("verify_data: corpus prints %d distinct DSL strings + %d lore lines (%d header values skipped)" % (len(want), len(lore_lines), len(skipped)))
    if missing:
        print("  UNCOVERED — in the corpus, not in data/: %d" % len(missing))
        for s in missing[:25]:
            print("    %r" % s[:110])
    if lore_missing:
        print("  UNCOVERED LORE — lines of .lore not in data/: %d" % len(lore_missing))
        for s in lore_missing[:10]:
            print("    %r" % s[:110])
    if invented:
        print("  UNSOURCED — in data/, not in the corpus: %d" % len(invented))
        for s in invented[:25]:
            print("    %r" % s[:110])
    if not missing and not lore_missing and not invented:
        print("  0 uncovered · 0 unsourced — every string round-trips")
    return 1 if (missing or lore_missing or invented) else 0


def joined_lore(lore_lines):
    """Lore paragraphs are multi-line in the .lore (wrapped); the data joins a paragraph's
    lines with '\\n', so a data string is sourced when every one of its lines is a lore line."""
    class Lines:
        def __contains__(self, s):
            parts = [p.strip() for p in s.split("\n") if p.strip()]
            return bool(parts) and all(p in lore_lines for p in parts)
    return Lines()


if __name__ == "__main__":
    sys.exit(main())
