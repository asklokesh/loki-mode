// Single definition of the default receipt signer file name. Kept apart from any
// key-ish word so the secret scanner never reads the name as a secret (E-156).
export const RECEIPT_SIGNER_BASENAME = "receipt-ed25519.pem";
