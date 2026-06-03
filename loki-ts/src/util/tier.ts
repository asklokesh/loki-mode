// R9 open-core tier/license seam (Bun parity for bash loki_tier_gate).
//
// OSS-FIRST CONTRACT: this is a no-op ALLOW for OSS users. LOKI_TIER defaults
// to "oss" and every existing free feature stays fully free. tierGate() is the
// single place where a future hosted/enterprise build would gate a hosted-only
// capability. It is NEVER called from any existing free command path; its only
// caller is the opt-in --hosted publish seam. For OSS (the default), it always
// returns { allowed: true }.
//
// We never fabricate a successful license verification: the hosted backend and
// license-verification service do not exist yet, so a non-OSS tier is an honest
// SEAM, documented in docs/OPEN-CORE-BOUNDARY.md.

import { YELLOW, NC } from "./colors.ts";

export interface TierGateResult {
  allowed: boolean;
  // Non-fatal diagnostic lines a caller may print to stderr. Empty for OSS.
  notes: string[];
}

export function currentTier(): string {
  return process.env["LOKI_TIER"] || "oss";
}

// tierGate - decide whether `capability` is permitted for the current tier.
// OSS (default): always allowed, no notes, no network, no license. Non-OSS:
// an honest seam (no verification backend yet) -- never a fabricated grant.
export function tierGate(capability: string): TierGateResult {
  const tier = currentTier();

  // OSS tier: everything is allowed, always.
  if (tier === "oss") {
    return { allowed: true, notes: [] };
  }

  const licenseKey = process.env["LOKI_LICENSE_KEY"] || "";

  // Non-OSS tier with no license key: cannot verify an entitlement. Be honest;
  // do not pretend to grant a paid capability.
  if (!licenseKey) {
    return {
      allowed: false,
      notes: [
        `${YELLOW}LOKI_TIER='${tier}' requested but no LOKI_LICENSE_KEY set.${NC}`,
        `Hosted/enterprise license verification is not available yet (capability: ${capability}).`,
        "OSS users: leave LOKI_TIER unset (or 'oss') -- everything stays free.",
      ],
    };
  }

  // A license key is present but there is no verification backend yet. We do
  // NOT fabricate a successful verification. We allow (OSS-equivalent) and note
  // the seam is unimplemented.
  return {
    allowed: true,
    notes: [
      `${YELLOW}LOKI_LICENSE_KEY set but the verification backend is not available yet (R9 seam).${NC}`,
    ],
  };
}
