#!/usr/bin/env python3
"""
parse_dsl.py — a faithful recursive-descent parser for the Titterpig DSL (spec 0.5),
carried over from the NOVA Open tool and extended for the hash-bound list bodies
(`LIST OF #hash ^"Type" [ … ]`) and CHOICE blocks the TEETH corpus uses.

Deterministic: no paraphrase, no LLM, no heuristics on prose. Every string
that comes out is the source string with only DSL escapes resolved.

The tokenizer is lifted from titterpig-dsl/ttrpg_validator.py (the canonical
one) so token boundaries match what the spec validator sees.

Contract: every token in the file must be consumed by exactly one node. If a
token is dropped, parse_file() raises. That is the parser's own gate — a
silent drop is the failure mode that loses content while still "working".
"""

import json
import os
import re
import sys

# ───────────────────────────── tokenizer ─────────────────────────────
# Lifted from titterpig-dsl/ttrpg_validator.py::tokenize (canonical boundaries).


class Tok:
    __slots__ = ("kind", "val", "line")

    def __init__(self, kind, val, line):
        self.kind, self.val, self.line = kind, val, line

    def __repr__(self):
        return "%s(%r)@%d" % (self.kind, self.val, self.line)


SIMPLE = {"{": "LBRACE", "}": "RBRACE", "[": "LBRACK", "]": "RBRACK",
          ",": "COMMA", ":": "COLON", "(": "LPAREN", ")": "RPAREN", "=": "EQ"}


def tokenize(text):
    toks = []
    i, n, line = 0, len(text), 1
    while i < n:
        c = text[i]
        if c == "\n":
            line += 1
            i += 1
            continue
        if c in " \t\r":
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if c == "#":
            # a hash id is '#' + alphanumeric; anything else is a comment
            if i + 1 >= n or not text[i + 1].isalnum():
                while i < n and text[i] != "\n":
                    i += 1
                continue
            j = i + 1
            while j < n and (text[j].isalnum() or text[j] == "_"):
                j += 1
            toks.append(Tok("HASH", text[i:j], line))
            i = j
            continue
        if c == "^" and i + 1 < n and text[i + 1] == '"':
            j, start = i + 2, line
            while j < n and text[j] != '"':
                if text[j] == "\\" and j + 1 < n:       # an escaped quote inside a name (^"Hammer that's \"just for fun\"")
                    j += 2
                    continue
                if text[j] == "\n":
                    line += 1
                j += 1
            if j >= n:
                raise SyntaxError("unterminated caret reference at line %d" % start)
            toks.append(Tok("CARET", unescape(text[i + 2:j]), start))
            i = j + 1
            continue
        if c == '"':
            if text[i:i + 3] == '"""':
                j = text.find('"""', i + 3)
                if j < 0:
                    raise SyntaxError("unterminated triple-quoted string at line %d" % line)
                toks.append(Tok("STR", text[i + 3:j], line))
                line += text[i:j + 3].count("\n")
                i = j + 3
                continue
            j, start = i + 1, line
            while j < n and text[j] != '"':
                if text[j] == "\\" and j + 1 < n:
                    j += 2
                    continue
                if text[j] == "\n":
                    line += 1
                j += 1
            if j >= n:
                raise SyntaxError("unterminated string at line %d" % start)
            toks.append(Tok("STR", text[i + 1:j], start))
            i = j + 1
            continue
        if c in SIMPLE:
            toks.append(Tok(SIMPLE[c], c, line))
            i += 1
            continue
        if c.isdigit() or (c == "-" and i + 1 < n and text[i + 1].isdigit()):
            j = i + 1
            while j < n and text[j].isdigit():
                j += 1
            toks.append(Tok("INT", text[i:j], line))
            i = j
            continue
        if c.isalpha() or c == "_":
            j = i + 1
            while j < n and (text[j].isalnum() or text[j] == "_"):
                j += 1
            w = text[i:j]
            toks.append(Tok("BOOL" if w in ("true", "false") else "ID", w, line))
            i = j
            continue
        # '->' in a REFERENCES arrow, and any other punctuation, is not a token.
        i += 1
    return toks


ESCAPES = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\"}


def unescape(s):
    """Resolve DSL string escapes. Nothing else is touched — the text is verbatim."""
    out, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        if c == "\\" and i + 1 < n:
            nxt = s[i + 1]
            if nxt in ESCAPES:
                out.append(ESCAPES[nxt])
                i += 2
                continue
        out.append(c)
        i += 1
    return "".join(out)


# ───────────────────────────── parser ─────────────────────────────

