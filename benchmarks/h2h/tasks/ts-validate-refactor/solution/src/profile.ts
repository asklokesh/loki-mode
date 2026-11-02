import { ValidationError, validateEmail, validateUsername } from "./validate";

export interface Profile {
  email: string;
  username: string;
  bio: string;
}

export interface ProfileChanges {
  email?: string;
  username?: string;
  bio?: string;
}

/** Applies changes to a profile. Only the fields present in `changes` are validated. */
export function updateProfile(current: Profile, changes: ProfileChanges): Profile {
  const next: Profile = { ...current };
  if (changes.email !== undefined) next.email = validateEmail(changes.email);
  if (changes.username !== undefined) next.username = validateUsername(changes.username);
  if (changes.bio !== undefined) {
    if (changes.bio.length > 160) throw new ValidationError("bio must be at most 160 characters");
    next.bio = changes.bio;
  }
  return next;
}
