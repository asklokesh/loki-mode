// Control-plane tests are hermetic about verification keys: the shared preload points LOKI_RECEIPT_SIGNING_KEY_FILE at a temp path and a developer
// or CI shell may export real key variables. Scrub them so each test sets exactly the keys it means to use.
for (const k of ["LOKI_RECEIPT_SIGNING_KEY", "LOKI_RECEIPT_SIGNING_KEY_FILE", "LOKI_RECEIPT_RETIRED_PUBKEYS", "LOKI_CP_RECEIPT_PUBKEYS"]) delete process.env[k];
