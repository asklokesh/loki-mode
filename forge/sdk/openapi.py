"""OpenAPI 3.1 schema generator (X-47).

Renders an OpenAPI 3.1 spec matching the surfaces the SDK exposes:

    /db/v1/<table>            GET list, POST insert
    /db/v1/<table>/{id}       GET one
    /storage/v1/<bucket>/sign POST sign url
    /functions/v1/<name>      POST invoke
    /realtime/v1?channel=     WS subscribe (documented as text/event-stream)

The spec is determined by the live forge state. Like the SDK codegen,
output is deterministic so check-in friendly.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List

from .codegen import _state_dump, _norm_type, _pascal


def _err_resp(description: str) -> Dict[str, Any]:
    return {
        "description": description,
        "content": {"application/json": {
            "schema": {"$ref": "#/components/schemas/Error"},
        }},
    }


# N-09: shared error response bank. Routes attach the subset they
# actually emit; reading the spec tells the consumer exactly which
# 4xx codes to handle. The Error schema is registered once in
# components below so $ref resolution stays clean.
_ERR = {
    "401": _err_resp("unauthorized - missing or invalid auth token"),
    "403": _err_resp("forbidden - row-level policy denied this caller"),
    "404": _err_resp("not found"),
    "422": _err_resp("unprocessable entity - request body failed validation"),
}

# N-23: enumerate every error code our routes actually emit so
# consumers can generate typed clients. Adding a new code requires
# extending this list AND the route that returns it - that coupling
# is intentional (the spec is the contract).
_ERROR_CODES = (
    "unauthorized",
    "forbidden",
    "not_found",
    "validation_failed",
    "rate_limited",
    "row_level_policy_denied",
    "missing_field",
    "invalid_field",
    "method_not_allowed",
    "conflict",
    "payload_too_large",
    "internal",
)

_ERROR_SCHEMA = {
    "type": "object",
    "required": ["error"],
    "properties": {
        "error": {"type": "string",
                  "enum": list(_ERROR_CODES),
                  "description": "short machine-readable error code"},
        "message": {"type": "string",
                    "description": "human-readable explanation"},
        "detail": {"type": "object",
                   "additionalProperties": True,
                   "description": "optional structured detail"},
    },
    # N-35: discriminator on `error` lets generated clients switch at
    # the type-system level. Each code maps to a per-code envelope
    # declared below (Error_<code>); the envelopes intersect with the
    # base Error via `allOf` so the schema stays compatible with
    # generators that don't honor discriminator.
    "discriminator": {
        "propertyName": "error",
        "mapping": {
            code: f"#/components/schemas/Error_{code}"
            for code in _ERROR_CODES
        },
    },
}


def _per_code_error_schemas() -> Dict[str, Any]:
    """Per-code envelopes for the discriminator mapping. Each is a
    thin allOf over the base Error with `error` pinned to its constant."""
    out: Dict[str, Any] = {}
    for code in _ERROR_CODES:
        out[f"Error_{code}"] = {
            "allOf": [
                {"$ref": "#/components/schemas/Error"},
                {"type": "object",
                 "properties": {"error": {"const": code}}},
            ],
        }
    return out


_TYPE_OPENAPI = {
    "id": {"type": "integer"},
    "integer": {"type": "integer"},
    "real": {"type": "number"},
    "boolean": {"type": "boolean"},
    "text": {"type": "string"},
    "uuid": {"type": "string", "format": "uuid"},
    "timestamp": {"type": "string", "format": "date-time"},
    "json": {},  # any
    "blob": {"type": "string", "format": "byte"},
}


def generate(forge_dir: str, *, title: str = "Forge API",
             version: str = "v1") -> Dict[str, Any]:
    state = _state_dump(forge_dir)
    paths: Dict[str, Any] = {}
    schemas: Dict[str, Any] = {}

    for t in (state.get("database") or {}).get("tables", []):
        schema_name = _pascal(t["name"])
        schemas[schema_name] = _table_schema(t)
        paths[f"/db/v1/{t['name']}"] = {
            "get": {
                "tags": ["db"],
                "operationId": f"db_list_{t['name']}",
                "summary": f"list {t['name']}",
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {"application/json": {
                            "schema": {
                                "type": "array",
                                "items": {"$ref": f"#/components/schemas/{schema_name}"},
                            },
                        }},
                    },
                    "401": _ERR["401"],
                    "403": _ERR["403"],
                },
            },
            "post": {
                "tags": ["db"],
                "operationId": f"db_insert_{t['name']}",
                "summary": f"insert {t['name']}",
                "requestBody": {
                    "required": True,
                    "content": {"application/json": {
                        "schema": {"$ref": f"#/components/schemas/{schema_name}"},
                    }},
                },
                "responses": {
                    "201": {
                        "description": "created",
                        "content": {"application/json": {
                            "schema": {"$ref": f"#/components/schemas/{schema_name}"},
                        }},
                    },
                    "401": _ERR["401"],
                    "403": _ERR["403"],
                    "422": _ERR["422"],
                },
            },
        }
        paths[f"/db/v1/{t['name']}/{{id}}"] = {
            "get": {
                "tags": ["db"],
                "operationId": f"db_get_{t['name']}",
                "summary": f"get {t['name']} by id",
                "parameters": [{
                    "name": "id", "in": "path", "required": True,
                    "schema": {"type": "string"},
                }],
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {"application/json": {
                            "schema": {"$ref": f"#/components/schemas/{schema_name}"},
                        }},
                    },
                    "401": _ERR["401"],
                    "403": _ERR["403"],
                    "404": _ERR["404"],
                },
            },
        }

    for b in state.get("buckets", []) or []:
        paths[f"/storage/v1/{b['name']}/sign"] = {
            "post": {
                "tags": ["storage"],
                "operationId": f"storage_sign_{b['name']}",
                "summary": f"sign {b['name']} url",
                "requestBody": {
                    "required": True,
                    "content": {"application/json": {
                        "schema": {
                            "type": "object",
                            "required": ["path"],
                            "properties": {
                                "path": {"type": "string"},
                                "expiresIn": {"type": "integer",
                                              "default": 3600},
                            },
                        },
                    }},
                },
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {"application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {"url": {"type": "string",
                                                       "format": "uri"}},
                            },
                        }},
                    },
                    "401": _ERR["401"],
                    "403": _ERR["403"],
                    "404": _ERR["404"],
                    "422": _ERR["422"],
                },
            },
        }

    for fn in state.get("functions", []) or []:
        paths[f"/functions/v1/{fn['name']}"] = {
            "post": {
                "tags": ["functions"],
                "operationId": f"function_invoke_{fn['name']}",
                "summary": f"invoke {fn['name']}",
                "requestBody": {
                    "content": {"application/json": {
                        "schema": {"type": "object"},
                    }},
                },
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {"application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "ok": {"type": "boolean"},
                                    "stdout": {"type": "string"},
                                    "stderr": {"type": "string"},
                                },
                            },
                        }},
                    },
                    "401": _ERR["401"],
                    "403": _ERR["403"],
                    "404": _ERR["404"],
                    "422": _ERR["422"],
                },
            },
        }

    schemas["Error"] = _ERROR_SCHEMA
    schemas.update(_per_code_error_schemas())
    # N-82: read repo URL from a package.json sibling so generated
    # clients carry the project's contact info. Best-effort - missing
    # file omits the contact block.
    import time as _t
    # N-92: x-generated-at timestamp so consumers can detect a fresh
    # spec without diffing the whole document. Standard OpenAPI
    # extension prefix.
    # N-102: emit RFC3339 with milliseconds so two regenerations
    # within the same second still differ.
    _now = _t.time()
    _ms = int((_now - int(_now)) * 1000)
    info: Dict[str, Any] = {
        "title": title, "version": version,
        "x-generated-at": _t.strftime("%Y-%m-%dT%H:%M:%S", _t.gmtime(_now))
                          + f".{_ms:03d}Z",
    }
    try:
        for cand in (os.path.join(os.path.dirname(forge_dir), "..", "package.json"),
                     "package.json"):
            if os.path.isfile(cand):
                with open(cand, "r", encoding="utf-8") as f:
                    pkg = json.load(f)
                repo = pkg.get("repository") or {}
                url = repo if isinstance(repo, str) else repo.get("url")
                if url:
                    info["contact"] = {"name": pkg.get("name", "forge"),
                                       "url": url}
                break
    except Exception:
        pass
    return {
        "openapi": "3.1.0",
        "info": info,
        # N-66: tag manifest so generators split SDKs into modules.
        # N-89: per-tag externalDocs points at the wiki section.
        "tags": [
            {"name": "db", "description": "Database CRUD",
             "externalDocs": {"description": "wiki",
                              "url": "https://github.com/asklokesh/loki-mode/wiki/Forge-DB"}},
            {"name": "storage", "description": "Object storage + signed URLs",
             "externalDocs": {"description": "wiki",
                              "url": "https://github.com/asklokesh/loki-mode/wiki/Forge-Storage"}},
            {"name": "functions", "description": "Edge function invocation",
             "externalDocs": {"description": "wiki",
                              "url": "https://github.com/asklokesh/loki-mode/wiki/Forge-Functions"}},
        ],
        # N-74: declare the dashboard root as the default server so
        # generated clients have a base URL out of the box. Operators
        # override via OpenAPI's standard `servers:` swap.
        "servers": [
            {"url": "http://127.0.0.1:57374",
             "description": "local dashboard"},
        ],
        "paths": paths,
        "components": {"schemas": schemas},
    }


def _table_schema(t: Dict[str, Any]) -> Dict[str, Any]:
    props: Dict[str, Any] = {}
    required: List[str] = []
    for c in t.get("columns", []):
        ann = _TYPE_OPENAPI.get(_norm_type(c.get("type", "text")),
                                {"type": "string"})
        props[c["name"]] = dict(ann)
        if c.get("notnull") or c.get("primary_key"):
            required.append(c["name"])
    return {"type": "object", "properties": props, "required": required}


def write_to(forge_dir: str, out_path: str) -> Dict[str, Any]:
    spec = generate(forge_dir)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(spec, f, indent=2, sort_keys=True)
    os.replace(tmp, out_path)
    return {"path": os.path.abspath(out_path),
            "paths": len(spec.get("paths", {})),
            "schemas": len(spec.get("components", {}).get("schemas", {}))}
