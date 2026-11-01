class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export interface Invite {
  from: string;
  to: string;
}

function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email.length === 0) throw new ValidationError("email is required");
  if (email.length > 254) throw new ValidationError("email is too long");
  const ok = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email);
  if (!ok) throw new ValidationError("email is invalid");
  return email;
}

function normalizeUsername(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) throw new ValidationError("username is required");
  if (name.length < 3 || name.length > 20) {
    throw new ValidationError("username must be 3 to 20 characters");
  }
  if ("0123456789".includes(name.charAt(0))) {
    throw new ValidationError("username must not start with a digit");
  }
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new ValidationError("username may only contain a-z, 0-9 and _");
  }
  return name;
}

/** An invite from an existing user to an email address. */
export function createInvite(fromUsername: string, toEmail: string): Invite {
  return { from: normalizeUsername(fromUsername), to: normalizeEmail(toEmail) };
}

/** Invites several addresses at once: normalized, duplicates dropped, first-seen order kept. */
export function inviteMany(fromUsername: string, emails: string[]): Invite[] {
  const from = normalizeUsername(fromUsername);
  const seen = new Set<string>();
  const out: Invite[] = [];
  for (const raw of emails) {
    const to = normalizeEmail(raw);
    if (seen.has(to)) continue;
    seen.add(to);
    out.push({ from, to });
  }
  if (out.length === 0) throw new ValidationError("at least one email is required");
  return out;
}
