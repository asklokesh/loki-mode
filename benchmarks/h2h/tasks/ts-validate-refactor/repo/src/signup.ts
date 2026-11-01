class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export interface SignupInput {
  email: string;
  username: string;
  password: string;
}

export interface Account {
  email: string;
  username: string;
}

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const USERNAME_RE = /^[a-z0-9_]+$/;

function checkEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email === "") throw new ValidationError("email is required");
  if (email.length > 254) throw new ValidationError("email is too long");
  if (!EMAIL_RE.test(email)) throw new ValidationError("email is invalid");
  return email;
}

function checkUsername(raw: string): string {
  const name = raw.trim();
  if (name === "") throw new ValidationError("username is required");
  if (name.length < 3 || name.length > 20) {
    throw new ValidationError("username must be 3 to 20 characters");
  }
  if (/^[0-9]/.test(name)) throw new ValidationError("username must not start with a digit");
  if (!USERNAME_RE.test(name)) {
    throw new ValidationError("username may only contain a-z, 0-9 and _");
  }
  return name;
}

/** Validates a new account. Returns the normalized email and username. */
export function signup(input: SignupInput): Account {
  const email = checkEmail(input.email);
  const username = checkUsername(input.username);
  if (input.password.length < 8) {
    throw new ValidationError("password must be at least 8 characters");
  }
  return { email, username };
}
