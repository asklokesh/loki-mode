"""Pure-stdlib validation and deterministic identity for Outcome Contract v0.1."""

import hashlib
import json

SCHEMA = "autonomi-outcome-contract/v0.1"
KINDS = {"human", "agent", "service", "organization"}
TOP_KEYS = {"schema", "id", "intent", "acceptance", "executor", "verifier",
            "constraints", "evidence"}


class ContractValidationError(ValueError):
    def __init__(self, path, message):
        self.path = path
        self.message = message
        super().__init__("%s: %s" % (path, message))


def _fail(path, message):
    raise ContractValidationError(path, message)


def _text(value, path):
    if not isinstance(value, str) or not value.strip():
        _fail(path, "must be a non-empty string")


def _identity(value, path):
    if not isinstance(value, dict):
        _fail(path, "must be an object")
    extra = sorted(set(value) - {"id", "kind"})
    if extra:
        _fail(path + "." + extra[0], "unknown property")
    for key in ("id", "kind"):
        if key not in value:
            _fail(path + "." + key, "is required")
    _text(value["id"], path + ".id")
    if value["kind"] not in KINDS:
        _fail(path + ".kind", "must be one of: %s" % ", ".join(sorted(KINDS)))


def validate(contract):
    if not isinstance(contract, dict):
        _fail("$", "must be an object")
    extra = sorted(set(contract) - TOP_KEYS)
    if extra:
        _fail("$." + extra[0], "unknown property")
    for key in ("schema", "id", "intent", "acceptance", "executor", "verifier"):
        if key not in contract:
            _fail("$." + key, "is required")
    if contract["schema"] != SCHEMA:
        _fail("$.schema", "must equal %s" % SCHEMA)
    _text(contract["id"], "$.id")
    _text(contract["intent"], "$.intent")
    acceptance = contract["acceptance"]
    if not isinstance(acceptance, list) or not acceptance:
        _fail("$.acceptance", "must be a non-empty array")
    for index, item in enumerate(acceptance):
        _text(item, "$.acceptance[%d]" % index)
    _identity(contract["executor"], "$.executor")
    _identity(contract["verifier"], "$.verifier")
    if contract["executor"]["id"] == contract["verifier"]["id"]:
        _fail("$.verifier.id", "must differ from executor.id")
    if "constraints" in contract and not isinstance(contract["constraints"], dict):
        _fail("$.constraints", "must be an object")
    if "evidence" in contract:
        if not isinstance(contract["evidence"], list):
            _fail("$.evidence", "must be an array")
        for index, item in enumerate(contract["evidence"]):
            _text(item, "$.evidence[%d]" % index)
    return contract


def canonicalize(contract):
    validate(contract)
    return json.dumps(contract, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)


def digest(contract):
    return hashlib.sha256(canonicalize(contract).encode("utf-8")).hexdigest()
