import { ValidationError, validateEmail, validateUsername } from "./validate";

export interface SignupInput {
  email: string;
  username: string;
  password: string;
}

export interface Account {
  email: string;
  username: string;
}

/** Validates a new account. Returns the normalized email and username. */
export function signup(input: SignupInput): Account {
  const email = validateEmail(input.email);
  const username = validateUsername(input.username);
  if (input.password.length < 8) {
    throw new ValidationError("password must be at least 8 characters");
  }
  return { email, username };
}
