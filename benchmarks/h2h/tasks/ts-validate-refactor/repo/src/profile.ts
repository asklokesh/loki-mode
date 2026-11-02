class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

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

  if (changes.email !== undefined) {
    const value = changes.email.trim().toLowerCase();
    if (!value) throw new ValidationError("email is required");
    if (value.length > 254) throw new ValidationError("email is too long");
    if (value.match(/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/) === null) {
      throw new ValidationError("email is invalid");
    }
    next.email = value;
  }

  if (changes.username !== undefined) {
    const value = changes.username.trim();
    if (!value) throw new ValidationError("username is required");
    if (value.length < 3 || value.length > 20) {
      throw new ValidationError("username must be 3 to 20 characters");
    }
    if (value[0] >= "0" && value[0] <= "9") {
      throw new ValidationError("username must not start with a digit");
    }
    if (value.match(/^[a-z0-9_]+$/) === null) {
      throw new ValidationError("username may only contain a-z, 0-9 and _");
    }
    next.username = value;
  }

  if (changes.bio !== undefined) {
    if (changes.bio.length > 160) throw new ValidationError("bio must be at most 160 characters");
    next.bio = changes.bio;
  }

  return next;
}
