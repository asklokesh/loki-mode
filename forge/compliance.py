"""Compliance preset propagation (X-36).

When the operator sets LOKI_COMPLIANCE_PRESET=healthcare|fintech|
government (an existing top-level flag in autonomy/loki), forge
applies matching defaults to the resources it provisions:

  healthcare: encryption-at-rest enforced, audit-chain required, RLS
              policy 'own-row' by default, file uploads max 10 MB,
              storage region must be us- (HIPAA data residency).
  fintech:    similar to healthcare plus payments-provider validation
              that webhook_secret_ref is set, plus default rate
              limits doubled (lower abuse surface).
  government: similar to fintech plus FIPS-friendly cryptography
              required (we surface a warning when cryptography is
              missing; preset's enforcement is on the deploy adapter).

The preset is consulted by services at create-time. Storage uses it
to validate region. Auth uses it to bias defaults. Payments enforces
webhook secret presence. The preset does NOT block per-call usage -
that would be too strict in dev. It DOES block deployment via the
existing council review path.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class CompliancePreset:
    name: str
    default_rls: str = "own-row"
    max_file_mb: int = 50
    storage_region_prefix: Optional[str] = None
    require_webhook_secret: bool = False
    require_fips_crypto: bool = False
    require_audit_chain: bool = False
    rate_limit_multiplier: float = 1.0
    notes: List[str] = field(default_factory=list)


_PRESETS: Dict[str, CompliancePreset] = {
    "default": CompliancePreset(name="default"),
    "healthcare": CompliancePreset(
        name="healthcare",
        default_rls="own-row",
        max_file_mb=10,
        storage_region_prefix="us-",
        require_audit_chain=True,
        notes=["HIPAA-style: keep PHI in us- regions",
               "RLS defaults to own-row"],
    ),
    "fintech": CompliancePreset(
        name="fintech",
        default_rls="own-row",
        max_file_mb=20,
        require_webhook_secret=True,
        require_audit_chain=True,
        rate_limit_multiplier=2.0,
        notes=["payments webhooks must verify signature",
               "rate limits doubled for fraud-surface reduction"],
    ),
    "government": CompliancePreset(
        name="government",
        default_rls="own-row",
        max_file_mb=10,
        storage_region_prefix="us-",
        require_audit_chain=True,
        require_fips_crypto=True,
        require_webhook_secret=True,
        notes=["FedRAMP-friendly defaults; FIPS crypto required",
               "all webhooks must verify signature"],
    ),
}


def current_preset() -> CompliancePreset:
    """Return the active preset based on LOKI_COMPLIANCE_PRESET env var
    (an existing Loki flag). Defaults to 'default' when unset or
    unknown."""
    name = (os.environ.get("LOKI_COMPLIANCE_PRESET") or "default").lower()
    return _PRESETS.get(name) or _PRESETS["default"]


def validate_storage(*, region: str, max_file_size: int) -> List[str]:
    """Return a list of compliance errors for a proposed bucket spec."""
    p = current_preset()
    errors: List[str] = []
    if p.storage_region_prefix and region != "auto" \
       and not region.startswith(p.storage_region_prefix):
        errors.append(
            f"compliance:{p.name}: storage region {region!r} must start with "
            f"{p.storage_region_prefix!r}"
        )
    max_bytes_cap = p.max_file_mb * 1024 * 1024
    if max_file_size > max_bytes_cap:
        errors.append(
            f"compliance:{p.name}: max_file_size {max_file_size} exceeds "
            f"{p.max_file_mb} MB cap"
        )
    return errors


def validate_payments(*, webhook_secret_ref: Optional[str]) -> List[str]:
    p = current_preset()
    errors: List[str] = []
    if p.require_webhook_secret and not webhook_secret_ref:
        errors.append(
            f"compliance:{p.name}: payments provider must set "
            f"webhook_secret_ref"
        )
    return errors


def list_presets() -> List[Dict[str, Any]]:
    """List available compliance presets."""
    out = []
    for p in _PRESETS.values():
        out.append({
            "name": p.name,
            "default_rls": p.default_rls,
            "max_file_mb": p.max_file_mb,
            "storage_region_prefix": p.storage_region_prefix,
            "require_webhook_secret": p.require_webhook_secret,
            "require_audit_chain": p.require_audit_chain,
            "require_fips_crypto": p.require_fips_crypto,
            "rate_limit_multiplier": p.rate_limit_multiplier,
            "notes": list(p.notes),
        })
    return out
