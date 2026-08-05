#!/usr/bin/env python3
"""Bind an immutable specification to a structured requirement verdict schema."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import stat
import sys
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path


PRODUCT_QUALITY_CONTRACT_END = "--- END AUTONOMI PRODUCT QUALITY CONTRACT ---"
PRODUCT_QUALITY_REQUIREMENT_PREFIXES = (
    "Every visible control must perform its stated action.",
    "Do not ship dead forms,",
    "If the user explicitly requests no backend,",
    "Treat commercial claims as user-supplied,",
    "Label illustrative material in the interface and omit unsupported customer logos,",
    "Add or update at least one non-vacuous automated test for the critical path,",
)


@dataclass(frozen=True)
class Contract:
    specification: bytes
    manifest: dict[str, object]
    schema: dict[str, object]

    @property
    def manifest_bytes(self) -> bytes:
        return json.dumps(self.manifest, sort_keys=True).encode("utf-8")

    @property
    def schema_bytes(self) -> bytes:
        return json.dumps(self.schema, sort_keys=True).encode("utf-8")


MAX_REQUIREMENTS_PER_SHARD = 8


def _shard_path(shard_dir: Path, kind: str, index: int) -> Path:
    if kind not in {"manifest", "schema", "result"} or index < 1:
        raise ValueError("invalid_shard")
    suffix = "json" if kind in {"manifest", "schema"} else "txt"
    return shard_dir / f"{kind}-{index:03d}.{suffix}"


def _validate_shard_size(raw_size: str | int) -> int:
    text = str(raw_size)
    if re.fullmatch(r"[0-9]+", text) is None:
        raise ValueError("invalid_shard_size")
    size = int(text, 10)
    if not 1 <= size <= MAX_REQUIREMENTS_PER_SHARD:
        raise ValueError("invalid_shard_size")
    return size


def _safe_directory(path: Path) -> None:
    try:
        info = os.lstat(path)
    except OSError as exc:
        raise RuntimeError("unsafe_shard_directory") from exc
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) != 0o700
    ):
        raise RuntimeError("unsafe_shard_directory")


def extract_requirement_units(text: str) -> list[str]:
    """Return deterministic acceptance units without interpreting product verbs."""
    units: list[str] = []
    paragraph: list[str] = []
    list_item: list[str] = []

    def flush_paragraph() -> None:
        if not paragraph:
            return
        joined = " ".join(paragraph)
        units.extend(
            part.strip()
            for part in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", joined)
            if part.strip()
        )
        paragraph.clear()

    def flush_item() -> None:
        if list_item:
            units.append(" ".join(list_item))
            list_item.clear()

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            flush_item()
            flush_paragraph()
            continue
        heading = re.fullmatch(r"#{1,6}\s+(.+)", line)
        if heading:
            flush_item()
            flush_paragraph()
            units.append(heading.group(1).strip())
            continue
        item = re.match(
            r"^(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+)$", line
        )
        if item:
            flush_item()
            flush_paragraph()
            list_item.append(item.group(1).strip())
        elif list_item and raw_line[:1].isspace():
            list_item.append(line)
        else:
            flush_item()
            paragraph.append(line)
    flush_item()
    flush_paragraph()
    return units


def extract_bound_requirement_units(text: str) -> list[str]:
    """Extract the user brief when a platform quality policy precedes it."""
    if PRODUCT_QUALITY_CONTRACT_END in text:
        text = text.split(PRODUCT_QUALITY_CONTRACT_END, 1)[1].strip()
    return extract_requirement_units(text)


def extract_product_quality_requirement_units(text: str) -> list[str]:
    """Select the mandatory review rules from a wrapped product quality policy."""
    if PRODUCT_QUALITY_CONTRACT_END not in text:
        return []
    policy = text.split(PRODUCT_QUALITY_CONTRACT_END, 1)[0]
    units = extract_requirement_units(policy)
    selected: list[str] = []
    for prefix in PRODUCT_QUALITY_REQUIREMENT_PREFIXES:
        matches = [unit for unit in units if unit.startswith(prefix)]
        if len(matches) != 1:
            raise LookupError("incomplete_product_quality_contract")
        selected.append(matches[0])
    return selected


def _schema(spec_sha256: str, ids: list[str], count: int) -> dict[str, object]:
    return {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "additionalProperties": False,
        "required": [
            "schema",
            "spec_sha256",
            "verdict",
            "requirements",
            "findings",
        ],
        "properties": {
            "schema": {"const": "loki-requirements-verdict/v1"},
            "spec_sha256": {"const": spec_sha256},
            "verdict": {"enum": ["PASS", "FAIL"]},
            "requirements": {
                "type": "array",
                "minItems": count,
                "maxItems": count,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["id", "status", "evidence"],
                    "properties": {
                        "id": {"enum": ids},
                        "status": {"enum": ["PASS", "FAIL"]},
                        "evidence": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 180,
                        },
                    },
                },
            },
            "findings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["severity", "description"],
                    "properties": {
                        "severity": {
                            "enum": ["Critical", "High", "Medium", "Low"]
                        },
                        "description": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 320,
                        },
                    },
                },
            },
        },
    }


def _limit(raw_limit: str, hard_limit: int) -> int:
    if re.fullmatch(r"[0-9]+", raw_limit) is None:
        raise ValueError("invalid_limit")
    limit = int(raw_limit, 10)
    if not 1 <= limit <= hard_limit:
        raise ValueError("invalid_limit")
    return limit


def _read_regular(
    path: Path, maximum: int, *, exact_mode: int | None = None
) -> bytes:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    try:
        descriptor = os.open(path, flags)
        info = os.fstat(descriptor)
        path_info = os.lstat(path)
        if (
            not stat.S_ISREG(info.st_mode)
            or not stat.S_ISREG(path_info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_nlink != 1
            or (
                exact_mode is not None
                and stat.S_IMODE(info.st_mode) != exact_mode
            )
            or (info.st_dev, info.st_ino) != (path_info.st_dev, path_info.st_ino)
        ):
            raise RuntimeError("unsafe_file")
        content = bytearray()
        while len(content) <= maximum:
            chunk = os.read(descriptor, min(65_536, maximum + 1 - len(content)))
            if not chunk:
                break
            content.extend(chunk)
        final_info = os.fstat(descriptor)
        final_path_info = os.lstat(path)
        if (
            (info.st_dev, info.st_ino) != (final_info.st_dev, final_info.st_ino)
            or (info.st_dev, info.st_ino)
            != (final_path_info.st_dev, final_path_info.st_ino)
        ):
            raise RuntimeError("replaced_file")
    except OSError as exc:
        raise RuntimeError("unreadable") from exc
    finally:
        if "descriptor" in locals():
            os.close(descriptor)
    if len(content) > maximum:
        raise OverflowError(f"oversized:{len(content)}")
    return bytes(content)


def _path_identity(path: Path, *, exact_mode: int = 0o600) -> str:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    try:
        descriptor = os.open(path, flags)
        info = os.fstat(descriptor)
        path_info = os.lstat(path)
    except OSError as exc:
        raise RuntimeError("unreadable") from exc
    finally:
        if "descriptor" in locals():
            os.close(descriptor)
    if (
        not stat.S_ISREG(info.st_mode)
        or not stat.S_ISREG(path_info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != exact_mode
        or (info.st_dev, info.st_ino) != (path_info.st_dev, path_info.st_ino)
    ):
        raise RuntimeError("unsafe_file")
    return f"{info.st_dev}:{info.st_ino}"


def artifact_identity(*paths: Path) -> str:
    return ",".join(_path_identity(path) for path in paths)


def _write_new(path: Path, content: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    try:
        descriptor = os.open(path, flags, 0o600)
        os.fchmod(descriptor, 0o600)
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("short write")
            view = view[written:]
        info = os.fstat(descriptor)
        path_info = os.lstat(path)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_nlink != 1
            or (info.st_dev, info.st_ino) != (path_info.st_dev, path_info.st_ino)
        ):
            raise RuntimeError("unsafe_file")
    except FileExistsError:
        if not hmac.compare_digest(
            _read_regular(path, len(content), exact_mode=0o600), content
        ):
            raise RuntimeError("contract_mismatch")
        return
    except OSError as exc:
        raise RuntimeError("contract_write_failed") from exc
    finally:
        if "descriptor" in locals():
            os.close(descriptor)


def publish_bound(stage: Path, destination: Path, maximum: int) -> str:
    """Publish one validated staged result after its producer has quiesced."""
    content = _read_regular(stage, maximum)
    if not content:
        raise RuntimeError("empty_file")
    try:
        destination_info = os.lstat(destination)
    except FileNotFoundError:
        destination_info = None
    if destination_info is not None:
        if stat.S_ISDIR(destination_info.st_mode):
            raise RuntimeError("unsafe_destination")
        os.unlink(destination)
    os.replace(stage, destination)
    published = _read_regular(destination, maximum)
    if not hmac.compare_digest(content, published):
        raise RuntimeError("publish_mismatch")
    return (
        hashlib.sha256(published).hexdigest()
        + "|"
        + _path_identity(destination)
    )


def derive_contract(
    source: Path,
    expected_sha256: str,
    raw_limit: str,
    hard_limit: int,
) -> Contract:
    limit = _limit(raw_limit, hard_limit)
    content = _read_regular(source, limit)
    actual_sha256 = hashlib.sha256(content).hexdigest()
    if not hmac.compare_digest(actual_sha256, expected_sha256):
        raise PermissionError("hash_mismatch")
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise UnicodeError("invalid_utf8") from exc
    units = extract_bound_requirement_units(text)
    quality_units = extract_product_quality_requirement_units(text)
    if not units:
        raise LookupError("no_requirements")
    requirements = [
        {
            "id": f"R{index:03d}",
            "text": unit,
            "sha256": hashlib.sha256(unit.encode("utf-8")).hexdigest(),
        }
        for index, unit in enumerate(units, 1)
    ]
    requirements.extend(
        {
            "id": f"Q{index:03d}",
            "text": unit,
            "sha256": hashlib.sha256(unit.encode("utf-8")).hexdigest(),
        }
        for index, unit in enumerate(quality_units, 1)
    )
    manifest = {
        "schema": "loki-requirements-manifest/v1",
        "spec_sha256": actual_sha256,
        "requirements": requirements,
    }
    return Contract(
        specification=content,
        manifest=manifest,
        schema=_schema(
            actual_sha256,
            [item["id"] for item in requirements],
            len(requirements),
        ),
    )


def derive_shards(contract: Contract, raw_size: str | int) -> list[Contract]:
    """Split one verified contract into deterministic balanced contiguous shards."""
    maximum = _validate_shard_size(raw_size)
    requirements = contract.manifest.get("requirements")
    if not isinstance(requirements, list) or not requirements:
        raise RuntimeError("invalid_full_contract")
    total = len(requirements)
    shard_count = (total + maximum - 1) // maximum
    base_size, extra = divmod(total, shard_count)
    full_manifest_sha256 = hashlib.sha256(contract.manifest_bytes).hexdigest()
    shards: list[Contract] = []
    offset = 0
    for zero_index in range(shard_count):
        shard_size = base_size + (1 if zero_index < extra else 0)
        selected = deepcopy(requirements[offset : offset + shard_size])
        ids = [item.get("id") for item in selected if isinstance(item, dict)]
        if len(ids) != shard_size or any(not isinstance(item, str) for item in ids):
            raise RuntimeError("invalid_full_contract")
        manifest = {
            "schema": "loki-requirements-manifest/v1",
            "spec_sha256": contract.manifest["spec_sha256"],
            "requirements": selected,
            "shard": {
                "schema": "loki-requirements-shard/v1",
                "index": zero_index + 1,
                "count": shard_count,
                "max_requirements": maximum,
                "requirement_offset": offset,
                "full_requirement_count": total,
                "full_manifest_sha256": full_manifest_sha256,
            },
        }
        shards.append(
            Contract(
                specification=contract.specification,
                manifest=manifest,
                schema=_schema(contract.manifest["spec_sha256"], ids, shard_size),
            )
        )
        offset += shard_size
    if offset != total:
        raise RuntimeError("incomplete_shards")
    return shards


def write_shards(
    contract: Contract,
    raw_size: str,
    shard_dir: Path,
) -> dict[str, object]:
    _safe_directory(shard_dir)
    shards = derive_shards(contract, raw_size)
    identities: list[str] = []
    sizes: list[int] = []
    for index, shard in enumerate(shards, 1):
        manifest_path = _shard_path(shard_dir, "manifest", index)
        schema_path = _shard_path(shard_dir, "schema", index)
        _write_new(manifest_path, shard.manifest_bytes)
        _write_new(schema_path, shard.schema_bytes)
        identities.append(artifact_identity(manifest_path, schema_path))
        sizes.append(len(shard.manifest["requirements"]))
    return {
        "schema": "loki-requirements-shards/v1",
        "count": len(shards),
        "max_requirements": _validate_shard_size(raw_size),
        "sizes": sizes,
        "identities": identities,
        "full_manifest_sha256": hashlib.sha256(contract.manifest_bytes).hexdigest(),
    }


def verify_shard(
    contract: Contract,
    raw_size: str,
    shard_dir: Path,
    index: int,
    expected_identity: str = "",
) -> Contract:
    _safe_directory(shard_dir)
    shards = derive_shards(contract, raw_size)
    if index < 1 or index > len(shards):
        raise ValueError("invalid_shard")
    shard = shards[index - 1]
    manifest_path = _shard_path(shard_dir, "manifest", index)
    schema_path = _shard_path(shard_dir, "schema", index)
    for path, expected in (
        (manifest_path, shard.manifest_bytes),
        (schema_path, shard.schema_bytes),
    ):
        actual = _read_regular(path, len(expected), exact_mode=0o600)
        if not hmac.compare_digest(actual, expected):
            raise RuntimeError("shard_contract_mismatch")
    actual_identity = artifact_identity(manifest_path, schema_path)
    if expected_identity and not hmac.compare_digest(
        actual_identity, expected_identity
    ):
        raise RuntimeError("shard_contract_replaced")
    return shard


def _decode_json_list(raw: str, expected_count: int) -> list[str]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("invalid_binding_list") from exc
    if (
        not isinstance(value, list)
        or len(value) != expected_count
        or not all(isinstance(item, str) and item for item in value)
    ):
        raise ValueError("invalid_binding_list")
    return value


def _read_bound_result(path: Path, binding: str, maximum: int) -> bytes:
    try:
        expected_sha256, expected_identity = binding.split("|", 1)
    except ValueError as exc:
        raise ValueError("invalid_result_binding") from exc
    if re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is None:
        raise ValueError("invalid_result_binding")
    content = _read_regular(path, maximum, exact_mode=0o600)
    if not hmac.compare_digest(hashlib.sha256(content).hexdigest(), expected_sha256):
        raise RuntimeError("result_mismatch")
    if not hmac.compare_digest(_path_identity(path), expected_identity):
        raise RuntimeError("result_replaced")
    return content


def _parse_legacy_result(content: bytes) -> tuple[str, list[str]]:
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("invalid_result") from exc
    lines = text.splitlines()
    if (
        len(lines) < 3
        or lines[0] not in {"VERDICT: PASS", "VERDICT: FAIL"}
        or lines[1] != "FINDINGS:"
        or any(not line.startswith("- ") or len(line) <= 2 for line in lines[2:])
    ):
        raise ValueError("invalid_result")
    findings = lines[2:]
    if "- None" in findings and findings != ["- None"]:
        raise ValueError("invalid_result")
    verdict = lines[0].removeprefix("VERDICT: ")
    if verdict == "PASS" and findings != ["- None"]:
        raise ValueError("invalid_result")
    return verdict, findings


def synthesize_shards(
    contract: Contract,
    raw_size: str,
    shard_dir: Path,
    contract_identities_json: str,
    result_bindings_json: str,
    maximum: int,
    destination: Path,
) -> str:
    """Create one logical verdict only after every exact shard result is bound."""
    shards = derive_shards(contract, raw_size)
    contract_identities = _decode_json_list(
        contract_identities_json, len(shards)
    )
    result_bindings = _decode_json_list(result_bindings_json, len(shards))
    verdicts: list[str] = []
    findings: list[str] = []
    for index, (contract_identity, result_binding) in enumerate(
        zip(contract_identities, result_bindings, strict=True), 1
    ):
        verify_shard(contract, raw_size, shard_dir, index, contract_identity)
        result_path = _shard_path(shard_dir, "result", index)
        verdict, shard_findings = _parse_legacy_result(
            _read_bound_result(result_path, result_binding, maximum)
        )
        verdicts.append(verdict)
        if shard_findings != ["- None"]:
            findings.extend(shard_findings)
    logical_verdict = "PASS" if all(item == "PASS" for item in verdicts) else "FAIL"
    logical_findings = findings or ["- None"]
    logical = (
        "VERDICT: "
        + logical_verdict
        + "\nFINDINGS:\n"
        + "\n".join(logical_findings)
        + "\n"
    ).encode("utf-8")
    _write_new(destination, logical)
    return hashlib.sha256(logical).hexdigest() + "|" + _path_identity(destination)


def synthesize_failed_shard(
    contract: Contract,
    raw_size: str,
    shard_dir: Path,
    index: int,
    contract_identity: str,
    result_binding: str,
    maximum: int,
    destination: Path,
) -> str:
    """Publish one exact valid FAIL without waiting for irrelevant PASS shards."""
    verify_shard(contract, raw_size, shard_dir, index, contract_identity)
    content = _read_bound_result(
        _shard_path(shard_dir, "result", index), result_binding, maximum
    )
    verdict, _ = _parse_legacy_result(content)
    if verdict != "FAIL":
        raise RuntimeError("shard_did_not_fail")
    _write_new(destination, content)
    return hashlib.sha256(content).hexdigest() + "|" + _path_identity(destination)


def verify_contract(
    source: Path,
    snapshot: Path,
    expected_sha256: str,
    raw_limit: str,
    hard_limit: int,
    manifest_path: Path,
    schema_path: Path,
    expected_identity: str = "",
) -> Contract:
    contract = derive_contract(source, expected_sha256, raw_limit, hard_limit)
    for path, expected in (
        (snapshot, contract.specification),
        (manifest_path, contract.manifest_bytes),
        (schema_path, contract.schema_bytes),
    ):
        actual = _read_regular(path, len(expected), exact_mode=0o600)
        if not hmac.compare_digest(actual, expected):
            raise RuntimeError("contract_mismatch")
    actual_identity = artifact_identity(snapshot, manifest_path, schema_path)
    if expected_identity and not hmac.compare_digest(
        actual_identity, expected_identity
    ):
        raise RuntimeError("contract_replaced")
    return contract


def write_contract(
    source: Path,
    snapshot: Path,
    expected_sha256: str,
    raw_limit: str,
    hard_limit: int,
    manifest_path: Path,
    schema_path: Path,
) -> str:
    contract = derive_contract(source, expected_sha256, raw_limit, hard_limit)
    try:
        _write_new(snapshot, contract.specification)
        _write_new(manifest_path, contract.manifest_bytes)
        _write_new(schema_path, contract.schema_bytes)
    except RuntimeError:
        raise
    return f"ok:{len(contract.specification)}"


def _emit(contract: Contract, kind: str) -> None:
    if kind == "snapshot":
        sys.stdout.buffer.write(contract.specification)
    elif kind == "manifest":
        sys.stdout.buffer.write(contract.manifest_bytes)
    elif kind == "schema":
        sys.stdout.buffer.write(contract.schema_bytes)
    elif kind == "prompt":
        sys.stdout.write(
            json.dumps(
                {
                    "manifest": contract.manifest,
                    "schema": contract.schema,
                    "specification": contract.specification.decode("utf-8"),
                },
                sort_keys=True,
            )
        )
    elif kind != "none":
        raise ValueError("invalid_emit")


def main(argv: list[str]) -> int:
    try:
        if len(argv) == 5 and argv[1] == "publish-bound":
            maximum = _limit(argv[4], int(argv[4]))
            sys.stdout.write(
                publish_bound(Path(argv[2]), Path(argv[3]), maximum)
            )
        elif len(argv) in (10, 11) and argv[1] == "verify":
            contract = verify_contract(
                Path(argv[2]),
                Path(argv[3]),
                argv[4],
                argv[5],
                int(argv[6]),
                Path(argv[7]),
                Path(argv[8]),
                argv[10] if len(argv) == 11 else "",
            )
            _emit(contract, argv[9])
        elif len(argv) == 9 and argv[1] == "bind":
            verify_contract(
                Path(argv[2]),
                Path(argv[3]),
                argv[4],
                argv[5],
                int(argv[6]),
                Path(argv[7]),
                Path(argv[8]),
            )
            sys.stdout.write(
                artifact_identity(Path(argv[3]), Path(argv[7]), Path(argv[8]))
            )
        elif len(argv) in (5, 6) and argv[1] == "read-bound":
            maximum = _limit(argv[4], int(argv[4]))
            content = _read_regular(Path(argv[2]), maximum, exact_mode=0o600)
            if not hmac.compare_digest(hashlib.sha256(content).hexdigest(), argv[3]):
                raise PermissionError("hash_mismatch")
            if len(argv) == 6 and not hmac.compare_digest(
                _path_identity(Path(argv[2])), argv[5]
            ):
                raise RuntimeError("replaced_file")
            sys.stdout.buffer.write(content)
        elif len(argv) == 12 and argv[1] == "write-shards":
            contract = verify_contract(
                Path(argv[2]),
                Path(argv[3]),
                argv[4],
                argv[5],
                int(argv[6]),
                Path(argv[7]),
                Path(argv[8]),
                argv[9],
            )
            sys.stdout.write(
                json.dumps(
                    write_shards(contract, argv[10], Path(argv[11])),
                    sort_keys=True,
                )
            )
        elif len(argv) == 15 and argv[1] == "verify-shard":
            contract = verify_contract(
                Path(argv[2]),
                Path(argv[3]),
                argv[4],
                argv[5],
                int(argv[6]),
                Path(argv[7]),
                Path(argv[8]),
                argv[9],
            )
            shard = verify_shard(
                contract,
                argv[10],
                Path(argv[11]),
                int(argv[12]),
                argv[14],
            )
            _emit(shard, argv[13])
        elif len(argv) == 16 and argv[1] == "synthesize-shards":
            contract = verify_contract(
                Path(argv[2]),
                Path(argv[3]),
                argv[4],
                argv[5],
                int(argv[6]),
                Path(argv[7]),
                Path(argv[8]),
                argv[9],
            )
            maximum = _limit(argv[14], int(argv[14]))
            sys.stdout.write(
                synthesize_shards(
                    contract,
                    argv[10],
                    Path(argv[11]),
                    argv[12],
                    argv[13],
                    maximum,
                    Path(argv[15]),
                )
            )
        elif len(argv) == 17 and argv[1] == "synthesize-fail":
            contract = verify_contract(
                Path(argv[2]),
                Path(argv[3]),
                argv[4],
                argv[5],
                int(argv[6]),
                Path(argv[7]),
                Path(argv[8]),
                argv[9],
            )
            maximum = _limit(argv[15], int(argv[15]))
            sys.stdout.write(
                synthesize_failed_shard(
                    contract,
                    argv[10],
                    Path(argv[11]),
                    int(argv[12]),
                    argv[13],
                    argv[14],
                    maximum,
                    Path(argv[16]),
                )
            )
        elif len(argv) == 8:
            print(
                write_contract(
                    Path(argv[1]),
                    Path(argv[2]),
                    argv[3],
                    argv[4],
                    int(argv[5]),
                    Path(argv[6]),
                    Path(argv[7]),
                )
            )
        else:
            return 9
        return 0
    except OverflowError as exc:
        print(str(exc))
        return 4
    except PermissionError:
        print("hash_mismatch")
        return 5
    except UnicodeError as exc:
        print(str(exc))
        return 9
    except ValueError:
        print("invalid_limit")
        return 2
    except (OSError, RuntimeError, LookupError) as exc:
        print(str(exc))
        return 9


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
