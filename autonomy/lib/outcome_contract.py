"""Pure-stdlib validation and deterministic identity for Outcome Contract v0.1."""

import hashlib
import json

SCHEMA = "autonomi-outcome-contract/v0.1"
KINDS = {"human", "agent", "service", "organization"}
TOP_KEYS = {"schema", "id", "intent", "acceptance", "executor", "verifier",
            "constraints", "evidence", "risk", "budget", "deployment",
            "rollback", "dispute"}


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


def _object(value, path, required, allowed):
    if not isinstance(value, dict):
        _fail(path, "must be an object")
    extra = sorted(set(value) - set(allowed))
    if extra:
        _fail(path + "." + extra[0], "unknown property")
    for key in required:
        if key not in value:
            _fail(path + "." + key, "is required")


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
    if "risk" in contract:
        value = contract["risk"]
        _object(value, "$.risk", ("level",), ("level", "notes"))
        if value["level"] not in {"low", "medium", "high", "critical"}:
            _fail("$.risk.level", "must be one of: low, medium, high, critical")
        if "notes" in value:
            _text(value["notes"], "$.risk.notes")
    if "budget" in contract:
        value = contract["budget"]
        _object(value, "$.budget", ("max_amount", "currency"),
                ("max_amount", "currency"))
        if isinstance(value["max_amount"], bool) or not isinstance(
                value["max_amount"], (int, float)) or value["max_amount"] < 0:
            _fail("$.budget.max_amount", "must be a non-negative number")
        _text(value["currency"], "$.budget.currency")
    if "deployment" in contract:
        value = contract["deployment"]
        _object(value, "$.deployment", ("environment", "approval_required"),
                ("environment", "approval_required"))
        _text(value["environment"], "$.deployment.environment")
        if not isinstance(value["approval_required"], bool):
            _fail("$.deployment.approval_required", "must be a boolean")
    if "rollback" in contract:
        value = contract["rollback"]
        _object(value, "$.rollback", ("required", "strategy"),
                ("required", "strategy"))
        if not isinstance(value["required"], bool):
            _fail("$.rollback.required", "must be a boolean")
        _text(value["strategy"], "$.rollback.strategy")
    if "dispute" in contract:
        value = contract["dispute"]
        _object(value, "$.dispute", ("process",), ("process", "arbiter"))
        _text(value["process"], "$.dispute.process")
        if "arbiter" in value:
            _identity(value["arbiter"], "$.dispute.arbiter")
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
