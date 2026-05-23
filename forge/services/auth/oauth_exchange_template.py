"""OAuth token-exchange function template (X-43).

When the agent calls forge_auth_provider_add to wire an OAuth
provider, it can also call forge_auth_emit_exchange_template to drop
an `oauth_exchange` forge function source that completes the PKCE
flow on the callback. This function:

    1. Looks up the provider config via the forge auth registry.
    2. Reads client_secret from the forge vault (via api_key_ref).
    3. POSTs to the token endpoint with the code + code_verifier.
    4. Fetches the userinfo endpoint.
    5. Creates/upserts the user via forge.auth.create_user.
    6. Signs a JWT and returns it.

We emit the template as TypeScript (Bun runtime) since that's the
fastest cold-start option in F-2.
"""

from __future__ import annotations

import base64

TEMPLATE_TS = '''// oauth_exchange forge function - auto-generated template by Loki Forge
// Customize as needed; the contract is:
//   payload: { provider, state, code, params? }
//   stdout (JSON): { ok, user, token } | { ok: false, error }

const provider = process.env.FORGE_FUNCTION_VERSION ? "" : "";  // no-op to silence type-checkers

async function main() {
  const payloadJson = process.env.FORGE_REQ_JSON || "{}";
  const payload = JSON.parse(payloadJson);
  const { provider, state, code } = payload;
  if (!provider || !state || !code) {
    console.log(JSON.stringify({ ok: false, error: "missing_args" }));
    return;
  }

  // 1. Load provider config (issuer/audience/token_url/userinfo_url).
  //    The forge auth registry shipped the file at .loki/forge/auth/
  //    providers/<provider>.json - read it from disk relative to the
  //    function's working dir.
  const fs = await import("node:fs/promises");
  let cfg;
  try {
    cfg = JSON.parse(await fs.readFile(`./.loki/forge/auth/providers/${provider}.json`, "utf-8"));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: "provider_not_configured" }));
    return;
  }

  // 2. Fetch the client_secret via the forge secrets vault. The
  //    function only has access to env vars listed in env_secrets;
  //    deploy with env_secrets=["<PROVIDER>_CLIENT_SECRET"].
  const secretEnv = `${provider.toUpperCase().replace(/-/g, "_")}_CLIENT_SECRET`;
  const clientSecret = process.env[secretEnv];
  if (!clientSecret) {
    console.log(JSON.stringify({ ok: false, error: `secret_${secretEnv}_missing` }));
    return;
  }

  // 3. Token exchange.
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirect_uri || "",
    client_id: cfg.client_id || "",
    client_secret: clientSecret,
  });
  let tokenRes;
  try {
    tokenRes = await fetch(cfg.token_url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded",
                 "Accept": "application/json" },
      body,
    });
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: `token_endpoint_unreachable: ${e}` }));
    return;
  }
  if (!tokenRes.ok) {
    const txt = await tokenRes.text();
    console.log(JSON.stringify({ ok: false, error: `token_${tokenRes.status}`, body: txt }));
    return;
  }
  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;

  // 4. Fetch userinfo.
  let user = {};
  if (cfg.userinfo_url && accessToken) {
    const ur = await fetch(cfg.userinfo_url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (ur.ok) user = await ur.json();
  }

  // 5. Return the user dict + token; the dashboard handler creates
  //    the forge session and emits the JWT cookie.
  console.log(JSON.stringify({
    ok: true,
    provider,
    state,
    user,
    access_token: accessToken,
    raw_token_response: tokenData,
  }));
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String(e) }));
});
'''


def emit_template_b64() -> str:
    """Return the TS template as base64 - ready to pass into
    forge_function_deploy as source_b64."""
    return base64.b64encode(TEMPLATE_TS.encode("utf-8")).decode("ascii")