# Words that may appear inside a statement's argument run without starting a new
# statement. Everything else in ALL_CAPS terminates the run.
# NB: REQUIRED / FIXED / MIN / MAX are deliberately absent. They are property-
# declaration modifiers, and parse_prop consumes them directly without consulting
# is_starter — listing them here instead made `REQUIRED "a"` swallow the
# `REQUIRED "b"` line after it in an OBJECTIVES block.
MODIFIERS = {
    "OF", "TO", "INCLUDE", "PARENT", "ADDS_TO",
    "DEF", "STRING", "INTEGER", "BOOLEAN", "FLOAT",
    "LIST", "ENUM", "DEFAULT", "REPLACES", "IN",
}

# Type words that introduce a property's type in a property declaration.
SCALAR_TYPES = {"STRING", "INTEGER", "BOOLEAN", "FLOAT", "TEXT"}


def is_starter(t):
    """Does this token begin a new statement, terminating the current arg run?

    A STRING never terminates a run — `NAME "x"` has to stay one statement. Bare
    string items (THEMES members, REFERENCES arrows) bound themselves instead, in
    parse_str_item, which takes exactly one string.
    """
    if t.kind in ("HASH", "CARET", "RBRACE"):
        return True
    if t.kind == "ID":
        return re.match(r"^[A-Z][A-Z0-9_]*$", t.val) is not None and t.val not in MODIFIERS
    return False


