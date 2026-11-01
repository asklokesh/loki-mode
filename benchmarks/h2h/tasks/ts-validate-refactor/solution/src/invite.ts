import { ValidationError, validateEmail, validateUsername } from "./validate";

export interface Invite {
  from: string;
  to: string;
}

/** An invite from an existing user to an email address. */
export function createInvite(fromUsername: string, toEmail: string): Invite {
  return { from: validateUsername(fromUsername), to: validateEmail(toEmail) };
}

/** Invites several addresses at once: normalized, duplicates dropped, first-seen order kept. */
export function inviteMany(fromUsername: string, emails: string[]): Invite[] {
  const from = validateUsername(fromUsername);
  const seen = new Set<string>();
  const out: Invite[] = [];
  for (const raw of emails) {
    const to = validateEmail(raw);
    if (seen.has(to)) continue;
    seen.add(to);
    out.push({ from, to });
  }
  if (out.length === 0) throw new ValidationError("at least one email is required");
  return out;
}
