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

_ERROR_SCHEMA = {
    "type": "object",
    "required": ["error"],
    "properties": {
        "error": {"type": "string",
                  "description": "short machine-readable error code"},
        "message": {"type": "string",
                    "description": "human-readable explanation"},
        "detail": {"type": "object",
                   "additionalProperties": True,
                   "description": "optional structured detail"},
    },
}


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
    return {
        "openapi": "3.1.0",
        "info": {"title": title, "version": version},
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