class Parser:
    def __init__(self, toks, path):
        self.t = toks
        self.i = 0
        self.path = path

    def peek(self, k=0):
        j = self.i + k
        return self.t[j] if j < len(self.t) else None

    def next(self):
        t = self.t[self.i]
        self.i += 1
        return t

    def expect(self, kind, val=None):
        t = self.peek()
        if t is None or t.kind != kind or (val is not None and t.val != val):
            raise SyntaxError("%s: expected %s %s, got %r (line %s)"
                              % (self.path, kind, val or "", t, t.line if t else "EOF"))
        return self.next()

    # ---- containers ----

    def parse_file(self):
        """<KIND> "Name" [EXTENDS "Parent"] { body }, or a bare run of entities."""
        if self.peek() and self.peek().kind != "ID":
            # .actor files are a bare sequence of top-level DEFs, no container.
            body = self.parse_body()
            if self.i != len(self.t):
                raise SyntaxError("%s: %d tokens left unconsumed (next %r)"
                                  % (self.path, len(self.t) - self.i, self.peek()))
            return {"container": None, "name": None, "extends": None, "body": body}
        kind = self.expect("ID").val
        name = self.expect("STR").val
        parent = None
        if self.peek() and self.peek().kind == "ID" and self.peek().val == "EXTENDS":
            self.next()
            parent = self.expect("STR").val
        self.expect("LBRACE")
        body = self.parse_body()
        self.expect("RBRACE")
        if self.i != len(self.t):
            raise SyntaxError("%s: %d tokens left unconsumed after container close (next %r)"
                              % (self.path, len(self.t) - self.i, self.peek()))
        return {"container": kind, "name": name, "extends": parent, "body": body}

    def parse_body(self):
        items = []
        while True:
            t = self.peek()
            if t is None or t.kind == "RBRACE":
                return items
            items.append(self.parse_item())

    def parse_item(self):
        t = self.peek()
        if t.kind == "CARET":
            return self.parse_prop()
        if t.kind == "HASH":
            return self.parse_entity()
        if t.kind == "STR":
            return self.parse_str_item()
        if t.kind == "ID":
            return self.parse_kw()
        raise SyntaxError("%s: unexpected %r at line %d" % (self.path, t, t.line))

    # ---- #hash [KIND] name DEF { … } ----

    def parse_entity(self):
        h = self.next().val
        ekind = None
        t = self.peek()
        if t.kind == "ID" and t.val != "DEF":
            ekind = self.next().val
        t = self.peek()
        if t.kind == "STR":
            nm = self.next().val
        elif t.kind == "CARET":
            nm = self.next().val
        else:
            raise SyntaxError("%s: entity %s has no name (line %d)" % (self.path, h, t.line))
        self.expect("ID", "DEF")
        self.expect("LBRACE")
        body = self.parse_body()
        self.expect("RBRACE")
        return {"n": "entity", "hash": h, "kind": ekind, "name": nm, "body": body}

    # ---- bare "string" item (THEMES member, REFERENCES arrow line) ----

    def parse_str_item(self):
        s = unescape(self.next().val)
        args = []
        # A REFERENCES arrow is `"label" -> #hash ^"Name"`; the arrow itself is not a
        # token, so the hash/caret pair is all that follows. Only a complete pair
        # continues this item — a lone hash belongs to whatever comes next.
        while (self.peek() and self.peek().kind == "HASH"
               and self.peek(1) and self.peek(1).kind == "CARET"):
            h = self.next().val
            args.append({"k": "ref", "hash": h, "v": self.next().val})
        return {"n": "str", "v": s, "args": args}

    # ---- KEYWORD args… [ { body } ] ----

    def parse_kw(self):
        kw = self.next().val
        args = []
        first = True
        while True:
            t = self.peek()
            if t is None or t.kind in ("RBRACE", "LBRACE"):
                break
            if t.kind == "LBRACK":
                args.append({"k": "list", "v": self.parse_list()})
                first = False
                continue
            if t.kind == "COMMA":
                self.next()
                continue
            if is_starter(t):
                # A name and an id belong to the same statement in either order:
                # `EXTENDS #hash ^"Name"` and `SCENE ^"Name" #hash`. A CARET may also
                # open a run, as the subject of LOCATION / RULE / CHECK / CLUE.
                prev = args[-1]["k"] if args else None
                if t.kind in ("CARET", "HASH") and first:
                    pass
                elif t.kind == "CARET" and prev == "hash" and len(args) == 1:
                    pass
                elif t.kind == "HASH" and prev == "caret" and len(args) == 1:
                    pass
                else:
                    # a complete `#hash ^"Name"` pair is one subject; a hash after it opens the
                    # NEXT statement (`EXTENDS #h ^"Table"` followed by `#h2 ^"Row" DEF { … }`)
                    break
            a = self.arg()
            args.append(a)
            first = False
            # `<field> DEFAULT <value>` (a MODIFICATIONS line) is exactly three tokens.
            # Without this the run would swallow every following line, since a
            # lowercase field name does not read as a statement starter.
            if a["k"] == "id" and a["v"] == "DEFAULT":
                nxt = self.peek()
                if nxt and nxt.kind in ("STR", "INT", "BOOL", "ID"):
                    args.append(self.arg())
                break
        body = None
        if self.peek() and self.peek().kind == "LBRACE":
            self.next()
            body = self.parse_body()
            self.expect("RBRACE")
        return {"n": "kw", "kw": kw, "args": args, "body": body}

    # ---- ^"Name" <type> [value] [modifiers] ----

    def parse_prop(self):
        node = self.parse_prop_head()
        # trailing modifiers on any property shape: REQUIRED · FIXED · MIN n · MAX n
        # (a REQUIRED left unconsumed would read as a statement and swallow the next line)
        while True:
            t3 = self.peek()
            if t3 is None or t3.kind != "ID" or t3.val not in ("REQUIRED", "FIXED", "MIN", "MAX"):
                break
            m = self.next().val
            if m in ("MIN", "MAX"):
                node[m.lower()] = int(self.expect("INT").val)
            else:
                node[m.lower()] = True
        return node

    def parse_prop_head(self):
        name = self.next().val
        node = {"n": "prop", "name": name}
        t = self.peek()
        if t is None:
            return node
        if t.kind == "ID" and t.val == "DEF":
            self.next()
            self.expect("LBRACE")
            node["type"] = "DEF"
            node["body"] = self.parse_body()
            self.expect("RBRACE")
            return node
        if t.kind == "ID" and t.val == "LIST":
            self.next()
            node["type"] = "LIST"
            if self.peek() and self.peek().kind == "ID" and self.peek().val == "OF":
                self.next()
                ot = self.next()
                if ot.kind == "HASH":
                    # spec 0.5 §5d: `LIST OF #hash ^"Type"` — the hash binds the type name that follows
                    node["of_hash"] = ot.val
                    ot = self.next()
                node["of"] = ot.val
                node["of_kind"] = "caret" if ot.kind == "CARET" else "id"
            if self.peek() and self.peek().kind == "LBRACK":
                node["items"] = self.parse_list()
            return node
        if t.kind == "ID" and t.val == "ENUM":
            self.next()
            node["type"] = "ENUM"
            if self.peek() and self.peek().kind == "LBRACK":
                node["options"] = [e["v"] for e in self.parse_list() if e.get("k") == "str"]
            elif self.peek() and self.peek().kind == "STR":
                node["value"] = unescape(self.next().val)   # `^"Region" ENUM "City"` — a chosen value
            return node
        if t.kind == "ID" and t.val in SCALAR_TYPES:
            node["type"] = self.next().val
            t2 = self.peek()
            if t2 and t2.kind in ("STR", "INT", "BOOL"):
                v = self.next()
                node["value"] = (unescape(v.val) if v.kind == "STR"
                                 else int(v.val) if v.kind == "INT"
                                 else v.val == "true")
            return node
        if t.kind == "CARET":
            # `^"Prop" ^"Type"` declares a typed reference; a value may follow — `#hash ^"Name"`
            # (City of Winter: `^"Deck" ^"Tradition Deck" #hash ^"Brass Ones"`) or a scalar
            node["type"] = "REF"
            node["ref"] = self.next().val
            t2 = self.peek()
            if t2 and t2.kind == "HASH":
                node["hash"] = self.next().val
                if self.peek() and self.peek().kind == "CARET":
                    node["value_name"] = self.next().val
            elif t2 and t2.kind in ("STR", "INT", "BOOL"):
                v = self.next()
                node["value"] = (unescape(v.val) if v.kind == "STR" else int(v.val) if v.kind == "INT" else v.val == "true")
            return node
        if t.kind == "ID" and t.val == "CHOICE":
            # `^"Vice" CHOICE PICK 1 [ … ]` — a CHOICES row
            self.next()
            node["type"] = "CHOICE"
            if self.peek() and self.peek().kind == "ID" and self.peek().val == "PICK":
                self.next()
                node["pick"] = int(self.expect("INT").val)
            if self.peek() and self.peek().kind == "LBRACK":
                node["items"] = self.parse_list()
            return node
        if t.kind == "HASH":
            node["type"] = "REF"
            node["hash"] = self.next().val
            if self.peek() and self.peek().kind == "CARET":
                node["ref"] = self.next().val
            return node
        # bare value with no type word
        if t.kind in ("STR", "INT", "BOOL"):
            v = self.next()
            node["type"] = "VALUE"
            node["value"] = (unescape(v.val) if v.kind == "STR"
                             else int(v.val) if v.kind == "INT"
                             else v.val == "true")
            return node
        return node

    # ---- [ a, b, c ] ----

    def parse_list(self):
        self.expect("LBRACK")
        out, cur = [], None
        while True:
            t = self.peek()
            if t is None:
                raise SyntaxError("%s: unterminated list" % self.path)
            if t.kind == "RBRACK":
                self.next()
                if cur is not None:
                    out.append(cur)
                return out
            if t.kind == "COMMA":
                self.next()
                if cur is not None:
                    out.append(cur)
                cur = None
                continue
            if t.kind == "ID" and t.val == "DEF":
                self.next()
                self.expect("LBRACE")
                body = self.parse_body()
                self.expect("RBRACE")
                cur = {"k": "def", "body": body}
                continue
            a = self.arg()
            if cur is None:
                cur = a
            elif cur["k"] == "hash" and a["k"] == "caret":
                cur = {"k": "ref", "hash": cur["v"], "v": a["v"]}
            else:
                # two bare values with no comma — keep both rather than drop one
                out.append(cur)
                cur = a
        # unreachable

    def arg(self):
        t = self.next()
        if t.kind == "STR":
            return {"k": "str", "v": unescape(t.val)}
        if t.kind == "INT":
            return {"k": "int", "v": int(t.val)}
        if t.kind == "BOOL":
            return {"k": "bool", "v": t.val == "true"}
        if t.kind == "HASH":
            return {"k": "hash", "v": t.val}
        if t.kind == "CARET":
            return {"k": "caret", "v": t.val}
        if t.kind == "ID":
            return {"k": "id", "v": t.val}
        raise SyntaxError("%s: cannot use %r as a value (line %d)" % (self.path, t, t.line))


def parse_path(path):
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    toks = tokenize(text)
    if not toks:
        return None
    doc = Parser(toks, os.path.basename(path)).parse_file()
    doc["file"] = os.path.basename(path)
    return doc


DSL_EXTS = (".ttrpg", ".actor", ".arc", ".frame", ".setting", ".campaign")


def parse_dir(d):
    docs = []
    for fn in sorted(os.listdir(d)):
        if fn.startswith("."):
            continue
        ext = os.path.splitext(fn)[1]
        if ext not in DSL_EXTS:
            continue
        doc = parse_path(os.path.join(d, fn))
        if doc:
            doc["ext"] = ext[1:]
            docs.append(doc)
    return docs


def parse_files(paths):
    """Parse an explicit list of DSL files (a book's, in its sources.json order)."""
    docs = []
    for p in paths:
        ext = os.path.splitext(p)[1]
        if ext not in DSL_EXTS:
            continue
        doc = parse_path(p)
        if doc:
            doc["ext"] = ext[1:]
            doc["path"] = p
            docs.append(doc)
    return docs


if __name__ == "__main__":
    src = sys.argv[1]
    out = parse_dir(src) if os.path.isdir(src) else [parse_path(src)]
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1)
    print()
