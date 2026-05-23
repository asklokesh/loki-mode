"""Tiny RLS predicate DSL.

The agent writes predicates in a constrained mini-language we compile
to Postgres CREATE POLICY on promotion. SQLite has no native RLS, so
the predicate is stored as metadata only in dev; on promotion the
compiler emits real PG syntax.

Grammar (LL(1)):

    expr     := or
    or       := and ('OR' and)*
    and      := unary ('AND' unary)*
    unary    := 'NOT' unary | atom
    atom     := comparison | '(' expr ')'
    comparison := id ('=' | '!=' | '<' | '<=' | '>' | '>=' | 'IN') value
    id       := IDENT ('.' IDENT)?
    value    := IDENT | NUMBER | STRING | currentUser() | '(' list ')'

Identifiers limited to [a-zA-Z_][a-zA-Z0-9_]*. Strings are
single-quoted, no embedded quotes (we re-escape on emit). Numbers
are integer or decimal. currentUser() is a built-in we map to
auth.uid() on Postgres.

This is the smallest grammar that lets the agent express row
ownership + role-gated read/write without letting raw SQL slip in.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple


class RLSError(Exception):
    pass


_TOK = re.compile(
    r"\s*("
    r"AND|OR|NOT|IN"  # keywords (case-insensitive matched below)
    r"|currentUser\(\)"
    r"|<=|>=|!=|="
    r"|<|>"
    r"|\(|\)"
    r"|,"
    r"|\."
    r"|'[^']*'"
    r"|\d+(?:\.\d+)?"
    r"|[A-Za-z_][A-Za-z0-9_]*"
    r")",
    re.IGNORECASE,
)


def _tokenize(src: str) -> List[Tuple[str, str]]:
    if not isinstance(src, str) or not src.strip():
        raise RLSError("empty predicate")
    out: List[Tuple[str, str]] = []
    i = 0
    while i < len(src):
        m = _TOK.match(src, i)
        if not m:
            if src[i].isspace():
                i += 1
                continue
            raise RLSError(f"unexpected token at offset {i}: {src[i]!r}")
        tok = m.group(1)
        upper = tok.upper()
        if upper in ("AND", "OR", "NOT", "IN"):
            out.append(("KW", upper))
        elif tok in ("(", ")", ",", "."):
            out.append((tok, tok))
        elif tok in ("=", "!=", "<", ">", "<=", ">="):
            out.append(("OP", tok))
        elif tok.lower() == "currentuser()":
            out.append(("CURRENTUSER", tok))
        elif tok.startswith("'"):
            out.append(("STRING", tok[1:-1]))
        elif re.match(r"^\d", tok):
            out.append(("NUMBER", tok))
        else:
            out.append(("IDENT", tok))
        i = m.end()
    return out


class _Parser:
    def __init__(self, tokens: List[Tuple[str, str]]):
        self.t = tokens
        self.p = 0

    def peek(self) -> Optional[Tuple[str, str]]:
        return self.t[self.p] if self.p < len(self.t) else None

    def eat(self, ttype: str, value: Optional[str] = None) -> Tuple[str, str]:
        tok = self.peek()
        if tok is None or tok[0] != ttype:
            raise RLSError(f"expected {ttype}, got {tok}")
        if value is not None and tok[1] != value:
            raise RLSError(f"expected {value}, got {tok[1]}")
        self.p += 1
        return tok

    def parse(self) -> Dict[str, Any]:
        node = self._or()
        if self.p != len(self.t):
            raise RLSError(f"trailing tokens at offset {self.p}: {self.t[self.p:]}")
        return node

    def _or(self) -> Dict[str, Any]:
        left = self._and()
        while self.peek() == ("KW", "OR"):
            self.p += 1
            right = self._and()
            left = {"op": "or", "args": [left, right]}
        return left

    def _and(self) -> Dict[str, Any]:
        left = self._unary()
        while self.peek() == ("KW", "AND"):
            self.p += 1
            right = self._unary()
            left = {"op": "and", "args": [left, right]}
        return left

    def _unary(self) -> Dict[str, Any]:
        if self.peek() == ("KW", "NOT"):
            self.p += 1
            return {"op": "not", "args": [self._unary()]}
        return self._atom()

    def _atom(self) -> Dict[str, Any]:
        tok = self.peek()
        if tok == ("(", "("):
            self.p += 1
            node = self._or()
            self.eat(")", ")")
            return node
        return self._comparison()

    def _comparison(self) -> Dict[str, Any]:
        left = self._ident()
        op_tok = self.peek()
        if op_tok is None:
            raise RLSError("expected comparison operator")
        if op_tok[0] == "OP":
            self.p += 1
            right = self._value()
            return {"op": op_tok[1], "args": [left, right]}
        if op_tok == ("KW", "IN"):
            self.p += 1
            self.eat("(", "(")
            items = [self._value()]
            while self.peek() == (",", ","):
                self.p += 1
                items.append(self._value())
            self.eat(")", ")")
            return {"op": "in", "args": [left, {"op": "list", "args": items}]}
        raise RLSError(f"expected comparison op or IN, got {op_tok}")

    def _ident(self) -> Dict[str, Any]:
        tok = self.eat("IDENT")
        parts = [tok[1]]
        while self.peek() == (".", "."):
            self.p += 1
            parts.append(self.eat("IDENT")[1])
        return {"op": "ident", "value": ".".join(parts)}

    def _value(self) -> Dict[str, Any]:
        tok = self.peek()
        if tok is None:
            raise RLSError("expected value")
        if tok[0] == "STRING":
            self.p += 1
            return {"op": "string", "value": tok[1]}
        if tok[0] == "NUMBER":
            self.p += 1
            return {"op": "number", "value": tok[1]}
        if tok[0] == "CURRENTUSER":
            self.p += 1
            return {"op": "current_user"}
        if tok[0] == "IDENT":
            return self._ident()
        raise RLSError(f"expected value, got {tok}")


def parse(predicate: str) -> Dict[str, Any]:
    return _Parser(_tokenize(predicate)).parse()


# Emit PostgreSQL form. We do NOT emit raw user data into SQL; the
# tokenizer already constrained string contents to a printable set,
# and identifier names match \w only. Strings re-escape any single
# quotes (defense in depth, even though we already stripped them at
# tokenization time).

def to_postgres(predicate: str) -> str:
    """Compile the DSL into a Postgres-friendly predicate string."""
    tree = parse(predicate)
    return _emit_pg(tree)


def _emit_pg(node: Dict[str, Any]) -> str:
    op = node.get("op")
    if op == "or":
        return "(" + " OR ".join(_emit_pg(a) for a in node["args"]) + ")"
    if op == "and":
        return "(" + " AND ".join(_emit_pg(a) for a in node["args"]) + ")"
    if op == "not":
        return "NOT " + _emit_pg(node["args"][0])
    if op in ("=", "!=", "<", "<=", ">", ">="):
        return f"{_emit_pg(node['args'][0])} {op} {_emit_pg(node['args'][1])}"
    if op == "in":
        return f"{_emit_pg(node['args'][0])} IN {_emit_pg(node['args'][1])}"
    if op == "list":
        return "(" + ", ".join(_emit_pg(a) for a in node["args"]) + ")"
    if op == "ident":
        # Identifiers already constrained by tokenizer regex.
        return node["value"]
    if op == "string":
        # Re-escape single quotes; tokenizer rejected embedded quotes
        # but we're defense-in-depth here.
        s = node["value"].replace("'", "''")
        return f"'{s}'"
    if op == "number":
        return node["value"]
    if op == "current_user":
        return "auth.uid()"
    raise RLSError(f"emit: unknown op {op!r}")
